import './load-env.js';
import { randomUUID } from 'node:crypto';
import { REST, RequestMethod } from '@discordjs/rest';
import type { AddGuildMemberResult, BillingDeps, DiscordClient, PayjpClient } from '@hayane/billing-service';
import { closePool, createPgPool, createPool, PgDbClient, runMigrations } from '@hayane/shared';
import type { WebhookHandlerDeps } from '@hayane/sync-service';
import { runDailyResync } from '@hayane/sync-service';
import { CronJob } from 'cron';
import { buildApp } from './app.js';
import {
  buildCliDepsFromPayjpApi,
  createPayjpApi,
  parseSubscriptionPlanConfig,
  toMetadata,
} from './cli-deps-factory.js';
import type { SyncDeps } from './routes/sync.routes.js';

/** Discord permission bits (https://discord.com/developers/docs/topics/permissions) */
const PERM_ADMINISTRATOR = 1n << 3n;
const PERM_MANAGE_ROLES = 1n << 28n;

type DiscordApiRole = { id: string; position: number; permissions: string };
type DiscordApiMember = { roles: string[] };

function mergeGuildPermissions(memberRoleIds: readonly string[], allRoles: DiscordApiRole[], guildId: string): bigint {
  const byId = new Map(allRoles.map((r) => [r.id, r]));
  let perms = 0n;
  const everyone = byId.get(guildId);
  if (everyone) perms |= BigInt(everyone.permissions);
  for (const id of memberRoleIds) {
    const r = byId.get(id);
    if (r) perms |= BigInt(r.permissions);
  }
  return perms;
}

function highestRolePosition(roleIds: readonly string[], allRoles: DiscordApiRole[]): number {
  const byId = new Map(allRoles.map((r) => [r.id, r]));
  let max = -1;
  for (const id of roleIds) {
    const r = byId.get(id);
    if (r && r.position > max) max = r.position;
  }
  return max;
}

function canBotAssignRole(params: {
  allRoles: DiscordApiRole[];
  botMember: DiscordApiMember;
  guildId: string;
  roleId: string;
}): boolean {
  const { allRoles, botMember, guildId, roleId } = params;
  const targetRole = allRoles.find((r) => r.id === roleId);
  if (!targetRole) return false;

  const perms = mergeGuildPermissions(botMember.roles, allRoles, guildId);
  if ((perms & PERM_ADMINISTRATOR) === PERM_ADMINISTRATOR) return true;
  if ((perms & PERM_MANAGE_ROLES) !== PERM_MANAGE_ROLES) return false;

  const botTop = highestRolePosition(botMember.roles, allRoles);
  return botTop > targetRole.position;
}

// ---- 1. Env validation ----

const REQUIRED_ENV = [
  'DATABASE_URL',
  'DISCORD_CLIENT_ID',
  'DISCORD_CLIENT_SECRET',
  'DISCORD_REDIRECT_URI',
  'DISCORD_BOT_TOKEN',
  'DISCORD_GUILD_ID',
  // DISCORD_PLAN_ROLE_IDS: comma-separated role IDs, same order as PAYJP_PLAN_IDS
  'DISCORD_PLAN_ROLE_IDS',
  'PAYJP_SECRET_KEY',
  'PAYJP_LIVEMODE',
  'PAYJP_PLAN_IDS',
  'FRONTEND_BASE_URL',
  'GOOGLE_FORM_CANCEL_BASE_URL',
  'GOOGLE_FORM_CANCEL_EMAIL_ENTRY_ID',
  'GOOGLE_FORM_CANCEL_TOKEN_ENTRY_ID',
  'GOOGLE_FORM_CANCEL_SECRET',
  'GOOGLE_FORM_CANCEL_TOKEN_SECRET',
  'GOOGLE_FORM_CANCEL_TOKEN_TTL_SECONDS',
  'PAYJP_WEBHOOK_TOKEN',
  'PAYJP_PLAN_INITIAL_CHARGE_AMOUNTS',
  'DAILY_RESYNC_CRON',
] as const;

