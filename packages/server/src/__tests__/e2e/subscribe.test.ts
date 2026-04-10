/**
 * E2E テスト — 購読作成フロー (Issue #38, T-P0-02)
 *
 * カバレッジ:
 *   - Trial 判定: 初回ユーザー（charge + trial）/ 非初回ユーザー（trial 非適用）/ 退会後再加入
 *   - Plan 検証: 許可プラン3種 / 未知プラン
 *   - 3DS 検証: verified 以外のステータスはすべて 422
 *   - セキュリティ — Origin: 未指定 / 不一致 / null / ポート違い
 *   - Session: Cookie なし / 期限切れ / 消費済み
 *   - Discord ギルドメンバーシップ: 非メンバー / ロール付与不可
 *   - 冪等性 / inflight ガード: inflight 中 / 既存 active / trial / canceled(access_end_at 有効)
 *   - DB 永続化: 各フィールド保存確認 / mock 呼び出し引数検証
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
  E2E_BILLING_CONFIG,
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

const SUBSCRIBE_URL = '/v1/subscriptions';
const VALID_ORIGIN = 'https://example.com';

// ---------------------------------------------------------------------------
// ユーティリティ
// ---------------------------------------------------------------------------

/** POST /v1/subscriptions のリクエストを組み立てる */
function buildSubscribeRequest(
  rawToken: string,
  overrides: {
    planId?: string;
    email?: string;
    payjpToken?: string;
    privacyConsented?: boolean;
    origin?: string;
  } = {},
) {
  const {
    planId = E2E_BILLING_CONFIG.allowedPlanIds[0],
    email = 'test@example.com',
    payjpToken = 'tok_test_e2e',
    privacyConsented = true,
    origin = VALID_ORIGIN,
  } = overrides;

  return {
    method: 'POST' as const,
    url: SUBSCRIBE_URL,
    headers: { 'content-type': 'application/json', origin },
    cookies: { '__Host-link_session': rawToken },
    body: JSON.stringify({ planId, email, payjpToken, privacyConsented }),
  };
}

// ---------------------------------------------------------------------------
// テストスイート
// ---------------------------------------------------------------------------

const hasTestDb = Boolean(TEST_DB_URL);

