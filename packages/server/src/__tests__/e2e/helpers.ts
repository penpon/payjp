/**
 * E2E テストハーネス — 共通ユーティリティ
 *
 * - 実 PostgreSQL（DATABASE_URL_TEST または DATABASE_URL）
 * - PayjpClient / DiscordClient は DI インターフェースレベルのモック
 * - Discord OAuth HTTP 呼び出しは呼び出し元で vi.spyOn(globalThis, 'fetch') を使用
 */

import { randomUUID } from 'node:crypto';
import type { BillingConfig, BillingDeps, DiscordClient, PayjpClient } from '@hayane/billing-service';
import { closePool, createPgPool, createPool, PgDbClient, runMigrations } from '@hayane/shared';
import type { WebhookHandlerDeps } from '@hayane/sync-service';
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
  allowedPlanIds: ['plan_e2e'],
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

export function buildE2EApp(
  pgDb: PgDbClient,
  overrides: { payjp?: PayjpClient; discord?: DiscordClient; syncDeps?: SyncDeps } = {},
) {
  const billingDeps: BillingDeps = {
    db: pgDb,
    payjp: overrides.payjp ?? makeMockPayjpClient(),
    discord: overrides.discord ?? makeMockDiscordClient(),
    config: E2E_BILLING_CONFIG,
    clock: () => new Date(),
    generateOperationId: () => randomUUID(),
  };

  // PgDbClient は AuthDb インターフェースを構造的型付けで満たす
  return buildApp(
    {
      frontendBaseUrl: 'https://example.com',
      discordClientId: 'test-client-id',
      discordClientSecret: 'test-client-secret',
      discordRedirectUri: 'https://api.example.com/v1/auth/discord/callback',
      db: pgDb,
    },
    billingDeps,
    overrides.syncDeps,
  );
}

export { closePool, PgDbClient };