type RequiredEnvKey = (typeof REQUIRED_ENV)[number];

const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length > 0) {
  process.stderr.write(`[startup] Missing required environment variables: ${missing.join(', ')}\n`);
  process.exit(1);
}

const env = Object.fromEntries(REQUIRED_ENV.map((k) => [k, process.env[k] as string])) as Record<
  RequiredEnvKey,
  string
>;
const discordTokenEncryptionKey = process.env.DISCORD_TOKEN_ENCRYPTION_KEY;

// Validate FRONTEND_BASE_URL is a valid origin (scheme://host[:port], no path/query)
try {
  const u = new URL(env.FRONTEND_BASE_URL);
  if (u.origin !== env.FRONTEND_BASE_URL) {
    process.stderr.write(
      `[startup] FRONTEND_BASE_URL must be a bare origin (e.g. https://example.com), got: ${env.FRONTEND_BASE_URL}\n`,
    );
    process.exit(1);
  }
} catch {
  process.stderr.write(`[startup] FRONTEND_BASE_URL is not a valid URL: ${env.FRONTEND_BASE_URL}\n`);
  process.exit(1);
}

if (env.PAYJP_LIVEMODE !== 'true' && env.PAYJP_LIVEMODE !== 'false') {
  process.stderr.write(`[startup] PAYJP_LIVEMODE must be "true" or "false", got: "${env.PAYJP_LIVEMODE}"\n`);
  process.exit(1);
}

const googleFormCancelTokenTtlSeconds = Number(env.GOOGLE_FORM_CANCEL_TOKEN_TTL_SECONDS);
if (!Number.isInteger(googleFormCancelTokenTtlSeconds) || googleFormCancelTokenTtlSeconds <= 0) {
  process.stderr.write(
    `[startup] GOOGLE_FORM_CANCEL_TOKEN_TTL_SECONDS must be a positive integer, got: "${env.GOOGLE_FORM_CANCEL_TOKEN_TTL_SECONDS}"\n`,
  );
  process.exit(1);
}

// Fail-fast on weak / placeholder secrets — prevents accidentally shipping `.env.example` defaults.
const REJECTED_SECRET_DEFAULTS: ReadonlySet<string> = new Set([
  'dev-google-shared-secret-change-me',
  'dev-google-token-secret-change-me',
  'changeme',
]);
const SECRETS_MIN_BYTES: ReadonlyArray<[RequiredEnvKey, number]> = [
  ['GOOGLE_FORM_CANCEL_SECRET', 32],
  ['GOOGLE_FORM_CANCEL_TOKEN_SECRET', 32],
  ['PAYJP_WEBHOOK_TOKEN', 16],
];
for (const [name, minBytes] of SECRETS_MIN_BYTES) {
  const value = env[name];
  if (REJECTED_SECRET_DEFAULTS.has(value)) {
    process.stderr.write(`[startup] ${name} must not equal a .env.example placeholder value\n`);
    process.exit(1);
  }
  if (Buffer.byteLength(value, 'utf8') < minBytes) {
    process.stderr.write(
      `[startup] ${name} must be at least ${minBytes} bytes (got ${Buffer.byteLength(value, 'utf8')})\n`,
    );
    process.exit(1);
  }
}

const port = Number(process.env.PORT ?? '3000');
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  process.stderr.write(`[startup] Invalid PORT: ${process.env.PORT}\n`);
  process.exit(1);
}

// ---- 2. DB setup ----

// Respect ?sslmode=disable in the DATABASE_URL (e.g. Docker Compose local setup).
// pool.ts auto-enables ssl:true for non-localhost hosts; this overrides that for dev.
const sslDisabled = env.DATABASE_URL.includes('sslmode=disable');
const pool = createPool(env.DATABASE_URL, sslDisabled ? { ssl: false } : undefined);

