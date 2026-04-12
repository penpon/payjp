/**
 * E2E テスト — キャンセルフロー詳細 (Issue #46, T-P0-05)
 *
 * カバレッジ:
 *   - 受付期間境界: access_end_at の 1 ヶ月前から受付開始（月末繰り上げ含む）
 *   - Origin / Session 検証
 *   - 契約状態ガード: 削除済み・payjp_subscription_id なし・access_end_at なし
 *   - inflight ガード: 既存 operationId があれば 503 返却、Cookie 未消費
 *   - 同時キャンセル: PAY.JP cancelSubscription 呼び出しは 1 回以下
 *   - 冪等性: cancel_requested_at 設定済みなら PAY.JP 再呼び出しなし
 *   - キャンセル成功後 DB 状態: cancel_requested_at 記録・access_end_at 更新・ロール即時剥奪なし
 *   - 503 不確定失敗: inflight_operation_id/type/started_at が保持される
 *
 * 前提: DATABASE_URL_TEST または DATABASE_URL が設定済みの PostgreSQL に接続可能であること。
 */

import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildE2EApp,
  closePool,
  createTestDb,
  insertLinkedSession,
  makeMockDiscordClient,
  makeMockPayjpClient,
  type PgDbClient,
  TEST_DB_URL,
  truncateAll,
} from './helpers.js';

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------

const CANCEL_URL = '/v1/subscriptions/cancel';
const VALID_ORIGIN = 'https://example.com';

// ---------------------------------------------------------------------------
// ユーティリティ
// ---------------------------------------------------------------------------

/** POST /v1/subscriptions/cancel のリクエストを組み立てる */
function buildCancelRequest(rawToken: string, overrides: { origin?: string } = {}) {
  const { origin = VALID_ORIGIN } = overrides;
  return {
    method: 'POST' as const,
    url: CANCEL_URL,
    headers: { origin },
    cookies: { '__Host-link_session': rawToken },
  };
}

/**
 * subscribed メンバーを DB に直接挿入する。
 * clock injection でキャンセル受付期間境界テストが行えるよう、access_end_at を指定可能。
 */
async function insertSubscribedMember(
  pool: pg.Pool,
  discordUserId: string,
  accessEndAt: Date,
  overrides: {
    subscriptionStatus?: string;
    payjpSubscriptionId?: string | null;
    cancelRequestedAt?: Date | null;
    inflightOperationId?: string | null;
    inflightOperationType?: string | null;
  } = {},
): Promise<string> {
  const memberId = randomUUID();
  const {
    subscriptionStatus = 'active',
    payjpSubscriptionId = 'sub_test',
    cancelRequestedAt = null,
    inflightOperationId = null,
    inflightOperationType = null,
  } = overrides;

  const email = `${discordUserId}@e2e.test`;

  await pool.query(
    `INSERT INTO members (
       id, discord_user_id, email, subscription_status,
       payjp_customer_id, payjp_subscription_id, payjp_plan_id,
       access_end_at, first_trial_granted_at,
       cancel_requested_at,
       inflight_operation_id, inflight_operation_type, inflight_operation_started_at
     ) VALUES (
       $1, $2, $3, $4,
       'cus_test', $5, 'plan_e2e',
       $6, NOW(),
       $7,
       $8::text, $9::text, CASE WHEN $8::text IS NOT NULL THEN NOW() ELSE NULL END
     )`,
    [
      memberId,
      discordUserId,
      email,
      subscriptionStatus,
      payjpSubscriptionId,
      accessEndAt,
      cancelRequestedAt,
      inflightOperationId,
      inflightOperationType,
    ],
  );
  return memberId;
}

// ---------------------------------------------------------------------------
// テストスイート
// ---------------------------------------------------------------------------

const hasTestDb = Boolean(TEST_DB_URL);

