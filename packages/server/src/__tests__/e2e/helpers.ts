/**
 * E2E テストハーネス — 共通ユーティリティ
 *
 * - 実 PostgreSQL（DATABASE_URL_TEST または DATABASE_URL）
 * - PayjpClient / DiscordClient は DI インターフェースレベルのモック
 * - Discord OAuth HTTP 呼び出しは呼び出し元で vi.spyOn(globalThis, 'fetch') を使用
 */

import { createHash, randomUUID } from 'node:crypto';
import type { AuthConfig } from '@hayane/auth-service';
import type { BillingConfig, DiscordClient, PayjpClient } from '@hayane/billing-service';
import { closePool, createPgPool, createPool, PgDbClient, runMigrations, truncateAllAppData } from '@hayane/shared';
import type { CliDeps, WebhookHandlerDeps } from '@hayane/sync-service';
import type pg from 'pg';
import { vi } from 'vitest';
import type { buildApp } from '../../app.js';
import {
  buildE2EAppPlain,
  E2E_BILLING_CONFIG,
  E2E_PLAN_ROLE_MAPPING,
  E2E_WEBHOOK_TOKEN,
  makePlainDiscordClient,
  makePlainPayjpClient,
} from '../../e2e/e2e-mocks.js';
import type { SyncDeps } from '../../routes/sync.routes.js';

export {
  E2E_AUTH_CONFIG,
  E2E_BILLING_CONFIG,
  E2E_PLAN_ROLE_MAPPING,
  E2E_WEBHOOK_TOKEN,
} from '../../e2e/e2e-mocks.js';

// ---------------------------------------------------------------------------
// DB セットアップ
// ---------------------------------------------------------------------------

export const TEST_DB_URL = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;

export async function createTestDb(): Promise<{ pool: pg.Pool; pgDb: PgDbClient }> {
  if (!TEST_DB_URL) throw new Error('DATABASE_URL_TEST / DATABASE_URL が未設定です');
  const pool = createPool(TEST_DB_URL, { ssl: false });
  await runMigrations(pool);
  const pgDb = new PgDbClient(pool);
  return { pool, pgDb };
}

export async function truncateAll(pool: pg.Pool): Promise<void> {
  await truncateAllAppData(pool);
}

// ---------------------------------------------------------------------------
// Mock ファクトリ（Vitest spy でラップ — e2e-mocks の素実装を再利用）
// ---------------------------------------------------------------------------

export function makeMockPayjpClient(): PayjpClient {
  const p = makePlainPayjpClient();
  return {
    fetchToken: vi.fn().mockImplementation((tokenId: string) => p.fetchToken(tokenId)),
    createCustomer: vi.fn().mockImplementation((params) => p.createCustomer(params)),
    createCharge: vi.fn().mockImplementation((params) => p.createCharge(params)),
    createSubscription: vi.fn().mockImplementation((params) => p.createSubscription(params)),
    cancelSubscription: vi.fn().mockImplementation((id) => p.cancelSubscription(id)),
    fetchCustomer: vi.fn().mockImplementation((id) => p.fetchCustomer(id)),
    fetchCharge: vi.fn().mockImplementation((id) => p.fetchCharge(id)),
    fetchSubscription: vi.fn().mockImplementation((id) => p.fetchSubscription(id)),
  };
}

export function makeMockDiscordClient(): DiscordClient {
  const p = makePlainDiscordClient();
  return {
    checkMembership: vi.fn().mockImplementation((a, b, c) => p.checkMembership(a, b, c)),
    assignRole: vi.fn().mockImplementation((a, b, c) => p.assignRole(a, b, c)),
    removeRole: vi.fn().mockImplementation((a, b, c) => p.removeRole(a, b, c)),
    addMemberToGuild: vi.fn().mockImplementation((a, b, c, d) => p.addMemberToGuild(a, b, c, d)),
    revokeToken: vi.fn().mockImplementation((t) => p.revokeToken(t)),
  };
}

// ---------------------------------------------------------------------------
// アプリビルダー
// ---------------------------------------------------------------------------