async function closePoolIgnoringStartupErrors(): Promise<void> {
  try {
    await closePool(pool);
  } catch {
    // ignore cleanup error during startup failure
  }
}

try {
  await runMigrations(pool);
} catch (err) {
  process.stderr.write(`[startup] DB migration failed: ${err instanceof Error ? err.message : String(err)}\n`);
  await closePoolIgnoringStartupErrors();
  process.exit(1);
}
console.log('[startup] DB migrations applied.');

const dbClient = new PgDbClient(pool);
const dbPool = createPgPool(pool);
const planParse = parseSubscriptionPlanConfig(env, 'startup');
if (!planParse.ok) {
  process.stderr.write(planParse.message);
  await closePoolIgnoringStartupErrors();
  process.exit(1);
}
const { allowedPlanIds, planRoleMapping, planInitialChargeAmounts } = planParse;

// ---- 3. Create clients ----

// PAY.JP client (payjp uses export= pattern; cast required for ESM interop)
const payjpApi = createPayjpApi(env.PAYJP_SECRET_KEY);

function toSubscription(s: Record<string, unknown>) {
  const plan = s.plan as Record<string, unknown>;
  return {
    id: s.id as string,
    status: s.status as string,
    current_period_end: s.current_period_end as number,
    trial_end: (s.trial_end as number | null) ?? null,
    plan: { id: plan.id as string, interval: plan.interval as string },
    metadata: toMetadata(s.metadata),
  };
}

const payjpClient: PayjpClient = {
  async fetchToken(tokenId) {
    const t = (await payjpApi.tokens.retrieve(tokenId)) as Record<string, unknown>;
    const card = t.card as Record<string, unknown>;
    return {
      id: t.id as string,
      used: t.used as boolean,
      // three_d_secure_status lives on the card in payjp v3 types
      three_d_secure_status: (card.three_d_secure_status as string | null) ?? null,
      card: { id: card.id as string },
    };
  },
  async createCustomer(params) {
    const c = (await payjpApi.customers.create(params)) as Record<string, unknown>;
    return { id: c.id as string, metadata: toMetadata(c.metadata) };
  },
  async createCharge(params) {
    const ch = (await payjpApi.charges.create(params)) as Record<string, unknown>;
    return {
      id: ch.id as string,
      amount: ch.amount as number,
      paid: ch.paid as boolean,
      metadata: toMetadata(ch.metadata),
    };
  },
  async createSubscription(params) {
    return toSubscription((await payjpApi.subscriptions.create(params)) as Record<string, unknown>);
  },
  async cancelSubscription(subscriptionId) {
    return toSubscription((await payjpApi.subscriptions.cancel(subscriptionId)) as Record<string, unknown>);
  },
  async fetchCustomer(customerId) {
    const c = (await payjpApi.customers.retrieve(customerId)) as Record<string, unknown>;
    return { id: c.id as string, metadata: toMetadata(c.metadata) };
  },
  async fetchCharge(chargeId) {
    const ch = (await payjpApi.charges.retrieve(chargeId)) as Record<string, unknown>;
    return {
      id: ch.id as string,
      amount: ch.amount as number,
      paid: ch.paid as boolean,
      metadata: toMetadata(ch.metadata),
    };
  },
  async fetchSubscription(subscriptionId) {
    return toSubscription((await payjpApi.subscriptions.retrieve(subscriptionId)) as Record<string, unknown>);
  },
};

// Discord REST client
const discordRest = new REST({ version: '10' }).setToken(env.DISCORD_BOT_TOKEN);

