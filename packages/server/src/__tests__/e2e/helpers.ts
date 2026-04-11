/**
 * E2E テストハーネス — 共通ユーティリティ
 *
 * - 実 PostgreSQL（DATABASE_URL_TEST または DATABASE_URL）
 * - PayjpClient / DiscordClient は DI インターフェースレベルのモック
 * - Discord OAuth HTTP 呼び出しは呼び出し元で vi.spyOn(globalThis, 'fetch') を使用
 */

import { createHash, randomUUID } from 'node:crypto';
import type { BillingConfig, BillingDeps, DiscordClient, PayjpClient } from '@hayane/billing-service';
import { closePool, createPgPool, createPool, PgDbClient, runMigrations } from '@hayane/shared';
import type { CliDeps, WebhookHandlerDeps } from '@hayane/sync-service';
import type pg from 'pg';
import { vi } from 'vitest';
import { buildApp } from '../../app.js';
import type { SyncDeps } from '../../routes/sync.routes.js';

// ---------------------------------------------------------------------------
// DB セットアップ
// ---------------------------------------------------------------------------

export const TEST_DB_URL = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;

/** TRUNCATE 順: FK 依存順（member_impact_logs は members を参照するため先に消す） */
const TRUNCATE_SQL = `
  TRUNCATE member_impact_logs, cancel_form_tokens, member_sessions, payjp_events, discord_link_sessions, oauth_states, members
  CASCADE
`;

export async function createTestDb(): Promise<{ pool: pg.Pool; pgDb: PgDbClient }> {
  if (!TEST_DB_URL) throw new Error('DATABASE_URL_TEST / DATABASE_URL が未設定です');
  const pool = createPool(TEST_DB_URL, { ssl: false });
  await runMigrations(pool);
  const pgDb = new PgDbClient(pool);
  return { pool, pgDb };
}

export async function truncateAll(pool: pg.Pool): Promise<void> {
  await pool.query(TRUNCATE_SQL);
}

// ---------------------------------------------------------------------------
// Mock ファクトリ
// ---------------------------------------------------------------------------

/** PAY.JP のトークンIDは `tok_` で始まる。不正な文字列は拒否し、本番に近い経路（422）を E2E で再現する。 */
const PAYJP_TOKEN_ID_PATTERN = /^tok_[0-9a-zA-Z_]+$/;

export function makeMockPayjpClient(): PayjpClient {
  const trialEnd = Math.floor(Date.now() / 1000) + 30 * 86400;
  return {
    fetchToken: vi.fn().mockImplementation(async (tokenId: string) => {
      if (!PAYJP_TOKEN_ID_PATTERN.test(tokenId)) {
        throw new Error('No such token');
      }
      return {
        id: 'tok_test_e2e',
        used: false,
        three_d_secure_status: 'verified',
        card: { id: 'car_test_e2e' },
      };
    }),
    createCustomer: vi.fn().mockResolvedValue({
      id: 'cus_test_e2e',
      metadata: {},
    }),
    createCharge: vi.fn().mockResolvedValue({
      id: 'ch_test_e2e',
      amount: 1000,
      paid: true,
      metadata: {},
    }),
    createSubscription: vi.fn().mockResolvedValue({
      id: 'sub_test_e2e',
      status: 'trial',
      current_period_end: trialEnd,
      trial_end: trialEnd,
      plan: { id: 'plan_e2e', interval: 'month' },
      metadata: {},
    }),
    cancelSubscription: vi.fn().mockResolvedValue({
      id: 'sub_test_e2e',
      status: 'canceled',
      current_period_end: Math.floor(Date.now() / 1000),
      trial_end: null,
      plan: { id: 'plan_e2e', interval: 'month' },
      metadata: {},
    }),
    fetchCustomer: vi.fn().mockResolvedValue({ id: 'cus_test_e2e', metadata: {} }),
    fetchCharge: vi.fn().mockResolvedValue({
      id: 'ch_test_e2e',
      amount: 1000,
      paid: true,
      metadata: {},
    }),
    fetchSubscription: vi.fn().mockResolvedValue({
      id: 'sub_test_e2e',
      status: 'trial',
      current_period_end: trialEnd,
      trial_end: trialEnd,
      plan: { id: 'plan_e2e', interval: 'month' },
      metadata: {},
    }),
  };
}