export function buildSyncDepsForE2E(
  pool: pg.Pool,
  syncRole: (userId: string, action: 'grant' | 'revoke', roleId: string) => Promise<void> = vi
    .fn()
    .mockResolvedValue(undefined),
): SyncDeps {
  const webhookDeps: WebhookHandlerDeps = {
    db: createPgPool(pool),
    payjpWebhookToken: E2E_WEBHOOK_TOKEN,
    expectedLivemode: false,
    discordGuildId: E2E_BILLING_CONFIG.discordGuildId,
    planRoleMapping: E2E_PLAN_ROLE_MAPPING,
    syncRole,
    log: vi.fn(),
  };
  return { webhookDeps };
}

export interface E2EAppOverrides {
  payjp?: PayjpClient;
  discord?: DiscordClient;
  syncDeps?: SyncDeps;
  clock?: () => Date;
  generateOperationId?: () => string;
  billingConfig?: Partial<BillingConfig>;
  /** Merge into E2E auth config (e.g. local browser E2E origin + redirect URI). `db` is always `pgDb`. */
  authConfig?: Partial<Omit<AuthConfig, 'db'>>;
}

export function buildE2EApp(pgDb: PgDbClient, overrides: E2EAppOverrides = {}) {
  return buildE2EAppPlain(pgDb, {
    ...overrides,
    payjp: overrides.payjp ?? makeMockPayjpClient(),
    discord: overrides.discord ?? makeMockDiscordClient(),
  });
}

// ---------------------------------------------------------------------------
// セッション・フローヘルパー
// ---------------------------------------------------------------------------

/** link_session を DB に直接挿入（OAuth 完了後の状態を再現） */
export async function insertLinkedSession(
  pgDb: PgDbClient,
  discordUserId: string,
  rawToken?: string,
  expiresIn = 3600_000,
  /** Handler と同じ基準時刻に揃える（E2E の固定 clock と一致させる） */
  clock: () => Date = () => new Date(),
): Promise<{ rawToken: string; tokenHash: string }> {
  const token = rawToken ?? `e2e-link-${randomUUID()}`;
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const now = clock();
  await pgDb.insertDiscordLinkSession({
    linkSessionTokenHash: tokenHash,
    discordUserId,
    expiresAt: new Date(now.getTime() + expiresIn),
  });
  return { rawToken: token, tokenHash };
}

/** OAuth 3 ステップを実行し link_session Cookie の raw トークンを返す */
export async function completeOAuthFlow(
  app: ReturnType<typeof buildApp>,
  discordUserId: string,
  // biome-ignore lint/suspicious/noExplicitAny: vitest spyOn type is complex
): Promise<{ linkSessionToken: string; mockFetch: any }> {
  const mockFetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: 'mock_discord_token' }),
    } as Response)
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: discordUserId }),
    } as Response);

  // Step 1: start
  const startRes = await app.inject({ method: 'GET', url: '/v1/auth/discord/start' });
  const setCookie = startRes.headers['set-cookie'] as string;
  const oauthSessionToken = setCookie.match(/__Host-oauth_session=([^;]+)/)![1];
  const stateToken = new URL(startRes.headers.location as string).searchParams.get('state')!;

  // Step 2: callback
  const callbackRes = await app.inject({
    method: 'GET',
    url: `/v1/auth/discord/callback?code=mock-code&state=${stateToken}`,
    cookies: { '__Host-oauth_session': oauthSessionToken },
  });
  const linkMatch = (callbackRes.headers['set-cookie'] as string).match(/__Host-link_session=([^;]+)/)!;

  return { linkSessionToken: linkMatch[1], mockFetch };
}

/**
 * 購読完了状態の member を作成して返す（`__Host-link_session` 必須）。
 */
