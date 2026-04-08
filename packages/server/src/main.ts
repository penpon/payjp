import { randomUUID } from 'node:crypto';
import { REST } from '@discordjs/rest';
import type { BillingDeps, DiscordClient, PayjpClient } from '@hayane/billing-service';
import { closePool, createPgPool, createPool, PgDbClient, runMigrations } from '@hayane/shared';
import type { WebhookHandlerDeps } from '@hayane/sync-service';
import Payjp from 'payjp';
import { buildApp } from './app.js';
import type { SyncDeps } from './routes/sync.routes.js';

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
  'PAYJP_WEBHOOK_TOKEN',
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

const port = Number(process.env.PORT ?? '3000');
if (!Number.isFinite(port) || port < 1 || port > 65535) {
  process.stderr.write(`[startup] Invalid PORT: ${process.env.PORT}\n`);
  process.exit(1);
}

// ---- 2. DB setup ----

const pool = createPool(env.DATABASE_URL);

try {
  await runMigrations(pool);
} catch (err) {
  process.stderr.write(`[startup] DB migration failed: ${err instanceof Error ? err.message : String(err)}\n`);
  await closePool(pool);
  process.exit(1);
}
console.log('[startup] DB migrations applied.');

// ---- 3. Create clients ----

// PAY.JP client (payjp uses export= pattern; cast required for ESM interop)
// biome-ignore lint/suspicious/noExplicitAny: payjp uses export= CJS pattern incompatible with ESM typed import
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

const discordClient: DiscordClient = {
  async checkMembership(guildId, discordUserId) {
    try {
      await discordRest.get(`/guilds/${guildId}/members/${discordUserId}`);
      return { isMember: true, canAssignRole: true };
    } catch (err: unknown) {
      const status = (err as Record<string, unknown>)?.status;
      if (status === 404) {
        return { isMember: false, canAssignRole: false };
      }
      throw err;
    }
  },
  async assignRole(guildId, discordUserId, roleId) {
    await discordRest.put(`/guilds/${guildId}/members/${discordUserId}/roles/${roleId}`);
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
  payjpWebhookToken: env.PAYJP_WEBHOOK_TOKEN,
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
  },
  billingDeps,
  syncDeps,
);

try {
  await app.listen({ port, host: '0.0.0.0' });
  console.log(`[startup] Server listening on port ${port}`);
} catch (err) {
  console.error('[startup] Failed to start server:', err);
  await closePool(pool);
  process.exit(1);
}

// Graceful shutdown
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void (async () => {
      console.log(`[shutdown] Received ${signal}, shutting down...`);
      await app.close();
      await closePool(pool);
      process.exit(0);
    })();
  });
}
