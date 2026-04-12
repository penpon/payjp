/**
 * Manual resync CLI — same PAY.JP / DB / Discord wiring as `main.ts`.
 * Usage: `tsx packages/server/src/resync-cli.ts --all | --operation-id <id> | --discord-user-id <id>`
 *
 * Required env: DATABASE_URL, PAYJP_SECRET_KEY, PAYJP_LIVEMODE, PAYJP_PLAN_IDS, DISCORD_PLAN_ROLE_IDS,
 * DISCORD_GUILD_ID, DISCORD_BOT_TOKEN, PAYJP_PLAN_INITIAL_CHARGE_AMOUNTS
 */
import './load-env.js';
import { REST } from '@discordjs/rest';
import { createPgPool, createPool, runMigrations } from '@hayane/shared';
import { runResyncCli } from '@hayane/sync-service';
import { buildCliDepsFromPayjpApi, createPayjpApi, parseSubscriptionPlanConfig } from './cli-deps-factory.js';

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

  const planParse = parseSubscriptionPlanConfig(
    {
      PAYJP_PLAN_IDS: env.PAYJP_PLAN_IDS,
      DISCORD_PLAN_ROLE_IDS: env.DISCORD_PLAN_ROLE_IDS,
      PAYJP_PLAN_INITIAL_CHARGE_AMOUNTS: env.PAYJP_PLAN_INITIAL_CHARGE_AMOUNTS,
    },
    'resync-cli',
  );
  if (!planParse.ok) {
    process.stderr.write(planParse.message);
    process.exit(1);
  }
  const { planRoleMapping, planInitialChargeAmounts } = planParse;

  const payjpApi = createPayjpApi(env.PAYJP_SECRET_KEY);
  const discordRest = new REST({ version: '10' }).setToken(env.DISCORD_BOT_TOKEN);

  const cliDeps = buildCliDepsFromPayjpApi({
    db: dbPool,
    payjpApi,
    discordRest,
    discordGuildId: env.DISCORD_GUILD_ID,
    planRoleMapping,
    planInitialChargeAmounts,
  });

  const out = await runResyncCli(process.argv.slice(2), cliDeps);
  console.log(JSON.stringify(out.result, null, 2));
  process.exit(out.exitCode);
}

void main().catch((err) => {
  console.error('[resync-cli]', err);
  process.exit(1);
});