let discordBotUserId: string;
try {
  const me = (await discordRest.get('/users/@me')) as { id: string };
  discordBotUserId = me.id;
} catch (err) {
  process.stderr.write(
    `[startup] Failed to resolve Discord bot identity: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  await closePoolIgnoringStartupErrors();
  process.exit(1);
}

const discordClient: DiscordClient = {
  async checkMembership(guildId, discordUserId, roleId?: string) {
    try {
      await discordRest.get(`/guilds/${guildId}/members/${discordUserId}`);
    } catch (err: unknown) {
      const status = (err as Record<string, unknown>)?.status;
      if (status === 404) {
        return { isMember: false, canAssignRole: false };
      }
      throw err;
    }

    let rolesRaw: DiscordApiRole[];
    let botMemberRaw: DiscordApiMember;
    try {
      [rolesRaw, botMemberRaw] = await Promise.all([
        discordRest.get(`/guilds/${guildId}/roles`) as Promise<DiscordApiRole[]>,
        discordRest.get(`/guilds/${guildId}/members/${discordBotUserId}`) as Promise<DiscordApiMember>,
      ]);
    } catch (err: unknown) {
      const status = (err as Record<string, unknown>)?.status;
      if (status === 404) {
        return { isMember: true, canAssignRole: false };
      }
      throw err;
    }

    const canAssign = roleId
      ? canBotAssignRole({ allRoles: rolesRaw, botMember: botMemberRaw, guildId, roleId })
      : Object.values(planRoleMapping).some((rid) =>
          canBotAssignRole({ allRoles: rolesRaw, botMember: botMemberRaw, guildId, roleId: rid }),
        );
    return { isMember: true, canAssignRole: canAssign };
  },
  async assignRole(guildId, discordUserId, roleId) {
    await discordRest.put(`/guilds/${guildId}/members/${discordUserId}/roles/${roleId}`);
  },
  async removeRole(guildId, discordUserId, roleId) {
    await discordRest.delete(`/guilds/${guildId}/members/${discordUserId}/roles/${roleId}`);
  },
  async addMemberToGuild(guildId, discordUserId, accessToken, roleId): Promise<AddGuildMemberResult> {
    const body: Record<string, unknown> = { access_token: accessToken };
    if (roleId) body.roles = [roleId];
    const res = await discordRest.queueRequest({
      fullRoute: `/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(discordUserId)}`,
      method: RequestMethod.Put,
      body,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Discord addGuildMember failed: HTTP ${res.status}${detail ? ` ${detail}` : ''}`);
    }
    // Drain 201 JSON body so the connection can be reused; 204 has no body.
    if (res.status === 201) {
      await res.json().catch(() => undefined);
    }
    // 201 = newly added (roles from body applied); 204 = already in guild (roles not applied)
    return { joinedNew: res.status === 201 };
  },
  async revokeToken(accessToken) {
    const params = new URLSearchParams({
      token: accessToken,
      token_type_hint: 'access_token',
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
    });
    const res = await fetch('https://discord.com/api/oauth2/token/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Discord token revoke failed: HTTP ${res.status}${detail ? ` ${detail}` : ''}`);
    }
  },
};

const cliDeps = buildCliDepsFromPayjpApi({
  db: dbPool,
  payjpApi,
  discordRest,
  discordGuildId: env.DISCORD_GUILD_ID,
  planRoleMapping,
  planInitialChargeAmounts,
});
const { syncRole } = cliDeps;

// ---- 4. Wire dependencies ----

const subscribeGateCodeRaw = process.env.SUBSCRIBE_GATE_CODE?.trim();
const subscribeGateCode = subscribeGateCodeRaw && subscribeGateCodeRaw.length > 0 ? subscribeGateCodeRaw : undefined;
const accessGateSessionTtlSeconds = Number(process.env.ACCESS_GATE_SESSION_TTL_SECONDS ?? '86400');
if (!Number.isInteger(accessGateSessionTtlSeconds) || accessGateSessionTtlSeconds <= 0) {
  process.stderr.write(`[startup] ACCESS_GATE_SESSION_TTL_SECONDS must be a positive integer\n`);
  await closePoolIgnoringStartupErrors();
  process.exit(1);
}

