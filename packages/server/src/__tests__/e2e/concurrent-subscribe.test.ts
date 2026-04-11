/**
 * E2E — 同時購読ガード（T-P0-03）Issue #39
 *
 * pg_advisory_lock による二重課金防止と既存サブスクリプション検出の検証。
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

const hasTestDb = Boolean(TEST_DB_URL);

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

function makeSubscribeBody(email: string, planId = E2E_BILLING_CONFIG.allowedPlanIds[0]) {
  return JSON.stringify({
    planId,
    email,
    payjpToken: 'tok_test_e2e',
    privacyConsented: true,
  });
}

async function postSubscribe(app: ReturnType<typeof buildE2EApp>, rawToken: string, email: string, planId?: string) {
  return app.inject({
    method: 'POST',
    url: '/v1/subscriptions',
    headers: {
      'content-type': 'application/json',
      origin: 'https://example.com',
    },
    cookies: { '__Host-link_session': rawToken },
    body: makeSubscribeBody(email, planId),
  });
}

// ---------------------------------------------------------------------------
// テストスイート
// ---------------------------------------------------------------------------

describe.skipIf(!hasTestDb)('E2E — 同時購読ガード（T-P0-03）', () => {
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
  // 並列リクエスト — pg_advisory_lock が二重課金を防ぐ
  // ---------------------------------------------------------------------------

  describe('並列リクエスト', () => {
    it('同一 discord_user_id への 2 並列リクエスト: charge/subscription は 1 回のみ、DB レコードも 1 件', async () => {
      const discordUserId = `concurrent-user-2-${randomUUID()}`;

      // 各リクエストに固有のリンクセッションが必要（消費される）
      const payjpMock = makeMockPayjpClient();
      const originalCreateCustomer = payjpMock.createCustomer;
      payjpMock.createCustomer = vi.fn().mockImplementation(async (...args: unknown[]) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return (originalCreateCustomer as (...a: unknown[]) => unknown)(...args);
      });

      const discordMock = makeMockDiscordClient();
      const app = buildE2EApp(pgDb, { payjp: payjpMock, discord: discordMock });

      const [session1, session2] = await Promise.all([
        insertLinkedSession(pgDb, discordUserId),
        insertLinkedSession(pgDb, discordUserId),
      ]);

      vi.mocked(payjpMock.createCharge).mockClear();
      vi.mocked(payjpMock.createSubscription).mockClear();
      vi.mocked(payjpMock.fetchToken).mockClear();
      vi.mocked(discordMock.assignRole).mockClear();
      vi.mocked(discordMock.checkMembership).mockClear();
      // createCustomer モックを再設定
      payjpMock.createCustomer = vi.fn().mockImplementation(async (...args: unknown[]) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return (originalCreateCustomer as (...a: unknown[]) => unknown)(...args);
      });

      const subscribeEmail = `${discordUserId}@e2e-concurrent.example.com`;
      const [res1, res2] = await Promise.all([
        postSubscribe(app, session1.rawToken, subscribeEmail),
        postSubscribe(app, session2.rawToken, subscribeEmail),
      ]);

      // non-blocking advisory lock のため、成功は 1 件のみで残りは LOCK_UNAVAILABLE(503)
      const responses = [res1, res2];
      const successResponses = responses.filter((res) => res.statusCode === 200);
      const lockUnavailableResponses = responses.filter((res) => res.statusCode === 503);

      expect(successResponses).toHaveLength(1);
      expect(lockUnavailableResponses).toHaveLength(1);
      for (const res of lockUnavailableResponses) {
        expect(res.json()).toMatchObject({ ok: false, errorCode: 'LOCK_UNAVAILABLE' });
      }

      // PAY.JP 課金・サブスクリプション作成はそれぞれ 1 回のみ
      expect(payjpMock.createCharge).toHaveBeenCalledOnce();
      expect(payjpMock.createSubscription).toHaveBeenCalledOnce();

      // DB に member は 1 件のみ
      const { rows } = await pool.query<{ cnt: number }>(
        'SELECT COUNT(*)::int AS cnt FROM members WHERE discord_user_id = $1',
        [discordUserId],
      );
      expect(rows[0].cnt).toBe(1);
    });

    it('同一 discord_user_id への 3 並列リクエスト: charge/subscription は 1 回のみ、DB レコードも 1 件', async () => {
      const discordUserId = `concurrent-user-3-${randomUUID()}`;

      const payjpMock = makeMockPayjpClient();
      const originalCreateCustomer = payjpMock.createCustomer;
      payjpMock.createCustomer = vi.fn().mockImplementation(async (...args: unknown[]) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return (originalCreateCustomer as (...a: unknown[]) => unknown)(...args);
      });

      const app = buildE2EApp(pgDb, { payjp: payjpMock, discord: makeMockDiscordClient() });

      const [session1, session2, session3] = await Promise.all([
        insertLinkedSession(pgDb, discordUserId),
        insertLinkedSession(pgDb, discordUserId),
        insertLinkedSession(pgDb, discordUserId),
      ]);

      vi.mocked(payjpMock.createCharge).mockClear();
      vi.mocked(payjpMock.createSubscription).mockClear();
      vi.mocked(payjpMock.fetchToken).mockClear();
      // createCustomer モックを再設定
      payjpMock.createCustomer = vi.fn().mockImplementation(async (...args: unknown[]) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return (originalCreateCustomer as (...a: unknown[]) => unknown)(...args);
      });

      const subscribeEmail = `${discordUserId}@e2e-concurrent.example.com`;
      const [res1, res2, res3] = await Promise.all([
        postSubscribe(app, session1.rawToken, subscribeEmail),
        postSubscribe(app, session2.rawToken, subscribeEmail),
        postSubscribe(app, session3.rawToken, subscribeEmail),
      ]);

      const responses = [res1, res2, res3];
      const successResponses = responses.filter((res) => res.statusCode === 200);
      const lockUnavailableResponses = responses.filter((res) => res.statusCode === 503);

      expect(successResponses).toHaveLength(1);
      expect(lockUnavailableResponses).toHaveLength(2);
      for (const res of lockUnavailableResponses) {
        expect(res.json()).toMatchObject({ ok: false, errorCode: 'LOCK_UNAVAILABLE' });
      }

      expect(payjpMock.createCharge).toHaveBeenCalledOnce();
      expect(payjpMock.createSubscription).toHaveBeenCalledOnce();

      const { rows } = await pool.query<{ cnt: number }>(
        'SELECT COUNT(*)::int AS cnt FROM members WHERE discord_user_id = $1',
        [discordUserId],
      );
      expect(rows[0].cnt).toBe(1);
    });

    it('最初のバッチ完了後、新規リクエストが正常に処理される（ロック解放確認）', async () => {
      const discordUserId = `lock-release-user-${randomUUID()}`;

      const payjpMock = makeMockPayjpClient();
      const originalCreateCustomer = payjpMock.createCustomer;
      payjpMock.createCustomer = vi.fn().mockImplementation(async (...args: unknown[]) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return (originalCreateCustomer as (...a: unknown[]) => unknown)(...args);
      });

      const app = buildE2EApp(pgDb, { payjp: payjpMock, discord: makeMockDiscordClient() });

      // バッチ 1: 2 並列
      const [s1, s2] = await Promise.all([
        insertLinkedSession(pgDb, discordUserId),
        insertLinkedSession(pgDb, discordUserId),
      ]);

      const subscribeEmail = `${discordUserId}@e2e-concurrent.example.com`;
      await Promise.all([
        postSubscribe(app, s1.rawToken, subscribeEmail),
        postSubscribe(app, s2.rawToken, subscribeEmail),
      ]);

      // バッチ 2: ロック解放後の単発リクエスト
      // 既にアクティブな購読があるためそれが返されるが、エラーではないことを確認
      const s3 = await insertLinkedSession(pgDb, discordUserId);
      const res = await postSubscribe(app, s3.rawToken, subscribeEmail);

      // ロックが正しく解放されていれば 200（既存サブスクリプション返却）
      // LOCK_UNAVAILABLE (503) にならないことを確認
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true });
    });
  });

  // ---------------------------------------------------------------------------
  // 既存サブスクリプションガード
  // ---------------------------------------------------------------------------

  describe('既存サブスクリプションガード', () => {
    it('active サブスクリプションが存在する場合: 既存情報を返し PAY.JP 呼び出しなし', async () => {
      const discordUserId = `existing-active-${randomUUID()}`;

      await pool.query(
        `INSERT INTO members (id, discord_user_id, email, subscription_status, payjp_customer_id, payjp_subscription_id, payjp_plan_id, access_end_at, first_trial_granted_at, role_state, last_synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + INTERVAL '30 days', NOW(), 'granted', NOW())`,
        [
          randomUUID(),
          discordUserId,
          `${discordUserId}@e2e-test.example.com`,
          'active',
          'cus_existing',
          'sub_existing',
          'plan_e2e',
        ],
      );

      const payjpMock = makeMockPayjpClient();
      const app = buildE2EApp(pgDb, { payjp: payjpMock, discord: makeMockDiscordClient() });

      const subscribeEmail = `${discordUserId}@e2e-test.example.com`;
      const { rawToken } = await insertLinkedSession(pgDb, discordUserId);
      const res = await postSubscribe(app, rawToken, subscribeEmail);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true });

      // 既存サブスクリプションがあるため PAY.JP への新規書き込みはなし
      expect(payjpMock.createCustomer).not.toHaveBeenCalled();
      expect(payjpMock.createCharge).not.toHaveBeenCalled();
      expect(payjpMock.createSubscription).not.toHaveBeenCalled();
    });

    it('trial サブスクリプションが存在する場合: 既存情報を返し PAY.JP 呼び出しなし', async () => {
      const discordUserId = `existing-trial-${randomUUID()}`;

      await pool.query(
        `INSERT INTO members (id, discord_user_id, email, subscription_status, payjp_customer_id, payjp_subscription_id, payjp_plan_id, access_end_at, first_trial_granted_at, role_state, last_synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + INTERVAL '30 days', NOW(), 'granted', NOW())`,
        [
          randomUUID(),
          discordUserId,
          `${discordUserId}@e2e-test.example.com`,
          'trial',
          'cus_existing',
          'sub_existing',
          'plan_e2e',
        ],
      );

      const payjpMock = makeMockPayjpClient();
      const app = buildE2EApp(pgDb, { payjp: payjpMock, discord: makeMockDiscordClient() });

      const subscribeEmail = `${discordUserId}@e2e-test.example.com`;
      const { rawToken } = await insertLinkedSession(pgDb, discordUserId);
      const res = await postSubscribe(app, rawToken, subscribeEmail);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true });

      expect(payjpMock.createCustomer).not.toHaveBeenCalled();
      expect(payjpMock.createCharge).not.toHaveBeenCalled();
      expect(payjpMock.createSubscription).not.toHaveBeenCalled();
    });

    it('canceled かつ access_end_at が未来の場合: 既存情報を返し PAY.JP 呼び出しなし', async () => {
      const discordUserId = `existing-canceled-active-${randomUUID()}`;

      await pool.query(
        `INSERT INTO members (id, discord_user_id, email, subscription_status, payjp_customer_id, payjp_subscription_id, payjp_plan_id, access_end_at, first_trial_granted_at, role_state, last_synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + INTERVAL '30 days', NOW(), 'revoked', NOW())`,
        [
          randomUUID(),
          discordUserId,
          `${discordUserId}@e2e-test.example.com`,
          'canceled',
          'cus_existing',
          'sub_existing',
          'plan_e2e',
        ],
      );

      const payjpMock = makeMockPayjpClient();
      const app = buildE2EApp(pgDb, { payjp: payjpMock, discord: makeMockDiscordClient() });

      const subscribeEmail = `${discordUserId}@e2e-test.example.com`;
      const { rawToken } = await insertLinkedSession(pgDb, discordUserId);
      const res = await postSubscribe(app, rawToken, subscribeEmail);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true });

      expect(payjpMock.createCustomer).not.toHaveBeenCalled();
      expect(payjpMock.createCharge).not.toHaveBeenCalled();
      expect(payjpMock.createSubscription).not.toHaveBeenCalled();
    });

    it('canceled かつ access_end_at が過去の場合（期限切れ）: 新規サブスクリプションを作成し trial なし', async () => {
      const discordUserId = `existing-canceled-expired-${randomUUID()}`;

      // first_trial_granted_at が設定済み（過去にトライアル済み）
      await pool.query(
        `INSERT INTO members (id, discord_user_id, email, subscription_status, payjp_customer_id, payjp_subscription_id, payjp_plan_id, access_end_at, first_trial_granted_at, role_state, last_synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() - INTERVAL '1 day', NOW() - INTERVAL '60 days', 'revoked', NOW())`,
        [
          randomUUID(),
          discordUserId,
          `${discordUserId}@e2e-test.example.com`,
          'canceled',
          'cus_existing',
          'sub_existing_expired',
          'plan_e2e',
        ],
      );

      const payjpMock = makeMockPayjpClient();
      const app = buildE2EApp(pgDb, { payjp: payjpMock, discord: makeMockDiscordClient() });

      const subscribeEmail = `${discordUserId}@e2e-test.example.com`;
      const { rawToken } = await insertLinkedSession(pgDb, discordUserId);
      const res = await postSubscribe(app, rawToken, subscribeEmail);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true });

      // 期限切れのため新規サブスクリプション作成が実行される
      expect(payjpMock.createSubscription).toHaveBeenCalledOnce();

      // 2 回目なのでトライアルなし（trial_end パラメータが渡されない）
      const subscriptionCallArgs = (payjpMock.createSubscription as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as Record<string, unknown>;
      expect(subscriptionCallArgs).not.toHaveProperty('trial_end');

      // 2 回目なので charge も発生しない（first_trial_granted_at が設定済み）
      expect(payjpMock.createCharge).not.toHaveBeenCalled();
    });
  });
});
