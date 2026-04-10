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
  TRUNCATE member_impact_logs, payjp_events, discord_link_sessions, oauth_states, members
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

export function makeMockPayjpClient(): PayjpClient {
  const trialEnd = Math.floor(Date.now() / 1000) + 30 * 86400;
  return {
    fetchToken: vi.fn().mockResolvedValue({
      id: 'tok_test_e2e',
      used: false,
      three_d_secure_status: 'verified',
      card: { id: 'car_test_e2e' },
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
  };
}

// ---------------------------------------------------------------------------
// アプリビルダー
// ---------------------------------------------------------------------------

export const E2E_BILLING_CONFIG: BillingConfig = {
  frontendBaseUrl: 'https://example.com',
  allowedPlanIds: ['plan_e2e', 'plan_e2e_standard', 'plan_e2e_premium'],
  discordGuildId: 'guild-e2e-test',
  discordPaidRoleId: 'role-e2e-test',
  initialChargeAmount: 1000,
  initialChargeAmountCurrency: 'jpy',
};

export const E2E_WEBHOOK_TOKEN = 'whsec_e2e_test_token';

export function buildSyncDepsForE2E(
  pool: pg.Pool,
  syncRole: (userId: string, action: 'grant' | 'revoke') => Promise<void> = vi.fn().mockResolvedValue(undefined),
): SyncDeps {
  const webhookDeps: WebhookHandlerDeps = {
    db: createPgPool(pool),
    payjpWebhookToken: E2E_WEBHOOK_TOKEN,
    expectedLivemode: false,
    discordGuildId: E2E_BILLING_CONFIG.discordGuildId,
    discordRoleId: E2E_BILLING_CONFIG.discordPaidRoleId,
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
 * 購読完了状態の member を作成して返す（link_session は `insertLinkedSession` で再現）。
 * PAY.JP / Discord のモックを差し替える場合は、この関数に渡す前に
 * `buildE2EApp(pgDb, { payjp, discord })` でアプリを組み立てること。
 */
export async function subscribeUser(
  app: ReturnType<typeof buildApp>,
  pgDb: PgDbClient,
  discordUserId: string,
  overrides: { planId?: string } = {},
): Promise<{ memberId: string; linkSessionToken: string }> {
  const { rawToken } = await insertLinkedSession(pgDb, discordUserId);
  const planId = overrides.planId ?? E2E_BILLING_CONFIG.allowedPlanIds[0];

  const res = await app.inject({
    method: 'POST',
    url: '/v1/subscriptions',
    headers: { 'content-type': 'application/json', origin: 'https://example.com' },
    cookies: { '__Host-link_session': rawToken },
    body: JSON.stringify({
      planId,
      email: `${discordUserId}@e2e-test.example.com`,
      payjpToken: 'tok_test_e2e',
      privacyConsented: true,
    }),
  });

  if (res.statusCode !== 200) {
    throw new Error(`subscribeUser failed: ${res.statusCode} ${res.body}`);
  }

  const member = await pgDb.findMemberByDiscordUserId(discordUserId);
  return { memberId: member!.id, linkSessionToken: rawToken };
}

// ---------------------------------------------------------------------------
// Webhook テストフィクスチャ
// ---------------------------------------------------------------------------

const DEFAULT_EVENT_CREATED = Math.floor(new Date('2025-04-01T10:00:00Z').getTime() / 1000);

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
    data: {
      id: 'sub_test_e2e',
      object: 'subscription',
      status: 'active',
      metadata: { discord_user_id: 'discord-e2e-user' },
      plan: { id: 'plan_e2e' },
      current_period_end: created + 30 * 86400,
      ...dataOverrides,
    },
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
    log: vi.fn(),
    now: () => new Date(),
    ...overrides,
  };
}

export { closePool, createPgPool, PgDbClient };