describe.skipIf(!hasTestDb)('E2E Subscribe — T-P0-02', () => {
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
  // Trial 判定
  // -------------------------------------------------------------------------
  describe('Trial 判定', () => {
    it('初回ユーザー → charge 作成 + trial subscription → trialApplied: true', async () => {
      const discordUserId = `uid-trial-first-${randomUUID()}`;
      const payjpMock = makeMockPayjpClient();
      const discordMock = makeMockDiscordClient();
      const app = buildE2EApp(pgDb, { payjp: payjpMock, discord: discordMock });

      const { rawToken } = await insertLinkedSession(pgDb, discordUserId);
      const res = await app.inject(buildSubscribeRequest(rawToken));

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.trialApplied).toBe(true);
      expect(body.subscriptionStatus).toBe('trial');
      expect(payjpMock.createCharge).toHaveBeenCalledOnce();
      expect(payjpMock.createSubscription).toHaveBeenCalledOnce();
    });

    it('非初回ユーザー（first_trial_granted_at 設定済み）→ subscription のみ（charge なし）→ trialApplied: false', async () => {
      const discordUserId = `uid-trial-not-first-${randomUUID()}`;
      const payjpMock = makeMockPayjpClient();
      // trial 非適用：trial_end なし
      (payjpMock.createSubscription as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'sub_test_e2e',
        status: 'active',
        current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
        trial_end: null,
        plan: { id: E2E_BILLING_CONFIG.allowedPlanIds[0], interval: 'month' },
        metadata: {},
      });

      const discordMock = makeMockDiscordClient();
      const app = buildE2EApp(pgDb, { payjp: payjpMock, discord: discordMock });

      // 既存メンバー: first_trial_granted_at 設定済み、subscription_status = deleted
      await pool.query(
        `INSERT INTO members (id, discord_user_id, email, subscription_status, first_trial_granted_at, payjp_customer_id)
         VALUES ($1, $2, $3, 'deleted', NOW(), 'cus_test_e2e')`,
        [randomUUID(), discordUserId, `${discordUserId}@e2e.test`],
      );

      const { rawToken } = await insertLinkedSession(pgDb, discordUserId);
      const res = await app.inject(buildSubscribeRequest(rawToken));

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.trialApplied).toBe(false);
      // charge は不要（既存カスタマーへの subscription のみ）
      expect(payjpMock.createCharge).not.toHaveBeenCalled();
      expect(payjpMock.createSubscription).toHaveBeenCalledOnce();
    });

    it('退会後再加入 → first_trial_granted_at が保持され trial は再適用されない', async () => {
      const discordUserId = `uid-rejoin-${randomUUID()}`;
      const payjpMock = makeMockPayjpClient();
      (payjpMock.createSubscription as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'sub_test_e2e',
        status: 'active',
        current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
        trial_end: null,
        plan: { id: E2E_BILLING_CONFIG.allowedPlanIds[0], interval: 'month' },
        metadata: {},
      });

      const discordMock = makeMockDiscordClient();
      const app = buildE2EApp(pgDb, { payjp: payjpMock, discord: discordMock });

      await pool.query(
        `INSERT INTO members (id, discord_user_id, email, subscription_status, first_trial_granted_at, payjp_customer_id)
         VALUES ($1, $2, $3, 'deleted', NOW() - INTERVAL '60 days', 'cus_test_e2e')`,
        [randomUUID(), discordUserId, `${discordUserId}@e2e.test`],
      );

      const { rawToken } = await insertLinkedSession(pgDb, discordUserId);
      const res = await app.inject(buildSubscribeRequest(rawToken));

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.trialApplied).toBe(false);

      // DB: first_trial_granted_at が古い値のまま保持されている（再設定されていない）
      const member = await pgDb.findMemberByDiscordUserId(discordUserId);
      expect(member).not.toBeNull();
      // 60日以上前の値であることを確認（再設定された場合は直近になる）
      const trialGrantedAt = member!.first_trial_granted_at;
      expect(trialGrantedAt).not.toBeNull();
      const diffDays = (Date.now() - trialGrantedAt!.getTime()) / (1000 * 86400);
      expect(diffDays).toBeGreaterThan(50);
    });
  });

  // -------------------------------------------------------------------------
  // Plan 検証
  // -------------------------------------------------------------------------
  describe('Plan 検証', () => {
    it('Plan A (plan_e2e) → 200', async () => {
      const discordUserId = `uid-plan-a-${randomUUID()}`;
      const app = buildE2EApp(pgDb, { payjp: makeMockPayjpClient(), discord: makeMockDiscordClient() });
      const { rawToken } = await insertLinkedSession(pgDb, discordUserId);

      const res = await app.inject(buildSubscribeRequest(rawToken, { planId: 'plan_e2e' }));

      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
    });

    it('Plan B (plan_e2e_standard) → 200', async () => {
      const discordUserId = `uid-plan-b-${randomUUID()}`;
      const payjpMock = makeMockPayjpClient();
      (payjpMock.createSubscription as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'sub_test_e2e',
        status: 'trial',
        current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
        trial_end: Math.floor(Date.now() / 1000) + 30 * 86400,
        plan: { id: 'plan_e2e_standard', interval: 'month' },
        metadata: {},
      });
      const app = buildE2EApp(pgDb, { payjp: payjpMock, discord: makeMockDiscordClient() });
      const { rawToken } = await insertLinkedSession(pgDb, discordUserId);

      const res = await app.inject(buildSubscribeRequest(rawToken, { planId: 'plan_e2e_standard' }));

      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
    });

    it('Plan C (plan_e2e_premium) → 200', async () => {
      const discordUserId = `uid-plan-c-${randomUUID()}`;
      const payjpMock = makeMockPayjpClient();
      (payjpMock.createSubscription as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'sub_test_e2e',
        status: 'trial',
        current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
        trial_end: Math.floor(Date.now() / 1000) + 30 * 86400,
        plan: { id: 'plan_e2e_premium', interval: 'month' },
        metadata: {},
      });
      const app = buildE2EApp(pgDb, { payjp: payjpMock, discord: makeMockDiscordClient() });
      const { rawToken } = await insertLinkedSession(pgDb, discordUserId);

      const res = await app.inject(buildSubscribeRequest(rawToken, { planId: 'plan_e2e_premium' }));

      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
    });

    it('未知の planId → 422', async () => {
      const discordUserId = `uid-plan-unknown-${randomUUID()}`;
      const app = buildE2EApp(pgDb, { payjp: makeMockPayjpClient(), discord: makeMockDiscordClient() });
      const { rawToken } = await insertLinkedSession(pgDb, discordUserId);

      const res = await app.inject(buildSubscribeRequest(rawToken, { planId: 'plan_unknown_xyz' }));

      expect(res.statusCode).toBe(422);
      expect(res.json().ok).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 3DS 検証
  // -------------------------------------------------------------------------
  describe('3DS 検証', () => {
    async function assert3dsRejected(three_d_secure_status: string | null, usedOverride?: boolean): Promise<void> {
      const discordUserId = `uid-3ds-${randomUUID()}`;
      const payjpMock = makeMockPayjpClient();
      (payjpMock.fetchToken as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'tok_test_e2e',
        used: usedOverride ?? false,
        three_d_secure_status,
        card: { id: 'car_test_e2e' },
      });
      const app = buildE2EApp(pgDb, { payjp: payjpMock, discord: makeMockDiscordClient() });
      const { rawToken } = await insertLinkedSession(pgDb, discordUserId);

      const res = await app.inject(buildSubscribeRequest(rawToken));

      expect(res.statusCode).toBe(422);
      expect(res.json().ok).toBe(false);
    }

    it('three_d_secure_status: "attempted" → 422', async () => {
      await assert3dsRejected('attempted');
    });

    it('three_d_secure_status: "failed" → 422', async () => {
      await assert3dsRejected('failed');
    });

    it('three_d_secure_status: "error" → 422', async () => {
      await assert3dsRejected('error');
    });

    it('three_d_secure_status: "unverified" → 422', async () => {
      await assert3dsRejected('unverified');
    });

    it('three_d_secure_status: null → 422', async () => {
      await assert3dsRejected(null);
    });

    it('used: true → 422（使用済みトークン）', async () => {
      const discordUserId = `uid-3ds-used-${randomUUID()}`;
      const payjpMock = makeMockPayjpClient();
      (payjpMock.fetchToken as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'tok_test_e2e',
        used: true,
        three_d_secure_status: 'verified',
        card: { id: 'car_test_e2e' },
      });
      const app = buildE2EApp(pgDb, { payjp: payjpMock, discord: makeMockDiscordClient() });
      const { rawToken } = await insertLinkedSession(pgDb, discordUserId);

      const res = await app.inject(buildSubscribeRequest(rawToken));

      expect(res.statusCode).toBe(422);
      expect(res.json().ok).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // セキュリティ — Origin
  // -------------------------------------------------------------------------
  describe('セキュリティ — Origin', () => {
    it('Origin ヘッダなし（空文字列）→ 403', async () => {
      const discordUserId = `uid-origin-missing-${randomUUID()}`;
      const app = buildE2EApp(pgDb, { payjp: makeMockPayjpClient(), discord: makeMockDiscordClient() });
      const { rawToken } = await insertLinkedSession(pgDb, discordUserId);

      const res = await app.inject({
        method: 'POST',
        url: SUBSCRIBE_URL,
        headers: { 'content-type': 'application/json' },
        cookies: { '__Host-link_session': rawToken },
        body: JSON.stringify({
          planId: E2E_BILLING_CONFIG.allowedPlanIds[0],
          email: 'test@example.com',
          payjpToken: 'tok_test_e2e',
          privacyConsented: true,
        }),
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().ok).toBe(false);
    });

    it('Origin 不一致 (https://evil.com) → 403', async () => {
      const discordUserId = `uid-origin-mismatch-${randomUUID()}`;
      const app = buildE2EApp(pgDb, { payjp: makeMockPayjpClient(), discord: makeMockDiscordClient() });
      const { rawToken } = await insertLinkedSession(pgDb, discordUserId);

      const res = await app.inject(buildSubscribeRequest(rawToken, { origin: 'https://evil.com' }));

      expect(res.statusCode).toBe(403);
      expect(res.json().ok).toBe(false);
    });

    it('Origin: "null"（文字列）→ 403', async () => {
      const discordUserId = `uid-origin-null-${randomUUID()}`;
      const app = buildE2EApp(pgDb, { payjp: makeMockPayjpClient(), discord: makeMockDiscordClient() });
      const { rawToken } = await insertLinkedSession(pgDb, discordUserId);

      const res = await app.inject(buildSubscribeRequest(rawToken, { origin: 'null' }));

      expect(res.statusCode).toBe(403);
      expect(res.json().ok).toBe(false);
    });

    it('Origin ポート違い (https://example.com:8443) → 403', async () => {
      const discordUserId = `uid-origin-port-${randomUUID()}`;
      const app = buildE2EApp(pgDb, { payjp: makeMockPayjpClient(), discord: makeMockDiscordClient() });
      const { rawToken } = await insertLinkedSession(pgDb, discordUserId);

      const res = await app.inject(buildSubscribeRequest(rawToken, { origin: 'https://example.com:8443' }));

      expect(res.statusCode).toBe(403);
      expect(res.json().ok).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Session 検証
  // -------------------------------------------------------------------------
  describe('Session 検証', () => {
    it('__Host-link_session Cookie なし → 401', async () => {
      const app = buildE2EApp(pgDb, { payjp: makeMockPayjpClient(), discord: makeMockDiscordClient() });

      const res = await app.inject({
        method: 'POST',
        url: SUBSCRIBE_URL,
        headers: { 'content-type': 'application/json', origin: VALID_ORIGIN },
        body: JSON.stringify({
          planId: E2E_BILLING_CONFIG.allowedPlanIds[0],
          email: 'test@example.com',
          payjpToken: 'tok_test_e2e',
          privacyConsented: true,
        }),
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().ok).toBe(false);
    });

    it('期限切れ link_session → 401', async () => {
      const discordUserId = `uid-session-expired-${randomUUID()}`;
      const app = buildE2EApp(pgDb, { payjp: makeMockPayjpClient(), discord: makeMockDiscordClient() });
      // expiresIn を負値にして期限切れセッションを挿入する
      const { rawToken } = await insertLinkedSession(pgDb, discordUserId, undefined, -1);

      const res = await app.inject(buildSubscribeRequest(rawToken));

      expect(res.statusCode).toBe(401);
      expect(res.json().ok).toBe(false);
    });

    it('消費済み link_session（1回目成功後に同一トークンで再試行）→ 401 かつ 2回目は PAY.JP API 未呼び出し', async () => {
      const discordUserId = `uid-session-consumed-${randomUUID()}`;
      const payjpMock = makeMockPayjpClient();
      const discordMock = makeMockDiscordClient();
      const app = buildE2EApp(pgDb, { payjp: payjpMock, discord: discordMock });

      const { rawToken } = await insertLinkedSession(pgDb, discordUserId);

      // 1回目: 正常完了（link_session が消費される）
      const firstRes = await app.inject(buildSubscribeRequest(rawToken));
      expect(firstRes.statusCode).toBe(200);

      const callCountBefore = (payjpMock.fetchToken as ReturnType<typeof vi.fn>).mock.calls.length;

      // 2回目: 同じトークンで再試行
      const secondRes = await app.inject(buildSubscribeRequest(rawToken));

      expect(secondRes.statusCode).toBe(401);
      expect(secondRes.json().ok).toBe(false);
      // PAY.JP API が 2回目では追加呼び出しされていないこと
      expect((payjpMock.fetchToken as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callCountBefore);
    });
  });

  // -------------------------------------------------------------------------
  // Discord ギルドメンバーシップ
  // -------------------------------------------------------------------------
  describe('Discord ギルドメンバーシップ', () => {
    it('ギルド非メンバー → 409 かつ PAY.JP API 未呼び出し', async () => {
      const discordUserId = `uid-not-member-${randomUUID()}`;
      const payjpMock = makeMockPayjpClient();
      const discordMock = makeMockDiscordClient();
      (discordMock.checkMembership as ReturnType<typeof vi.fn>).mockResolvedValue({
        isMember: false,
        canAssignRole: false,
      });
      const app = buildE2EApp(pgDb, { payjp: payjpMock, discord: discordMock });

      const { rawToken } = await insertLinkedSession(pgDb, discordUserId);
      const res = await app.inject(buildSubscribeRequest(rawToken));

      expect(res.statusCode).toBe(409);
      expect(res.json().ok).toBe(false);
      expect(payjpMock.fetchToken).not.toHaveBeenCalled();
      expect(payjpMock.createCustomer).not.toHaveBeenCalled();
      expect(payjpMock.createCharge).not.toHaveBeenCalled();
      expect(payjpMock.createSubscription).not.toHaveBeenCalled();
    });

    it('Bot がロール付与不可 → 503 かつ PAY.JP API 未呼び出し', async () => {
      const discordUserId = `uid-cant-assign-${randomUUID()}`;
      const payjpMock = makeMockPayjpClient();
      const discordMock = makeMockDiscordClient();
      (discordMock.checkMembership as ReturnType<typeof vi.fn>).mockResolvedValue({
        isMember: true,
        canAssignRole: false,
      });
      const app = buildE2EApp(pgDb, { payjp: payjpMock, discord: discordMock });

      const { rawToken } = await insertLinkedSession(pgDb, discordUserId);
      const res = await app.inject(buildSubscribeRequest(rawToken));

      expect(res.statusCode).toBe(503);
      expect(res.json().ok).toBe(false);
      expect(payjpMock.fetchToken).not.toHaveBeenCalled();
      expect(payjpMock.createCustomer).not.toHaveBeenCalled();
      expect(payjpMock.createCharge).not.toHaveBeenCalled();
      expect(payjpMock.createSubscription).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 冪等性 / inflight ガード
  // -------------------------------------------------------------------------
  describe('冪等性 / inflight ガード', () => {
    it('inflight_operation_id が DB に存在 → 503 + 既存 operationId 返却、Cookie 未消費、PAY.JP 未呼び出し', async () => {
      const discordUserId = `uid-inflight-${randomUUID()}`;
      const existingOpId = 'existing-op-id';
      const payjpMock = makeMockPayjpClient();
      const discordMock = makeMockDiscordClient();
      const app = buildE2EApp(pgDb, { payjp: payjpMock, discord: discordMock });

      // inflight 状態のメンバーを事前に挿入する
      await pool.query(
        `INSERT INTO members (id, discord_user_id, email, subscription_status, inflight_operation_id, inflight_operation_type, inflight_operation_started_at)
         VALUES ($1, $2, $3, NULL, $4, 'subscribe', NOW())`,
        [randomUUID(), discordUserId, `${discordUserId}@e2e.test`, existingOpId],
      );

      const { rawToken } = await insertLinkedSession(pgDb, discordUserId);
      const res = await app.inject(buildSubscribeRequest(rawToken));

      expect(res.statusCode).toBe(503);
      const body = res.json();
      expect(body.ok).toBe(false);
      expect(body.operationId).toBe(existingOpId);

      // PAY.JP API が呼ばれていないこと
      expect(payjpMock.fetchToken).not.toHaveBeenCalled();
      expect(payjpMock.createCustomer).not.toHaveBeenCalled();
      expect(payjpMock.createCharge).not.toHaveBeenCalled();
      expect(payjpMock.createSubscription).not.toHaveBeenCalled();

      // link_session が消費されていないこと（同じトークンで再度セッション確認できる）
      const session = await pool.query('SELECT used_at FROM discord_link_sessions WHERE discord_user_id = $1', [
        discordUserId,
      ]);
      expect(session.rows[0].used_at).toBeNull();
    });

    it('既存 active subscription → 200 返却（新規 PAY.JP 呼び出しなし）', async () => {
      const discordUserId = `uid-existing-active-${randomUUID()}`;
      const payjpMock = makeMockPayjpClient();
      const discordMock = makeMockDiscordClient();
      const app = buildE2EApp(pgDb, { payjp: payjpMock, discord: discordMock });

      await pool.query(
        `INSERT INTO members (id, discord_user_id, email, subscription_status, payjp_customer_id, payjp_subscription_id, payjp_plan_id, access_end_at)
         VALUES ($1, $2, $3, 'active', 'cus_test_e2e', 'sub_test_e2e', 'plan_e2e', NOW() + INTERVAL '30 days')`,
        [randomUUID(), discordUserId, `${discordUserId}@e2e.test`],
      );

      const { rawToken } = await insertLinkedSession(pgDb, discordUserId);
      const res = await app.inject(buildSubscribeRequest(rawToken));

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      // 新規 PAY.JP 書き込み API が呼ばれていないこと
      expect(payjpMock.createCustomer).not.toHaveBeenCalled();
      expect(payjpMock.createCharge).not.toHaveBeenCalled();
      expect(payjpMock.createSubscription).not.toHaveBeenCalled();
    });

    it('既存 trial subscription → 200 返却（新規 PAY.JP 呼び出しなし）', async () => {
      const discordUserId = `uid-existing-trial-${randomUUID()}`;
      const payjpMock = makeMockPayjpClient();
      const discordMock = makeMockDiscordClient();
      const app = buildE2EApp(pgDb, { payjp: payjpMock, discord: discordMock });

      await pool.query(
        `INSERT INTO members (id, discord_user_id, email, subscription_status, payjp_customer_id, payjp_subscription_id, payjp_plan_id, access_end_at)
         VALUES ($1, $2, $3, 'trial', 'cus_test_e2e', 'sub_test_e2e', 'plan_e2e', NOW() + INTERVAL '30 days')`,
        [randomUUID(), discordUserId, `${discordUserId}@e2e.test`],
      );

      const { rawToken } = await insertLinkedSession(pgDb, discordUserId);
      const res = await app.inject(buildSubscribeRequest(rawToken));

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(payjpMock.createCustomer).not.toHaveBeenCalled();
      expect(payjpMock.createCharge).not.toHaveBeenCalled();
      expect(payjpMock.createSubscription).not.toHaveBeenCalled();
    });

    it('canceled かつ access_end_at が未来 → 200 返却（新規 PAY.JP 呼び出しなし）', async () => {
      const discordUserId = `uid-existing-canceled-future-${randomUUID()}`;
      const payjpMock = makeMockPayjpClient();
      const discordMock = makeMockDiscordClient();
      const app = buildE2EApp(pgDb, { payjp: payjpMock, discord: discordMock });

      await pool.query(
        `INSERT INTO members (id, discord_user_id, email, subscription_status, payjp_customer_id, payjp_subscription_id, payjp_plan_id, access_end_at)
         VALUES ($1, $2, $3, 'canceled', 'cus_test_e2e', 'sub_test_e2e', 'plan_e2e', NOW() + INTERVAL '15 days')`,
        [randomUUID(), discordUserId, `${discordUserId}@e2e.test`],
      );

      const { rawToken } = await insertLinkedSession(pgDb, discordUserId);
      const res = await app.inject(buildSubscribeRequest(rawToken));

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(payjpMock.createCustomer).not.toHaveBeenCalled();
      expect(payjpMock.createCharge).not.toHaveBeenCalled();
      expect(payjpMock.createSubscription).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // DB 永続化
  // -------------------------------------------------------------------------
  describe('DB 永続化', () => {
    it('成功後 — payjp_customer_id / payjp_initial_charge_id / payjp_subscription_id が保存される', async () => {
      const discordUserId = `uid-persist-ids-${randomUUID()}`;
      const app = buildE2EApp(pgDb, { payjp: makeMockPayjpClient(), discord: makeMockDiscordClient() });

      const { rawToken } = await insertLinkedSession(pgDb, discordUserId);
      const res = await app.inject(buildSubscribeRequest(rawToken));

      expect(res.statusCode).toBe(200);

      const member = await pgDb.findMemberByDiscordUserId(discordUserId);
      expect(member).not.toBeNull();
      expect(member!.payjp_customer_id).toBe('cus_test_e2e');
      expect(member!.payjp_initial_charge_id).toBe('ch_test_e2e');
      expect(member!.payjp_subscription_id).toBe('sub_test_e2e');
    });

    it('初回ユーザー — subscription_status が "trial" で保存される', async () => {
      const discordUserId = `uid-persist-status-${randomUUID()}`;
      const app = buildE2EApp(pgDb, { payjp: makeMockPayjpClient(), discord: makeMockDiscordClient() });

      const { rawToken } = await insertLinkedSession(pgDb, discordUserId);
      await app.inject(buildSubscribeRequest(rawToken));

      const member = await pgDb.findMemberByDiscordUserId(discordUserId);
      expect(member!.subscription_status).toBe('trial');
    });

    it('初回ユーザー — first_trial_granted_at が設定される', async () => {
      const discordUserId = `uid-persist-trial-at-${randomUUID()}`;
      const app = buildE2EApp(pgDb, { payjp: makeMockPayjpClient(), discord: makeMockDiscordClient() });

      const { rawToken } = await insertLinkedSession(pgDb, discordUserId);
      await app.inject(buildSubscribeRequest(rawToken));

      const member = await pgDb.findMemberByDiscordUserId(discordUserId);
      expect(member!.first_trial_granted_at).not.toBeNull();
      // 直近（1分以内）に設定されていること
      const diffMs = Date.now() - member!.first_trial_granted_at!.getTime();
      expect(diffMs).toBeLessThan(60_000);
    });

    it('access_end_at が subscription.current_period_end から設定される', async () => {
      const discordUserId = `uid-persist-access-end-${randomUUID()}`;
      const periodEnd = Math.floor(Date.now() / 1000) + 30 * 86400;
      const payjpMock = makeMockPayjpClient();
      (payjpMock.createSubscription as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'sub_test_e2e',
        status: 'trial',
        current_period_end: periodEnd,
        trial_end: periodEnd,
        plan: { id: E2E_BILLING_CONFIG.allowedPlanIds[0], interval: 'month' },
        metadata: {},
      });
      const app = buildE2EApp(pgDb, { payjp: payjpMock, discord: makeMockDiscordClient() });

      const { rawToken } = await insertLinkedSession(pgDb, discordUserId);
      await app.inject(buildSubscribeRequest(rawToken));

      const member = await pgDb.findMemberByDiscordUserId(discordUserId);
      expect(member!.access_end_at).not.toBeNull();
      // current_period_end ± 2秒の範囲にあること
      const accessEndUnix = Math.floor(member!.access_end_at!.getTime() / 1000);
      expect(Math.abs(accessEndUnix - periodEnd)).toBeLessThanOrEqual(2);
    });

    it('createCharge が metadata.discord_user_id と metadata.operation_id を含めて呼ばれる', async () => {
      const discordUserId = `uid-charge-meta-${randomUUID()}`;
      const payjpMock = makeMockPayjpClient();
      const app = buildE2EApp(pgDb, { payjp: payjpMock, discord: makeMockDiscordClient() });

      const { rawToken } = await insertLinkedSession(pgDb, discordUserId);
      await app.inject(buildSubscribeRequest(rawToken));

      expect(payjpMock.createCharge).toHaveBeenCalledOnce();
      const chargeArgs = (payjpMock.createCharge as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(chargeArgs.metadata).toMatchObject({
        discord_user_id: discordUserId,
        operation_id: expect.any(String),
      });
    });

    it('createSubscription が plan / metadata.discord_user_id / metadata.operation_id を含めて呼ばれる', async () => {
      const discordUserId = `uid-sub-meta-${randomUUID()}`;
      const planId = E2E_BILLING_CONFIG.allowedPlanIds[0];
      const payjpMock = makeMockPayjpClient();
      const app = buildE2EApp(pgDb, { payjp: payjpMock, discord: makeMockDiscordClient() });

      const { rawToken } = await insertLinkedSession(pgDb, discordUserId);
      await app.inject(buildSubscribeRequest(rawToken, { planId }));

      expect(payjpMock.createSubscription).toHaveBeenCalledOnce();
      const subArgs = (payjpMock.createSubscription as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(subArgs.plan ?? (subArgs as { planId?: string }).planId).toBe(planId);
      expect(subArgs.metadata).toMatchObject({
        discord_user_id: discordUserId,
        operation_id: expect.any(String),
      });
    });
  });
});
