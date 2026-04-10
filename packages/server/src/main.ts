import { randomUUID } from 'node:crypto';
import { REST } from '@discordjs/rest';
import type { BillingDeps, DiscordClient, PayjpClient } from '@hayane/billing-service';
import { closePool, createPgPool, createPool, PgDbClient, runMigrations } from '@hayane/shared';
import type { WebhookHandlerDeps } from '@hayane/sync-service';
import Payjp from 'payjp';
import { buildApp } from './app.js';
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
  paidRoleId: string;
}): boolean {
  const { allRoles, botMember, guildId, paidRoleId } = params;
  const paidRole = allRoles.find((r) => r.id === paidRoleId);
  if (!paidRole) return false;

  const perms = mergeGuildPermissions(botMember.roles, allRoles, guildId);
  if ((perms & PERM_ADMINISTRATOR) === PERM_ADMINISTRATOR) return true;
  if ((perms & PERM_MANAGE_ROLES) !== PERM_MANAGE_ROLES) return false;

  const botTop = highestRolePosition(botMember.roles, allRoles);
  return botTop > paidRole.position;
}

// ---- 1. Env validation ----

const REQUIRED_ENV = [
  'DATABASE_URL',
  'DISCORD_CLIENT_ID',
  'DISCORD_CLIENT_SECRET',
  'DISCORD_REDIRECT_URI',
  'DISCORD_BOT_TOKEN',
  'DISCORD_GUILD_ID',
  'DISCORD_PAID_ROLE_ID',
  'PAYJP_SECRET_KEY',
  'PAYJP_LIVEMODE',
  'PAYJP_PLAN_IDS',
  'FRONTEND_BASE_URL',
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

// ---- 3. Create clients ----

// PAY.JP client (payjp uses export= pattern; cast required for ESM interop)
const payjpApi = (
  Payjp as unknown as (key: string) => Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>
)(env.PAYJP_SECRET_KEY);

function toMetadata(raw: unknown): Record<string, string> {
  if (raw === null || raw === undefined || typeof raw !== 'object') return {};
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, String(v)]));
}

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
  async checkMembership(guildId, discordUserId) {
    try {
      await discordRest.get(`/guilds/${guildId}/members/${discordUserId}`);
    } catch (err: unknown) {
      const status = (err as Record<string, unknown>)?.status;
      if (status === 404) {
        return { isMember: false, canAssignRole: false };
      }
      throw err;
    }

    const paidRoleId = env.DISCORD_PAID_ROLE_ID;
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

    const canAssignRole = canBotAssignRole({
      allRoles: rolesRaw,
      botMember: botMemberRaw,
      guildId,
      paidRoleId,
    });
    return { isMember: true, canAssignRole };
  },
  async assignRole(guildId, discordUserId, roleId) {
    await discordRest.put(`/guilds/${guildId}/members/${discordUserId}/roles/${roleId}`);
  },
  async addMemberToGuild(guildId, discordUserId, accessToken, roleId) {
    const body: Record<string, unknown> = { access_token: accessToken };
    if (roleId) body.roles = [roleId];
    await discordRest.put(`/guilds/${guildId}/members/${discordUserId}`, { body });
  },
  async revokeToken(accessToken) {
    const params = new URLSearchParams({
      token: accessToken,
      token_type_hint: 'access_token',
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
    });
    await fetch('https://discord.com/api/oauth2/token/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
  },
};

const syncRole = async (userId: string, action: 'grant' | 'revoke'): Promise<void> => {
  if (action === 'grant') {
    await discordRest.put(`/guilds/${env.DISCORD_GUILD_ID}/members/${userId}/roles/${env.DISCORD_PAID_ROLE_ID}`);
  } else {
    await discordRest.delete(`/guilds/${env.DISCORD_GUILD_ID}/members/${userId}/roles/${env.DISCORD_PAID_ROLE_ID}`);
  }
};

// ---- 4. Wire dependencies ----

const dbClient = new PgDbClient(pool);
const dbPool = createPgPool(pool);
const allowedPlanIds = env.PAYJP_PLAN_IDS.split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (allowedPlanIds.length === 0) {
  process.stderr.write('[startup] PAYJP_PLAN_IDS must contain at least one plan ID\n');
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
    discordPaidRoleId: env.DISCORD_PAID_ROLE_ID,
    initialChargeAmount: 1000,
    initialChargeAmountCurrency: 'jpy',
  },
  clock: () => new Date(),
  generateOperationId: () => randomUUID(),
};

const webhookDeps: WebhookHandlerDeps = {
  db: dbPool,
  payjpWebhookToken: process.env.PAYJP_WEBHOOK_TOKEN ?? '',
  expectedLivemode: env.PAYJP_LIVEMODE === 'true',
  discordGuildId: env.DISCORD_GUILD_ID,
  discordRoleId: env.DISCORD_PAID_ROLE_ID,
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
    db: dbClient,
  },
  billingDeps,
  syncDeps,
);

try {
  await app.listen({ port, host: '0.0.0.0' });
  console.log(`[startup] Server listening on port ${port}`);
} catch (err) {
  console.error('[startup] Failed to start server:', err);
  await closePoolIgnoringStartupErrors();
  process.exit(1);
}

// Graceful shutdown — always close the DB pool; surface partial failures via exit code
async function shutdownGracefully(): Promise<void> {
  let exitCode = 0;
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
