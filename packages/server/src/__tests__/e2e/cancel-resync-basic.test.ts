/**
 * E2E スモークテスト — Issue #22
 *
 * Cancel / Resync CLI / Daily Resync の基本動作を確認する最小シナリオ。
 * 詳細シナリオは cancel.test.ts / failure-recovery.test.ts / role-removal.test.ts が担当。
 *
 * 前提: DATABASE_URL_TEST または DATABASE_URL が設定済みの PostgreSQL に接続可能であること。
 */

import { randomUUID } from 'node:crypto';
import { runDailyResync, runResyncCli } from '@hayane/sync-service';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildE2EApp,
  closePool,
  createTestDb,
  E2E_BILLING_CONFIG,
  insertLinkedSession,
  makeCliDeps,
  makeMockDiscordClient,
  makeMockPayjpClient,
  type PgDbClient,
  TEST_DB_URL,
  truncateAll,
} from './helpers.js';

const hasTestDb = Boolean(TEST_DB_URL);

describe.skipIf(!hasTestDb)('E2E Cancel / Resync / Daily Resync — 基本スモーク', () => {
  let pool: pg.Pool;
  let pgDb: PgDbClient;

  beforeAll(async () => {
    ({ pool, pgDb } = await createTestDb());
  });

  afterAll(async () => {
    await closePool(pool);
  });

  beforeEach(async () => {
    await truncateAll(pool);
  });

  // ---------------------------------------------------------------------------
  // Scenario 1: Cancel 基本 — 受付期間内（access_end_at が 15 日後）
  // ---------------------------------------------------------------------------
  describe('Scenario 1: Cancel basic — 受付期間内', () => {
    it('POST /v1/subscriptions/cancel → 200 / cancel_requested_at がセットされ access_end_at が維持される', async () => {
      const discordUserId = `cancel-basic-${randomUUID()}`;
      const now = new Date();
      const accessEndAt = new Date(now.getTime() + 15 * 24 * 60 * 60 * 1000); // 15 日後

      // メンバーを事前挿入（active / PAY.JP 情報あり）
      await pool.query(
        `INSERT INTO members
           (id, discord_user_id, email, subscription_status,
            payjp_customer_id, payjp_subscription_id, payjp_plan_id,
            access_end_at, first_trial_granted_at, role_state)
         VALUES ($1, $2, $3, 'active', $4, $5, $6, $7, NOW(), 'granted')`,
        [
          randomUUID(),
          discordUserId,
          `${discordUserId}@e2e-test.example.com`,
          'cus_test_e2e',
          'sub_test_e2e',
          E2E_BILLING_CONFIG.allowedPlanIds[0],
          accessEndAt,
        ],
      );

      // link_session を直接挿入（OAuth 完了後の状態を再現）
      const { rawToken } = await insertLinkedSession(pgDb, discordUserId);

      const payjpMock = makeMockPayjpClient();
      const discordMock = makeMockDiscordClient();
      // clock を現在時刻に固定（access_end_at まで 15 日 = 1 ヶ月以内 → 受付期間内）
      const fixedNow = new Date();
      const app = buildE2EApp(pgDb, {
        payjp: payjpMock,
        discord: discordMock,
        clock: () => fixedNow,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/subscriptions/cancel',
        headers: {
          'content-type': 'application/json',
          origin: 'https://example.com',
        },
        cookies: { '__Host-link_session': rawToken },
      });

      expect(res.statusCode).toBe(200);

      // DB 確認: cancel_requested_at がセットされている
      const member = await pgDb.findMemberByDiscordUserId(discordUserId);
      expect(member).not.toBeNull();
      expect(member!.cancel_requested_at).not.toBeNull();

      // DB 確認: access_end_at が変更されていない（15 日後のまま）
      const storedAccessEndAt = new Date(member!.access_end_at as Date);
      expect(storedAccessEndAt.getTime()).toBeCloseTo(accessEndAt.getTime(), -3); // ms 単位ではなく秒単位で比較
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario 2: CLI Resync 基本 — --discord-user-id
  // ---------------------------------------------------------------------------
  describe('Scenario 2: CLI resync basic — --discord-user-id', () => {
    it('runResyncCli(--discord-user-id) → exitCode=0 / processed_count=1 / succeeded_count=1', async () => {
      const discordUserId = `resync-cli-basic-${randomUUID()}`;
      const futureTimestamp = Math.floor(Date.now() / 1000) + 30 * 86400;

      // メンバーを事前挿入（active / PAY.JP 情報あり）
      await pool.query(
        `INSERT INTO members
           (id, discord_user_id, email, subscription_status,
            payjp_customer_id, payjp_subscription_id, access_end_at, role_state)
         VALUES ($1, $2, $3, 'active', $4, $5, NOW() + INTERVAL '30 days', 'granted')`,
        [randomUUID(), discordUserId, `${discordUserId}@e2e-test.example.com`, 'cus_test_e2e', 'sub_test_cli'],
      );

      const cliDeps = makeCliDeps(pool, {
        getPayjpSubscription: vi.fn().mockResolvedValue({
          id: 'sub_test_cli',
          status: 'active',
          current_period_end: futureTimestamp,
        }),
      });

      const output = await runResyncCli(['--discord-user-id', discordUserId], cliDeps);

      expect(output.exitCode).toBe(0);
      expect(output.result.processed_count).toBe(1);
      expect(output.result.succeeded_count).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario 3: Daily Resync 基本 — access_end_at 期限切れ → ロール剥奪
  // ---------------------------------------------------------------------------
  describe('Scenario 3: Daily resync basic — access_end_at 期限切れ → ロール剥奪', () => {
    it('runDailyResync → syncRole が (discordUserId, "revoke") で呼ばれる', async () => {
      const discordUserId = `daily-resync-basic-${randomUUID()}`;
      const pastTimestamp = Math.floor(Date.now() / 1000) - 86400; // 昨日

      // メンバーを事前挿入（canceled / access_end_at = 昨日 / role_state = granted）
      await pool.query(
        `INSERT INTO members
           (id, discord_user_id, email, subscription_status,
            payjp_customer_id, payjp_subscription_id,
            access_end_at, role_state)
         VALUES ($1, $2, $3, 'canceled', $4, $5, NOW() - INTERVAL '1 day', 'granted')`,
        [randomUUID(), discordUserId, `${discordUserId}@e2e-test.example.com`, 'cus_test_e2e', 'sub_test_daily'],
      );

      const syncRole = vi.fn().mockResolvedValue(undefined);
      const cliDeps = makeCliDeps(pool, {
        getPayjpSubscription: vi.fn().mockResolvedValue({
          id: 'sub_test_daily',
          status: 'canceled',
          current_period_end: pastTimestamp,
        }),
        syncRole,
      });

      await runDailyResync({ cliDeps, log: vi.fn() });

      expect(syncRole).toHaveBeenCalledWith(discordUserId, 'revoke');
    });
  });
});