export async function subscribeUser(
  app: ReturnType<typeof buildApp>,
  pgDb: PgDbClient,
  discordUserId: string,
  overrides: { planId?: string } = {},
): Promise<{ memberId: string }> {
  const planId = overrides.planId ?? E2E_BILLING_CONFIG.allowedPlanIds[0];
  const email = `${discordUserId}@e2e-test.example.com`;
  const { rawToken } = await insertLinkedSession(pgDb, discordUserId);

  const res = await app.inject({
    method: 'POST',
    url: '/v1/subscriptions',
    headers: { 'content-type': 'application/json', origin: 'https://example.com' },
    cookies: { '__Host-link_session': rawToken },
    body: JSON.stringify({
      planId,
      email,
      payjpToken: 'tok_test_e2e',
      privacyConsented: true,
    }),
  });

  if (res.statusCode !== 200) {
    throw new Error(`subscribeUser failed: ${res.statusCode} ${res.body}`);
  }

  const body = res.json() as { memberId?: string };
  if (!body.memberId) {
    throw new Error('subscribeUser: response missing memberId');
  }
  const member = await pgDb.findMemberById(body.memberId);
  return { memberId: member!.id };
}

// ---------------------------------------------------------------------------
// Webhook テストフィクスチャ
// ---------------------------------------------------------------------------

const DEFAULT_EVENT_CREATED = Math.floor(new Date('2025-04-01T10:00:00Z').getTime() / 1000);

/**
 * テンプレートの `data` と上書きをマージする。
 * `overrides` でキーを明示的に `undefined` にした場合は結果から除外する（`inject` の JSON からも欠落する）。
 * 省略したキーはテンプレート値のまま残る。
 */
function mergeWebhookEventData(
  base: Record<string, unknown>,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base, ...overrides };
  for (const key of Object.keys(overrides)) {
    if (overrides[key] === undefined) {
      delete merged[key];
    }
  }
  return merged;
}

/** `data` のキーをテンプレから外したいときは `undefined` を渡す（欠損ペイロードの再現用）。 */
export function makeWebhookEvent(
  overrides: { id?: string; type?: string; livemode?: boolean; created?: number; data?: Record<string, unknown> } = {},
): Record<string, unknown> {
  const {
    id = `evnt_e2e_${randomUUID().slice(0, 8)}`,
    type = 'subscription.updated',
    livemode = false,
    created = DEFAULT_EVENT_CREATED,
    data: dataOverrides = {},
  } = overrides;

  return {
    id,
    type,
    livemode,
    created,
    data: mergeWebhookEventData(
      {
        id: 'sub_test_e2e',
        object: 'subscription',
        status: 'active',
        metadata: { discord_user_id: 'discord-e2e-user' },
        plan: { id: 'plan_e2e' },
        current_period_end: created + 30 * 86400,
      },
      dataOverrides,
    ),
  };
}

// ---------------------------------------------------------------------------
// CLI テストヘルパー
// ---------------------------------------------------------------------------

export function makeCliDeps(pool: pg.Pool, overrides: Partial<CliDeps> = {}): CliDeps {
  return {
    db: createPgPool(pool),
    planInitialChargeAmounts: {
      plan_e2e: 1000,
      plan_e2e_standard: 2000,
      plan_e2e_premium: 3000,
    },
    initialChargeCurrency: 'jpy',
    getPayjpSubscription: vi.fn().mockResolvedValue({
      id: 'sub_test_e2e',
      status: 'active',
      metadata: { discord_user_id: 'discord-e2e-user' },
      current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
    }),
    listPayjpCharges: vi.fn().mockResolvedValue({ data: [], has_more: false }),
    listPayjpSubscriptions: vi.fn().mockResolvedValue({ data: [], has_more: false }),
    createPayjpCharge: vi.fn().mockResolvedValue({ id: 'ch_cli_e2e' }),
    createPayjpSubscription: vi.fn().mockResolvedValue({ id: 'sub_cli_e2e', status: 'active' }),
    cancelPayjpSubscription: vi.fn().mockResolvedValue({ id: 'sub_cli_e2e', status: 'canceled' }),
    syncRole: vi.fn().mockResolvedValue(undefined),
    planRoleMapping: E2E_PLAN_ROLE_MAPPING,
    log: vi.fn(),
    now: () => new Date(),
    ...overrides,
  };
}

export { closePool, createPgPool, PgDbClient };
