/**
 * Manual resync CLI — same PAY.JP / DB / Discord wiring as `main.ts`.
 * Usage: `tsx packages/server/src/resync-cli.ts --all | --operation-id <id> | --discord-user-id <id>`
 *
 * Required env: DATABASE_URL, PAYJP_SECRET_KEY, PAYJP_LIVEMODE, PAYJP_PLAN_IDS, DISCORD_PLAN_ROLE_IDS,
 * DISCORD_GUILD_ID, DISCORD_BOT_TOKEN, PAYJP_PLAN_INITIAL_CHARGE_AMOUNTS
 */
import { createPgPool, createPool, runMigrations } from '@hayane/shared';
import type { CliDeps } from '@hayane/sync-service';
import { runResyncCli } from '@hayane/sync-service';
import Payjp from 'payjp';

const REQUIRED = [
  'DATABASE_URL',
  'PAYJP_SECRET_KEY',
  'PAYJP_LIVEMODE',
  'PAYJP_PLAN_IDS',
  'DISCORD_PLAN_ROLE_IDS',
  'DISCORD_GUILD_ID',
  'DISCORD_BOT_TOKEN',
  'PAYJP_PLAN_INITIAL_CHARGE_AMOUNTS',
] as const;

function toMetadata(raw: unknown): Record<string, string> {
  if (raw === null || raw === undefined || typeof raw !== 'object') return {};
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, String(v)]));
}

async function main(): Promise<void> {
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    process.stderr.write(`[resync-cli] Missing: ${missing.join(', ')}\n`);
    process.exit(1);
  }

  const env = process.env as Record<string, string>;
  const sslDisabled = env.DATABASE_URL.includes('sslmode=disable');
  const pool = createPool(env.DATABASE_URL, sslDisabled ? { ssl: false } : undefined);
  await runMigrations(pool);
  const dbPool = createPgPool(pool);

  const payjpApi = (
    Payjp as unknown as (key: string) => Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>
  )(env.PAYJP_SECRET_KEY);

  const allowedPlanIds = env.PAYJP_PLAN_IDS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const discordPlanRoleIds = env.DISCORD_PLAN_ROLE_IDS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const planRoleMapping: Record<string, string> = Object.fromEntries(
    allowedPlanIds.map((pid, i) => [pid, discordPlanRoleIds[i] as string]),
  );
  const planParts = env.PAYJP_PLAN_INITIAL_CHARGE_AMOUNTS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (planParts.length !== allowedPlanIds.length) {
    process.stderr.write('[resync-cli] PAYJP_PLAN_INITIAL_CHARGE_AMOUNTS length must match PAYJP_PLAN_IDS\n');
    process.exit(1);
  }
  const planInitialChargeAmounts: Record<string, number> = Object.fromEntries(
    allowedPlanIds.map((pid, i) => [pid, Number.parseInt(planParts[i] as string, 10)]),
  );

  const { REST } = await import('@discordjs/rest');
  const discordRest = new REST({ version: '10' }).setToken(env.DISCORD_BOT_TOKEN);

  async function syncRole(userId: string, action: 'grant' | 'revoke', roleId: string): Promise<void> {
    const endpoint = `/guilds/${env.DISCORD_GUILD_ID}/members/${userId}/roles/${roleId}` as const;
    if (action === 'grant') {
      await discordRest.put(endpoint);
    } else {
      await discordRest.delete(endpoint);
    }
  }

  const listPayjpCharges: CliDeps['listPayjpCharges'] = async (params, offset) => {
    const r = (await payjpApi.charges.list({
      customer: params.customer,
      since: params.since,
      until: params.until,
      limit: params.limit,
      offset,
    })) as { data: Array<Record<string, unknown>>; has_more: boolean };
    return {
      data: r.data.map((ch) => ({
        id: ch.id as string,
        metadata: toMetadata(ch.metadata),
      })),
      has_more: r.has_more,
    };
  };

  const listPayjpSubscriptions: CliDeps['listPayjpSubscriptions'] = async (customerId, offset) => {
    const r = (await payjpApi.subscriptions.list({
      customer: customerId,
      limit: 100,
      offset,
    })) as { data: Array<Record<string, unknown>>; has_more: boolean };
    return {
      data: r.data.map((s) => ({
        id: s.id as string,
        status: s.status as string,
        metadata: toMetadata(s.metadata),
        current_period_end: s.current_period_end as number | undefined,
      })),
      has_more: r.has_more,
    };
  };

  const cliDeps: CliDeps = {
    db: dbPool,
    getPayjpSubscription: async (id) => {
      try {
        return (await payjpApi.subscriptions.retrieve(id)) as Record<string, unknown>;
      } catch {
        return null;
      }
    },
    listPayjpCharges,
    listPayjpSubscriptions,
    createPayjpCharge: async (params) => {
      const ch = (await payjpApi.charges.create(params)) as Record<string, unknown>;
      return { id: ch.id as string };
    },
    createPayjpSubscription: async (params) => {
      const s = (await payjpApi.subscriptions.create(params)) as Record<string, unknown>;
      return { id: s.id as string, status: s.status as string };
    },
    cancelPayjpSubscription: async (subscriptionId) =>
      (await payjpApi.subscriptions.cancel(subscriptionId)) as Record<string, unknown>,
    syncRole,
    planRoleMapping,
    planInitialChargeAmounts,
    initialChargeCurrency: 'jpy',
    log: (entry) => console.log(JSON.stringify(entry)),
    now: () => new Date(),
  };

  const out = await runResyncCli(process.argv.slice(2), cliDeps);
  console.log(JSON.stringify(out.result, null, 2));
  process.exit(out.exitCode);
}

void main().catch((err) => {
  console.error('[resync-cli]', err);
  process.exit(1);
});
