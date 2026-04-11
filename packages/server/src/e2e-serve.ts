/**
 * Local browser E2E 用 API サーバー — Vitest `buildE2EApp` と同じモック依存（PAY.JP / Discord REST）。
 * Discord OAuth の token / user 取得のみ `fetch` を差し替え（実 Discord へは出さない）。
 *
 * 必須環境変数: `DATABASE_URL` または `DATABASE_URL_TEST`
 * 任意: `E2E_FRONTEND_BASE_URL` (default `http://127.0.0.1:5173`)
 * 任意: `E2E_API_PORT` (default `3999`)
 */

import { closePool, createPool, PgDbClient, runMigrations } from '@hayane/shared';
import type { FastifyInstance } from 'fastify';
import { buildE2EAppPlain, buildSyncDepsForE2EPlain } from './e2e/e2e-mocks.js';

const TEST_DB_URL = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;

const E2E_FRONTEND_BASE_URL = process.env.E2E_FRONTEND_BASE_URL ?? 'http://localhost:5173';
const E2E_API_PORT = Number(process.env.E2E_API_PORT ?? '3999');

/** Frontend `main.ts` の plan id と一致させる */
const E2E_BROWSER_PLAN_IDS = ['plan_starter', 'plan_business', 'plan_enterprise'] as const;
const E2E_BROWSER_PLAN_ROLES: Record<string, string> = {
  plan_starter: 'role-e2e-starter',
  plan_business: 'role-e2e-business',
  plan_enterprise: 'role-e2e-enterprise',
};

function installDiscordFetchMock(): void {
  const orig = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : typeof input === 'object' && input !== null && 'url' in input
            ? (input as Request).url
            : String(input);

    if (url.includes('discord.com/api/oauth2/token/revoke')) {
      return new Response('', { status: 204 });
    }
    if (url.includes('discord.com/api/oauth2/token')) {
      return new Response(JSON.stringify({ access_token: 'e2e_mock_access_token', token_type: 'Bearer' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('discord.com/api/users/@me') && !url.includes('/guilds/')) {
      return new Response(JSON.stringify({ id: '111222333444555001', username: 'e2e_user' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return orig(input as Request, init);
  };
}

let app: FastifyInstance | null = null;

async function main(): Promise<void> {
  if (!TEST_DB_URL) {
    process.stderr.write('[e2e-serve] DATABASE_URL_TEST or DATABASE_URL is required\n');
    process.exit(1);
  }

  installDiscordFetchMock();

  const pool = createPool(TEST_DB_URL, { ssl: false });
  await runMigrations(pool);
  const pgDb = new PgDbClient(pool);

  app = buildE2EAppPlain(pgDb, {
    authConfig: {
      frontendBaseUrl: E2E_FRONTEND_BASE_URL,
      discordRedirectUri: `${E2E_FRONTEND_BASE_URL}/v1/auth/discord/callback`,
    },
    billingConfig: {
      frontendBaseUrl: E2E_FRONTEND_BASE_URL,
      allowedPlanIds: [...E2E_BROWSER_PLAN_IDS],
      planRoleMapping: E2E_BROWSER_PLAN_ROLES,
    },
    syncDeps: buildSyncDepsForE2EPlain(pool),
  });

  await app.listen({ port: E2E_API_PORT, host: '0.0.0.0' });
  process.stdout.write(`[e2e-serve] listening on ${E2E_API_PORT} (frontend origin ${E2E_FRONTEND_BASE_URL})\n`);

  const shutdown = async (): Promise<void> => {
    try {
      await app?.close();
    } catch {
      // ignore
    }
    try {
      await closePool(pool);
    } catch {
      // ignore
    }
    process.exit(0);
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void shutdown();
    });
  }
}

void main().catch((err) => {
  console.error('[e2e-serve] failed:', err);
  process.exit(1);
});