export function makeMockDiscordClient(): DiscordClient {
  return {
    checkMembership: vi.fn().mockResolvedValue({ isMember: true, canAssignRole: true }),
    assignRole: vi.fn().mockResolvedValue(undefined),
    removeRole: vi.fn().mockResolvedValue(undefined),
    addMemberToGuild: vi.fn().mockResolvedValue({ joinedNew: true }),
    revokeToken: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// アプリビルダー
// ---------------------------------------------------------------------------

export const E2E_PLAN_ROLE_MAPPING: Record<string, string> = {
  plan_e2e: 'role-e2e-test',
  plan_e2e_standard: 'role-e2e-standard',
  plan_e2e_premium: 'role-e2e-premium',
};

export const E2E_BILLING_CONFIG: BillingConfig = {
  frontendBaseUrl: 'https://example.com',
  allowedPlanIds: ['plan_e2e', 'plan_e2e_standard', 'plan_e2e_premium'],
  discordGuildId: 'guild-e2e-test',
  planRoleMapping: E2E_PLAN_ROLE_MAPPING,
  initialChargeAmount: 1000,
  initialChargeAmountCurrency: 'jpy',
  googleFormCancelBaseUrl: 'https://docs.google.com/forms/d/e/e2e-test-form/viewform',
  googleFormCancelEmailEntryId: '1111111111',
  googleFormCancelTokenEntryId: '2222222222',
  googleFormCancelSecret: 'e2e-google-secret',
  googleFormCancelTokenSecret: 'e2e-google-token-secret',
  googleFormCancelTokenTtlSeconds: 900,
};

export const E2E_WEBHOOK_TOKEN = 'whsec_e2e_test_token';

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

export const E2E_AUTH_CONFIG = {
  frontendBaseUrl: 'https://example.com',
  discordClientId: 'test-client-id',
  discordClientSecret: 'test-client-secret',
  discordRedirectUri: 'https://api.example.com/v1/auth/discord/callback',
};

export interface E2EAppOverrides {
  payjp?: PayjpClient;
  discord?: DiscordClient;
  syncDeps?: SyncDeps;
  clock?: () => Date;
  generateOperationId?: () => string;
  billingConfig?: Partial<BillingConfig>;
}

export function buildE2EApp(pgDb: PgDbClient, overrides: E2EAppOverrides = {}) {
  const config = { ...E2E_BILLING_CONFIG, ...overrides.billingConfig };
  const billingDeps: BillingDeps = {
    db: pgDb,
    payjp: overrides.payjp ?? makeMockPayjpClient(),
    discord: overrides.discord ?? makeMockDiscordClient(),
    config,
    clock: overrides.clock ?? (() => new Date()),
    generateOperationId: overrides.generateOperationId ?? (() => randomUUID()),
  };

  return buildApp({ ...E2E_AUTH_CONFIG, db: pgDb }, billingDeps, overrides.syncDeps);
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
): Promise<{ rawToken: string; tokenHash: string }> {
  const token = rawToken ?? `e2e-link-${randomUUID()}`;
  const tokenHash = createHash('sha256').update(token).digest('hex');
  await pgDb.insertDiscordLinkSession({
    linkSessionTokenHash: tokenHash,
    discordUserId,
    expiresAt: new Date(Date.now() + expiresIn),
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
 * 購読完了状態の member を作成して返す（課金先行: link_session 不要）。
 */
export async function subscribeUser(
  app: ReturnType<typeof buildApp>,
  pgDb: PgDbClient,
  discordUserId: string,
  overrides: { planId?: string } = {},
): Promise<{ memberId: string }> {
  const planId = overrides.planId ?? E2E_BILLING_CONFIG.allowedPlanIds[0];
  const email = `${discordUserId}@e2e-test.example.com`;

  const res = await app.inject({
    method: 'POST',
    url: '/v1/subscriptions',
    headers: { 'content-type': 'application/json', origin: 'https://example.com' },
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