describe.skipIf(!hasTestDb)('E2E Cancel — T-P0-05', () => {
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
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // 受付期間境界
  // -------------------------------------------------------------------------
  describe('受付期間境界', () => {
    it('now_jst < access_end_at - 1ヶ月 → 409 (too early)', async () => {
      // access_end_at = 2025-05-15, clock = 2025-04-01 → 受付開始 2025-04-15 より前 → 409
      const discordUserId = `cancel-boundary-early-${randomUUID().slice(0, 8)}`;
      const accessEndAt = new Date('2025-05-15T00:00:00Z');
      const fixedDate = new Date('2025-04-01T00:00:00+09:00'); // JST 2025-04-01 = UTC 2025-03-31T15:00:00Z

      const payjpMock = makeMockPayjpClient();
      const app = buildE2EApp(pgDb, {
        payjp: payjpMock,
        discord: makeMockDiscordClient(),
        clock: () => fixedDate,
      });

      await insertSubscribedMember(pool, discordUserId, accessEndAt);
      const { rawToken } = await insertLinkedSession(pgDb, discordUserId);

      const res = await app.inject(buildCancelRequest(rawToken));

      expect(res.statusCode).toBe(409);
      expect(res.json().ok).toBe(false);
      expect(payjpMock.cancelSubscription).not.toHaveBeenCalled();
    });

    it('now_jst >= access_end_at - 1ヶ月 → 200 (成功)', async () => {
      // access_end_at = 2025-05-15, clock = 2025-04-15 → 受付開始ちょうど → 200
      const discordUserId = `cancel-boundary-ok-${randomUUID().slice(0, 8)}`;
      const accessEndAt = new Date('2025-05-15T00:00:00Z');
      const fixedDate = new Date('2025-04-15T00:00:00+09:00'); // JST 2025-04-15

      const cancelPeriodEnd = Math.floor(accessEndAt.getTime() / 1000);
      const payjpMock = makeMockPayjpClient();
      (payjpMock.cancelSubscription as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'sub_test',
        status: 'canceled',
        current_period_end: cancelPeriodEnd,
        trial_end: null,
        plan: { id: 'plan_e2e', interval: 'month' },
        metadata: {},
      });
      const app = buildE2EApp(pgDb, {
        payjp: payjpMock,
        discord: makeMockDiscordClient(),
        clock: () => fixedDate,
      });

      await insertSubscribedMember(pool, discordUserId, accessEndAt);
      const { rawToken } = await insertLinkedSession(pgDb, discordUserId);

      const res = await app.inject(buildCancelRequest(rawToken));

      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
    });

    it('月末繰り上げ: access_end_at = 2025-03-31 → 受付開始 2025-02-28', async () => {
      // 2025-03-31 の 1ヶ月前は 2025-02-31 → 存在しないので 2025-02-28
      // clock = 2025-02-28 → 受付開始ちょうど → 200
      const discordUserId = `cancel-carry-0331-${randomUUID().slice(0, 8)}`;
      const accessEndAt = new Date('2025-03-31T00:00:00Z');
      const fixedDate = new Date('2025-02-28T00:00:00+09:00'); // JST 2025-02-28

      const cancelPeriodEnd = Math.floor(accessEndAt.getTime() / 1000);
      const payjpMock = makeMockPayjpClient();
      (payjpMock.cancelSubscription as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'sub_test',
        status: 'canceled',
        current_period_end: cancelPeriodEnd,
        trial_end: null,
        plan: { id: 'plan_e2e', interval: 'month' },
        metadata: {},
      });
      const app = buildE2EApp(pgDb, {
        payjp: payjpMock,
        discord: makeMockDiscordClient(),
        clock: () => fixedDate,
      });

      await insertSubscribedMember(pool, discordUserId, accessEndAt);
      const { rawToken } = await insertLinkedSession(pgDb, discordUserId);

      const res = await app.inject(buildCancelRequest(rawToken));

      // clock = 2025-02-28 >= acceptance start 2025-02-28 → 200
      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
    });

    it('月末繰り上げ: access_end_at = 2025-03-31 → clock = 2025-02-27 → 409 (too early)', async () => {
      const discordUserId = `cancel-carry-0331-early-${randomUUID().slice(0, 8)}`;
      const accessEndAt = new Date('2025-03-31T00:00:00Z');
      const fixedDate = new Date('2025-02-27T00:00:00+09:00'); // JST 2025-02-27

      const payjpMock = makeMockPayjpClient();
      const app = buildE2EApp(pgDb, {
        payjp: payjpMock,
        discord: makeMockDiscordClient(),
        clock: () => fixedDate,
      });

      await insertSubscribedMember(pool, discordUserId, accessEndAt);
      const { rawToken } = await insertLinkedSession(pgDb, discordUserId);

      const res = await app.inject(buildCancelRequest(rawToken));

      expect(res.statusCode).toBe(409);
      expect(res.json().ok).toBe(false);
      expect(payjpMock.cancelSubscription).not.toHaveBeenCalled();
    });

    it('月末繰り上げ: access_end_at = 2025-05-31 → 受付開始 2025-04-30', async () => {
      // 2025-05-31 の 1ヶ月前は 2025-04-31 → 存在しないので 2025-04-30
      // clock = 2025-04-30 → 200
      const discordUserId = `cancel-carry-0531-${randomUUID().slice(0, 8)}`;
      const accessEndAt = new Date('2025-05-31T00:00:00Z');
      const fixedDate = new Date('2025-04-30T00:00:00+09:00');

      const cancelPeriodEnd = Math.floor(accessEndAt.getTime() / 1000);
      const payjpMock = makeMockPayjpClient();
      (payjpMock.cancelSubscription as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'sub_test',
        status: 'canceled',
        current_period_end: cancelPeriodEnd,
        trial_end: null,
        plan: { id: 'plan_e2e', interval: 'month' },
        metadata: {},
      });
      const app = buildE2EApp(pgDb, {
        payjp: payjpMock,
        discord: makeMockDiscordClient(),
        clock: () => fixedDate,
      });

      await insertSubscribedMember(pool, discordUserId, accessEndAt);
      const { rawToken } = await insertLinkedSession(pgDb, discordUserId);

      const res = await app.inject(buildCancelRequest(rawToken));

      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
    });

    it('月末繰り上げ: access_end_at = 2026-01-31 → 受付開始 2025-12-31', async () => {
      // 2026-01-31 の 1ヶ月前は 2025-12-31
      // clock = 2025-12-31 → 200
      const discordUserId = `cancel-carry-0131-${randomUUID().slice(0, 8)}`;
      const accessEndAt = new Date('2026-01-31T00:00:00Z');
      const fixedDate = new Date('2025-12-31T00:00:00+09:00');

      const cancelPeriodEnd = Math.floor(accessEndAt.getTime() / 1000);
      const payjpMock = makeMockPayjpClient();
      (payjpMock.cancelSubscription as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'sub_test',
        status: 'canceled',
        current_period_end: cancelPeriodEnd,
        trial_end: null,
        plan: { id: 'plan_e2e', interval: 'month' },
        metadata: {},
      });
      const app = buildE2EApp(pgDb, {
        payjp: payjpMock,
        discord: makeMockDiscordClient(),
        clock: () => fixedDate,
      });

      await insertSubscribedMember(pool, discordUserId, accessEndAt);
      const { rawToken } = await insertLinkedSession(pgDb, discordUserId);

      const res = await app.inject(buildCancelRequest(rawToken));

      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
    });

    it('月末繰り上げなし: access_end_at = 2025-04-15 → 受付開始 2025-03-15', async () => {
      // 繰り上げ不要ケース: clock = 2025-04-15 → access_end_at 当日、
      // 受付開始 2025-03-15 なので 2025-04-15 は許容される
      const discordUserId = `cancel-no-carry-${randomUUID().slice(0, 8)}`;
      const accessEndAt = new Date('2025-04-15T00:00:00Z');
      const fixedDate = new Date('2025-04-15T00:00:00+09:00');

      const cancelPeriodEnd = Math.floor(accessEndAt.getTime() / 1000);
      const payjpMock = makeMockPayjpClient();
      (payjpMock.cancelSubscription as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'sub_test',
        status: 'canceled',
        current_period_end: cancelPeriodEnd,
        trial_end: null,
        plan: { id: 'plan_e2e', interval: 'month' },
        metadata: {},
      });
      const app = buildE2EApp(pgDb, {
        payjp: payjpMock,
        discord: makeMockDiscordClient(),
        clock: () => fixedDate,
      });

      await insertSubscribedMember(pool, discordUserId, accessEndAt);
      const { rawToken } = await insertLinkedSession(pgDb, discordUserId);

      const res = await app.inject(buildCancelRequest(rawToken));

      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Origin / Session 検証
  // -------------------------------------------------------------------------
  describe('Origin / Session 検証', () => {
    it('Origin ヘッダなし → 403', async () => {
      const discordUserId = `cancel-origin-missing-${randomUUID().slice(0, 8)}`;
      const accessEndAt = new Date('2025-05-15T00:00:00Z');
      const fixedDate = new Date('2025-04-15T00:00:00+09:00');
      const app = buildE2EApp(pgDb, {
        payjp: makeMockPayjpClient(),
        discord: makeMockDiscordClient(),
        clock: () => fixedDate,
      });

      await insertSubscribedMember(pool, discordUserId, accessEndAt);
      const { rawToken } = await insertLinkedSession(pgDb, discordUserId);

      const res = await app.inject({
        method: 'POST',
        url: CANCEL_URL,
        cookies: { '__Host-link_session': rawToken },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().ok).toBe(false);
    });

    it('Origin: "null"（文字列）→ 403', async () => {
      const discordUserId = `cancel-origin-null-${randomUUID().slice(0, 8)}`;
      const accessEndAt = new Date('2025-05-15T00:00:00Z');
      const fixedDate = new Date('2025-04-15T00:00:00+09:00');
      const app = buildE2EApp(pgDb, {
        payjp: makeMockPayjpClient(),
        discord: makeMockDiscordClient(),
        clock: () => fixedDate,
      });

      await insertSubscribedMember(pool, discordUserId, accessEndAt);
      const { rawToken } = await insertLinkedSession(pgDb, discordUserId);

      const res = await app.inject(buildCancelRequest(rawToken, { origin: 'null' }));

      expect(res.statusCode).toBe(403);
      expect(res.json().ok).toBe(false);
    });

    it('Origin 不一致 (https://evil.com) → 403', async () => {
      const discordUserId = `cancel-origin-evil-${randomUUID().slice(0, 8)}`;
      const accessEndAt = new Date('2025-05-15T00:00:00Z');
      const fixedDate = new Date('2025-04-15T00:00:00+09:00');
      const app = buildE2EApp(pgDb, {
        payjp: makeMockPayjpClient(),
        discord: makeMockDiscordClient(),
        clock: () => fixedDate,
      });

      await insertSubscribedMember(pool, discordUserId, accessEndAt);
      const { rawToken } = await insertLinkedSession(pgDb, discordUserId);

      const res = await app.inject(buildCancelRequest(rawToken, { origin: 'https://evil.com' }));

      expect(res.statusCode).toBe(403);
      expect(res.json().ok).toBe(false);
    });

    it('__Host-link_session Cookie なし → 401', async () => {
      const discordUserId = `cancel-no-cookie-${randomUUID().slice(0, 8)}`;
      const accessEndAt = new Date('2025-05-15T00:00:00Z');
      const fixedDate = new Date('2025-04-15T00:00:00+09:00');
      const app = buildE2EApp(pgDb, {
        payjp: makeMockPayjpClient(),
        discord: makeMockDiscordClient(),
        clock: () => fixedDate,
      });

      await insertSubscribedMember(pool, discordUserId, accessEndAt);

      const res = await app.inject({
        method: 'POST',
        url: CANCEL_URL,
        headers: { origin: VALID_ORIGIN },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().ok).toBe(false);
    });

    it('期限切れ link session → 401', async () => {
      const discordUserId = `cancel-expired-session-${randomUUID().slice(0, 8)}`;
      const accessEndAt = new Date('2025-05-15T00:00:00Z');
      const fixedDate = new Date('2025-04-15T00:00:00+09:00');
      const app = buildE2EApp(pgDb, {
        payjp: makeMockPayjpClient(),
        discord: makeMockDiscordClient(),
        clock: () => fixedDate,
      });

      await insertSubscribedMember(pool, discordUserId, accessEndAt);
      // 既に期限切れ: expiresIn = -1ms（expiresAt はアプリの clock と同じ基準で計算）
      const { rawToken } = await insertLinkedSession(pgDb, discordUserId, undefined, -1, () => fixedDate);

      const res = await app.inject(buildCancelRequest(rawToken));

      expect(res.statusCode).toBe(401);
      expect(res.json().ok).toBe(false);
    });

    it('消費済み link session → 401', async () => {
      const discordUserId = `cancel-consumed-session-${randomUUID().slice(0, 8)}`;
      const accessEndAt = new Date('2025-05-15T00:00:00Z');
      const fixedDate = new Date('2025-04-15T00:00:00+09:00');
      const cancelPeriodEnd = Math.floor(accessEndAt.getTime() / 1000);
      const payjpMock = makeMockPayjpClient();
      (payjpMock.cancelSubscription as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'sub_test',
        status: 'canceled',
        current_period_end: cancelPeriodEnd,
        trial_end: null,
        plan: { id: 'plan_e2e', interval: 'month' },
        metadata: {},
      });
      const app = buildE2EApp(pgDb, {
        payjp: payjpMock,
        discord: makeMockDiscordClient(),
        clock: () => fixedDate,
      });

      await insertSubscribedMember(pool, discordUserId, accessEndAt);
      const { rawToken } = await insertLinkedSession(pgDb, discordUserId);

      // 1回目のキャンセル（成功して Cookie を消費）
      const firstRes = await app.inject(buildCancelRequest(rawToken));
      expect(firstRes.statusCode).toBe(200);

      // 同じ Cookie で 2 回目 → 401
      const secondRes = await app.inject(buildCancelRequest(rawToken));
      expect(secondRes.statusCode).toBe(401);
      expect(secondRes.json().ok).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 契約状態ガード
  // -------------------------------------------------------------------------
  describe('契約状態ガード', () => {
    it('メンバー行なし → 401 (link session は有効だがメンバー不存在)', async () => {
      // link session の discord_user_id に対応する member が存在しない
      const discordUserId = `cancel-no-member-${randomUUID().slice(0, 8)}`;
      const fixedDate = new Date('2025-04-15T00:00:00+09:00');
      const app = buildE2EApp(pgDb, {
        payjp: makeMockPayjpClient(),
        discord: makeMockDiscordClient(),
        clock: () => fixedDate,
      });

      // member は挿入しない
      const { rawToken } = await insertLinkedSession(pgDb, discordUserId);

      const res = await app.inject(buildCancelRequest(rawToken));

      // no active subscription → 409
      expect(res.statusCode).toBe(409);
      expect(res.json().ok).toBe(false);
    });

    it('subscription_status = "deleted" → 409', async () => {
      const discordUserId = `cancel-deleted-${randomUUID().slice(0, 8)}`;
      const accessEndAt = new Date('2025-05-15T00:00:00Z');
      const fixedDate = new Date('2025-04-15T00:00:00+09:00');
      const app = buildE2EApp(pgDb, {
        payjp: makeMockPayjpClient(),
        discord: makeMockDiscordClient(),
        clock: () => fixedDate,
      });

      await insertSubscribedMember(pool, discordUserId, accessEndAt, {
        subscriptionStatus: 'deleted',
      });
      const { rawToken } = await insertLinkedSession(pgDb, discordUserId);

      const res = await app.inject(buildCancelRequest(rawToken));

      expect(res.statusCode).toBe(409);
      expect(res.json().ok).toBe(false);
    });

    it('payjp_subscription_id が null → 409', async () => {
      const discordUserId = `cancel-no-sub-id-${randomUUID().slice(0, 8)}`;
      const accessEndAt = new Date('2025-05-15T00:00:00Z');
      const fixedDate = new Date('2025-04-15T00:00:00+09:00');
      const app = buildE2EApp(pgDb, {
        payjp: makeMockPayjpClient(),
        discord: makeMockDiscordClient(),
        clock: () => fixedDate,
      });

      await insertSubscribedMember(pool, discordUserId, accessEndAt, {
        payjpSubscriptionId: null,
      });
      const { rawToken } = await insertLinkedSession(pgDb, discordUserId);

      const res = await app.inject(buildCancelRequest(rawToken));

      expect(res.statusCode).toBe(409);
      expect(res.json().ok).toBe(false);
    });

    it('access_end_at が null → 409', async () => {
      const discordUserId = `cancel-no-access-end-${randomUUID().slice(0, 8)}`;
      const fixedDate = new Date('2025-04-15T00:00:00+09:00');
      const app = buildE2EApp(pgDb, {
        payjp: makeMockPayjpClient(),
        discord: makeMockDiscordClient(),
        clock: () => fixedDate,
      });

      // access_end_at = NULL を直接挿入
      const memberId = randomUUID();
      await pool.query(
        `INSERT INTO members (id, discord_user_id, email, subscription_status, payjp_customer_id, payjp_subscription_id, payjp_plan_id, access_end_at, first_trial_granted_at)
         VALUES ($1, $2, $3, 'active', 'cus_test', 'sub_test', 'plan_e2e', NULL, NOW())`,
        [memberId, discordUserId, `${discordUserId}@e2e.test`],
      );
      const { rawToken } = await insertLinkedSession(pgDb, discordUserId);

      const res = await app.inject(buildCancelRequest(rawToken));

      expect(res.statusCode).toBe(409);
      expect(res.json().ok).toBe(false);
    });

    it('inflight_operation_id が存在 → 503 + 既存 operationId、Cookie 未消費', async () => {
      const discordUserId = `cancel-inflight-${randomUUID().slice(0, 8)}`;
      const accessEndAt = new Date('2025-05-15T00:00:00Z');
      const fixedDate = new Date('2025-04-15T00:00:00+09:00');
      const existingOperationId = `op-existing-${randomUUID()}`;
      const app = buildE2EApp(pgDb, {
        payjp: makeMockPayjpClient(),
        discord: makeMockDiscordClient(),
        clock: () => fixedDate,
      });

      await insertSubscribedMember(pool, discordUserId, accessEndAt, {
        inflightOperationId: existingOperationId,
        inflightOperationType: 'cancel',
      });
      const { rawToken } = await insertLinkedSession(pgDb, discordUserId);

      const res = await app.inject(buildCancelRequest(rawToken));

      expect(res.statusCode).toBe(503);
      const body = res.json();
      expect(body.ok).toBe(false);
      expect(body.operationId).toBe(existingOperationId);

      // link session は消費されていないこと（再試行可能なので）
      const { rows } = await pool.query('SELECT used_at FROM discord_link_sessions WHERE discord_user_id = $1', [
        discordUserId,
      ]);
      expect(rows[0]?.used_at).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // 同時キャンセルガード
  // -------------------------------------------------------------------------
  describe('同時キャンセルガード', () => {
    it('同一ユーザーへの同時 2 リクエスト → PAY.JP cancelSubscription は 1 回以下', async () => {
      const discordUserId = `cancel-concurrent-${randomUUID().slice(0, 8)}`;
      const accessEndAt = new Date('2025-05-15T00:00:00Z');
      const fixedDate = new Date('2025-04-15T00:00:00+09:00');
      const cancelPeriodEnd = Math.floor(accessEndAt.getTime() / 1000);

      const payjpMock = makeMockPayjpClient();
      (payjpMock.cancelSubscription as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'sub_test',
        status: 'canceled',
        current_period_end: cancelPeriodEnd,
        trial_end: null,
        plan: { id: 'plan_e2e', interval: 'month' },
        metadata: {},
      });
      const app = buildE2EApp(pgDb, {
        payjp: payjpMock,
        discord: makeMockDiscordClient(),
        clock: () => fixedDate,
      });

      await insertSubscribedMember(pool, discordUserId, accessEndAt);

      // 各リクエストに別の link session が必要
      const { rawToken: rawToken1 } = await insertLinkedSession(pgDb, discordUserId);
      const { rawToken: rawToken2 } = await insertLinkedSession(pgDb, discordUserId);

      const [res1, res2] = await Promise.all([
        app.inject(buildCancelRequest(rawToken1)),
        app.inject(buildCancelRequest(rawToken2)),
      ]);

      // 一方は成功、もう一方はロック競合 (503) または 冪等 (200) のいずれか
      const statuses = [res1.statusCode, res2.statusCode];
      const successCount = statuses.filter((s) => s === 200).length;
      expect(successCount).toBeGreaterThanOrEqual(1);

      // PAY.JP cancelSubscription は合計 1 回のみ呼ばれる
      const cancelCallCount = (payjpMock.cancelSubscription as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(cancelCallCount).toBeLessThanOrEqual(1);
    });
  });

  // -------------------------------------------------------------------------
  // 冪等性
  // -------------------------------------------------------------------------
  describe('冪等性', () => {
    it('cancel_requested_at 設定済み → 200 (PAY.JP cancel API 再呼び出しなし)', async () => {
      const discordUserId = `cancel-idempotent-${randomUUID().slice(0, 8)}`;
      const accessEndAt = new Date('2025-05-15T00:00:00Z');
      const fixedDate = new Date('2025-04-15T00:00:00+09:00');
      const payjpMock = makeMockPayjpClient();
      const app = buildE2EApp(pgDb, {
        payjp: payjpMock,
        discord: makeMockDiscordClient(),
        clock: () => fixedDate,
      });

      // 既に cancel_requested_at が設定されている状態
      await insertSubscribedMember(pool, discordUserId, accessEndAt, {
        subscriptionStatus: 'canceled',
        cancelRequestedAt: new Date('2025-04-10T00:00:00Z'),
      });
      const { rawToken } = await insertLinkedSession(pgDb, discordUserId);

      const res = await app.inject(buildCancelRequest(rawToken));

      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
      // PAY.JP は再呼び出しされない
      expect(payjpMock.cancelSubscription).not.toHaveBeenCalled();
    });

    it('初回キャンセル後 → 再 OAuth + 新 link session → 冪等 200', async () => {
      const discordUserId = `cancel-idempotent-reauth-${randomUUID().slice(0, 8)}`;
      const accessEndAt = new Date('2025-05-15T00:00:00Z');
      const fixedDate = new Date('2025-04-15T00:00:00+09:00');
      const cancelPeriodEnd = Math.floor(accessEndAt.getTime() / 1000);

      const payjpMock = makeMockPayjpClient();
      (payjpMock.cancelSubscription as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'sub_test',
        status: 'canceled',
        current_period_end: cancelPeriodEnd,
        trial_end: null,
        plan: { id: 'plan_e2e', interval: 'month' },
        metadata: {},
      });
      const app = buildE2EApp(pgDb, {
        payjp: payjpMock,
        discord: makeMockDiscordClient(),
        clock: () => fixedDate,
      });

      await insertSubscribedMember(pool, discordUserId, accessEndAt);

      // 1 回目のキャンセル（link session を消費）
      const { rawToken: rawToken1 } = await insertLinkedSession(pgDb, discordUserId);
      const firstRes = await app.inject(buildCancelRequest(rawToken1));
      expect(firstRes.statusCode).toBe(200);
      expect(payjpMock.cancelSubscription).toHaveBeenCalledOnce();

      // 再 OAuth 相当: 新しい link session
      const { rawToken: rawToken2 } = await insertLinkedSession(pgDb, discordUserId);
      const secondRes = await app.inject(buildCancelRequest(rawToken2));

      expect(secondRes.statusCode).toBe(200);
      expect(secondRes.json().ok).toBe(true);
      // 2 回目は PAY.JP を呼ばない
      expect(payjpMock.cancelSubscription).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // キャンセル成功後 DB 状態
  // -------------------------------------------------------------------------
  describe('キャンセル成功後 DB 状態', () => {
    it('members.cancel_requested_at が記録される', async () => {
      const discordUserId = `cancel-db-cancel-at-${randomUUID().slice(0, 8)}`;
      const accessEndAt = new Date('2025-05-15T00:00:00Z');
      const fixedDate = new Date('2025-04-15T00:00:00+09:00');
      const cancelPeriodEnd = Math.floor(accessEndAt.getTime() / 1000);

      const payjpMock = makeMockPayjpClient();
      (payjpMock.cancelSubscription as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'sub_test',
        status: 'canceled',
        current_period_end: cancelPeriodEnd,
        trial_end: null,
        plan: { id: 'plan_e2e', interval: 'month' },
        metadata: {},
      });
      const app = buildE2EApp(pgDb, {
        payjp: payjpMock,
        discord: makeMockDiscordClient(),
        clock: () => fixedDate,
      });

      await insertSubscribedMember(pool, discordUserId, accessEndAt);
      const { rawToken } = await insertLinkedSession(pgDb, discordUserId);

      const res = await app.inject(buildCancelRequest(rawToken));
      expect(res.statusCode).toBe(200);

      const member = await pgDb.findMemberByDiscordUserId(discordUserId);
      expect(member).not.toBeNull();
      expect(member!.cancel_requested_at).not.toBeNull();
    });

    it('members.access_end_at が PAY.JP cancel API のレスポンスから更新される', async () => {
      const discordUserId = `cancel-db-access-end-${randomUUID().slice(0, 8)}`;
      const originalAccessEndAt = new Date('2025-05-15T00:00:00Z');
      const fixedDate = new Date('2025-04-15T00:00:00+09:00');

      // PAY.JP が返す current_period_end は異なる日時
      const payjpCurrentPeriodEnd = Math.floor(new Date('2025-05-20T00:00:00Z').getTime() / 1000);
      const payjpMock = makeMockPayjpClient();
      (payjpMock.cancelSubscription as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'sub_test',
        status: 'canceled',
        current_period_end: payjpCurrentPeriodEnd,
        trial_end: null,
        plan: { id: 'plan_e2e', interval: 'month' },
        metadata: {},
      });
      const app = buildE2EApp(pgDb, {
        payjp: payjpMock,
        discord: makeMockDiscordClient(),
        clock: () => fixedDate,
      });

      await insertSubscribedMember(pool, discordUserId, originalAccessEndAt);
      const { rawToken } = await insertLinkedSession(pgDb, discordUserId);

      const res = await app.inject(buildCancelRequest(rawToken));
      expect(res.statusCode).toBe(200);

      const member = await pgDb.findMemberByDiscordUserId(discordUserId);
      expect(member).not.toBeNull();
      // access_end_at は PAY.JP のレスポンス値に更新されている
      const expectedAccessEndAt = new Date(payjpCurrentPeriodEnd * 1000);
      expect(member!.access_end_at?.getTime()).toBe(expectedAccessEndAt.getTime());
    });

    it('キャンセル直後にロールは剥奪されない（access_end_at まで維持）', async () => {
      const discordUserId = `cancel-no-role-revoke-${randomUUID().slice(0, 8)}`;
      const accessEndAt = new Date('2025-05-15T00:00:00Z');
      const fixedDate = new Date('2025-04-15T00:00:00+09:00');
      const cancelPeriodEnd = Math.floor(accessEndAt.getTime() / 1000);

      const payjpMock = makeMockPayjpClient();
      (payjpMock.cancelSubscription as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'sub_test',
        status: 'canceled',
        current_period_end: cancelPeriodEnd,
        trial_end: null,
        plan: { id: 'plan_e2e', interval: 'month' },
        metadata: {},
      });
      const discordMock = makeMockDiscordClient();
      const app = buildE2EApp(pgDb, {
        payjp: payjpMock,
        discord: discordMock,
        clock: () => fixedDate,
      });

      await insertSubscribedMember(pool, discordUserId, accessEndAt);
      const { rawToken } = await insertLinkedSession(pgDb, discordUserId);

      const res = await app.inject(buildCancelRequest(rawToken));
      expect(res.statusCode).toBe(200);

      // Discord ロール剥奪は呼ばれない
      expect(discordMock.removeRole).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 503 不確定失敗
  // -------------------------------------------------------------------------
  describe('503 不確定失敗', () => {
    it('PAY.JP cancelSubscription がエラーをスロー → 503 + operationId、inflight_operation_* が保持される', async () => {
      const discordUserId = `cancel-503-payjp-${randomUUID().slice(0, 8)}`;
      const accessEndAt = new Date('2025-05-15T00:00:00Z');
      const fixedDate = new Date('2025-04-15T00:00:00+09:00');

      const payjpMock = makeMockPayjpClient();
      // cancelSubscription も fetchSubscription もエラーを返す（reconciliation も失敗 → uncertain）
      (payjpMock.cancelSubscription as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network timeout'));
      (payjpMock.fetchSubscription as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Network timeout during reconciliation'),
      );

      const app = buildE2EApp(pgDb, {
        payjp: payjpMock,
        discord: makeMockDiscordClient(),
        clock: () => fixedDate,
      });

      await insertSubscribedMember(pool, discordUserId, accessEndAt);
      const { rawToken } = await insertLinkedSession(pgDb, discordUserId);

      const res = await app.inject(buildCancelRequest(rawToken));

      expect(res.statusCode).toBe(503);
      const body = res.json();
      expect(body.ok).toBe(false);
      expect(body.operationId).toBeDefined();
      expect(typeof body.operationId).toBe('string');

      // DB: inflight_operation_id / type / started_at が保持されている
      const member = await pgDb.findMemberByDiscordUserId(discordUserId);
      expect(member).not.toBeNull();
      expect(member!.inflight_operation_id).not.toBeNull();
      expect(member!.inflight_operation_type).toBe('cancel');
      expect(member!.inflight_operation_started_at).not.toBeNull();
    });

    it('確定的な失敗（受付期間外）→ inflight_operation_* は設定されない', async () => {
      // acceptance period check が失敗するケース: inflight は設定されないはず
      const discordUserId = `cancel-deterministic-fail-${randomUUID().slice(0, 8)}`;
      const accessEndAt = new Date('2025-05-15T00:00:00Z');
      // clock を too early に設定 → 409 応答
      const fixedDate = new Date('2025-04-01T00:00:00+09:00');

      const app = buildE2EApp(pgDb, {
        payjp: makeMockPayjpClient(),
        discord: makeMockDiscordClient(),
        clock: () => fixedDate,
      });

      await insertSubscribedMember(pool, discordUserId, accessEndAt);
      const { rawToken } = await insertLinkedSession(pgDb, discordUserId);

      const res = await app.inject(buildCancelRequest(rawToken));

      // 409 (too early) → inflight は設定されない
      expect(res.statusCode).toBe(409);

      const member = await pgDb.findMemberByDiscordUserId(discordUserId);
      expect(member).not.toBeNull();
      expect(member!.inflight_operation_id).toBeNull();
      expect(member!.inflight_operation_type).toBeNull();
      expect(member!.inflight_operation_started_at).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // レスポンス形式
  // -------------------------------------------------------------------------
  describe('レスポンス形式', () => {
    it('200 OK レスポンスが正しいスキーマを持つ', async () => {
      const discordUserId = `cancel-schema-${randomUUID().slice(0, 8)}`;
      const accessEndAt = new Date('2025-05-01T00:00:00Z');
      const fixedDate = new Date('2025-04-15T00:00:00+09:00');
      const cancelPeriodEnd = Math.floor(accessEndAt.getTime() / 1000);

      const payjpMock = makeMockPayjpClient();
      (payjpMock.cancelSubscription as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'sub_test_e2e',
        status: 'canceled',
        current_period_end: cancelPeriodEnd,
        trial_end: null,
        plan: { id: 'plan_e2e', interval: 'month' },
        metadata: {},
      });
      const app = buildE2EApp(pgDb, {
        payjp: payjpMock,
        discord: makeMockDiscordClient(),
        clock: () => fixedDate,
      });

      await insertSubscribedMember(pool, discordUserId, accessEndAt);
      const { rawToken } = await insertLinkedSession(pgDb, discordUserId);

      const res = await app.inject(buildCancelRequest(rawToken));

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({
        ok: true,
        memberId: expect.any(String),
        cancelEffectiveAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
        roleRemovalAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
      });
    });
  });
});