const billingDeps: BillingDeps = {
  db: dbClient,
  payjp: payjpClient,
  discord: discordClient,
  config: {
    frontendBaseUrl: env.FRONTEND_BASE_URL,
    allowedPlanIds,
    discordGuildId: env.DISCORD_GUILD_ID,
    planRoleMapping,
    planInitialChargeAmounts,
    initialChargeAmount: 1000,
    initialChargeAmountCurrency: 'jpy',
    discordTokenEncryptionKey,
    googleFormCancelBaseUrl: env.GOOGLE_FORM_CANCEL_BASE_URL,
    googleFormCancelEmailEntryId: env.GOOGLE_FORM_CANCEL_EMAIL_ENTRY_ID,
    googleFormCancelTokenEntryId: env.GOOGLE_FORM_CANCEL_TOKEN_ENTRY_ID,
    googleFormCancelSecret: env.GOOGLE_FORM_CANCEL_SECRET,
    googleFormCancelTokenSecret: env.GOOGLE_FORM_CANCEL_TOKEN_SECRET,
    googleFormCancelTokenTtlSeconds,
    subscribeGateCode,
    accessGateSessionTtlSeconds,
  },
  clock: () => new Date(),
  generateOperationId: () => randomUUID(),
};

const webhookDeps: WebhookHandlerDeps = {
  db: dbPool,
  payjpWebhookToken: env.PAYJP_WEBHOOK_TOKEN,
  expectedLivemode: env.PAYJP_LIVEMODE === 'true',
  discordGuildId: env.DISCORD_GUILD_ID,
  planRoleMapping,
  syncRole,
  log: (entry) => console.log(JSON.stringify(entry)),
};

const syncDeps: SyncDeps = { webhookDeps };

// ---- 5. Build and start server ----

const app = buildApp(
  {
    frontendBaseUrl: env.FRONTEND_BASE_URL,
    discordClientId: env.DISCORD_CLIENT_ID,
    discordClientSecret: env.DISCORD_CLIENT_SECRET,
    discordRedirectUri: env.DISCORD_REDIRECT_URI,
    discordTokenEncryptionKey,
    db: dbClient,
  },
  billingDeps,
  syncDeps,
);

let dailyResyncCron: CronJob | null = null;
try {
  dailyResyncCron = new CronJob(
    env.DAILY_RESYNC_CRON,
    () => {
      void runDailyResync({
        cliDeps,
        log: (entry) => console.log(JSON.stringify(entry)),
      }).catch((err) => {
        console.error(`[daily-resync] ${err instanceof Error ? err.message : String(err)}`);
      });
    },
    null,
    false,
  );
} catch (err) {
  process.stderr.write(
    `[startup] Invalid DAILY_RESYNC_CRON "${env.DAILY_RESYNC_CRON}": ${err instanceof Error ? err.message : String(err)}\n`,
  );
  await closePoolIgnoringStartupErrors();
  process.exit(1);
}

try {
  await app.listen({ port, host: '0.0.0.0' });
  console.log(`[startup] Server listening on port ${port}`);
  dailyResyncCron?.start();
  console.log(`[startup] Daily resync cron scheduled: ${env.DAILY_RESYNC_CRON}`);
} catch (err) {
  console.error('[startup] Failed to start server:', err);
  await closePoolIgnoringStartupErrors();
  process.exit(1);
}

// Graceful shutdown — always close the DB pool; surface partial failures via exit code
async function shutdownGracefully(): Promise<void> {
  let exitCode = 0;
  try {
    dailyResyncCron?.stop();
  } catch (err) {
    console.error('[shutdown] Error stopping daily resync cron:', err);
    exitCode = 1;
  }
  try {
    await app.close();
  } catch (err) {
    console.error('[shutdown] Error closing HTTP server:', err);
    exitCode = 1;
  }
  try {
    await closePool(pool);
  } catch (err) {
    console.error('[shutdown] Error closing database pool:', err);
    exitCode = 1;
  }
  process.exit(exitCode);
}

let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] Received ${signal}, shutting down...`);
    void shutdownGracefully().catch((err) => {
      console.error('[shutdown] Unexpected shutdown failure:', err);
      process.exit(1);
    });
  });
}
