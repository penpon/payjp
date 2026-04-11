/**
 * E2E テスト — 購読ライフサイクル横断シナリオ (Issue #43)
 *
 * カバレッジ:
 *   1. フルライフサイクル: OAuth → Subscribe(trial) → Webhook(active) → Cancel → access_end_at 経過 → ロール剥奪
 *   2. 退会後再加入: 2 回目は trial 非適用
 *   3. 503 リカバリ → Cancel: クリーンな DB 状態
 *   4. inflight 中の Webhook 処理
 *   5. 同秒 Webhook シーケンス: active → canceled
 *   6. Cookie TTL 期限切れ: callback → 401、link_session 未生成
 *   7. プラン変更（退会後再加入）
 *   8. Webhook ステータス遷移: trial → active → paused → resumed(active)
 *   9. 日次 resync + Webhook 競合なし
 *  10. レートリミット検証: POST /v1/subscriptions に max=5 が設定されている
 *
 * 前提: DATABASE_URL_TEST または DATABASE_URL が設定済みの PostgreSQL に接続可能であること。
 */

import { randomUUID } from 'node:crypto';
import { runResyncCli } from '@hayane/sync-service';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildE2EApp,
  buildSyncDepsForE2E,
  closePool,
  createTestDb,
  E2E_BILLING_CONFIG,
  E2E_WEBHOOK_TOKEN,
  insertLinkedSession,
  makeCliDeps,
  makeMockDiscordClient,
  makeMockPayjpClient,
  makeWebhookEvent,
  type PgDbClient,
  TEST_DB_URL,
  truncateAll,
} from './helpers.js';

const hasTestDb = Boolean(TEST_DB_URL);

// ---------------------------------------------------------------------------
// ユーティリティ
// ---------------------------------------------------------------------------

/** POST /v1/subscriptions を送信する */
async function postSubscribe(
  app: ReturnType<typeof buildE2EApp>,
  linkToken: string,
  opts: { planId?: string; email?: string } = {},
) {
  const planId = opts.planId ?? E2E_BILLING_CONFIG.allowedPlanIds[0];
  const email = opts.email ?? 'lifecycle-test@e2e-test.example.com';
  return app.inject({
    method: 'POST',
    url: '/v1/subscriptions',
    headers: { 'content-type': 'application/json', origin: 'https://example.com' },
    cookies: { '__Host-link_session': linkToken },
    body: JSON.stringify({
      planId,
      email,
      payjpToken: 'tok_test_e2e',
      privacyConsented: true,
    }),
  });
}

/** POST /v1/subscriptions/cancel を送信する */
async function postCancel(app: ReturnType<typeof buildE2EApp>, linkToken: string) {
  return app.inject({
    method: 'POST',
    url: '/v1/subscriptions/cancel',
    headers: { 'content-type': 'application/json', origin: 'https://example.com' },
    cookies: { '__Host-link_session': linkToken },
  });
}

/** Webhook を送信して HTTP レスポンスを返す */
async function postWebhook(app: ReturnType<typeof buildE2EApp>, payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/v1/payjp/webhook',
    headers: {
      'content-type': 'application/json',
      'x-payjp-webhook-token': E2E_WEBHOOK_TOKEN,
    },
    payload,
  });
}

/** members テーブルから discord_user_id で 1 行取得する */
async function getMember(pool: pg.Pool, discordUserId: string): Promise<Record<string, unknown> | undefined> {
  const res = await pool.query('SELECT * FROM members WHERE discord_user_id = $1', [discordUserId]);
  return res.rows[0] as Record<string, unknown> | undefined;
}

// ---------------------------------------------------------------------------
// テストスイート
// ---------------------------------------------------------------------------

describe.skipIf(!hasTestDb)('E2E ライフサイクル横断シナリオ (Issue #43)', () => {
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

  // =========================================================================
  // シナリオ 1: フルライフサイクル
  // OAuth → Subscribe(trial) → Webhook(active) → Cancel → access_end_at 経過 → ロール剥奪
  // =========================================================================
  it('シナリオ 1: フルライフサイクル — trial 購読 → active → Cancel → 期限切れ → ロール剥奪', async () => {
    const discordUserId = `lc-full-${randomUUID().slice(0, 8)}`;
    const syncRole = vi.fn().mockResolvedValue(undefined);
    const payjpMock = makeMockPayjpClient();
    const discordMock = makeMockDiscordClient();
    const syncDeps = buildSyncDepsForE2E(pool, syncRole);
    const app = buildE2EApp(pgDb, { payjp: payjpMock, discord: discordMock, syncDeps });

    // Step 1: Subscribe (trial)
    const { rawToken: token1 } = await insertLinkedSession(pgDb, discordUserId);
    const subRes = await postSubscribe(app, token1);
    expect(subRes.statusCode).toBe(200);
    const subBody = subRes.json<{ ok: boolean; trialApplied: boolean; subscriptionStatus: string }>();
    expect(subBody.ok).toBe(true);
    expect(subBody.trialApplied).toBe(true);
    expect(subBody.subscriptionStatus).toBe('trial');

    // Step 2: Webhook subscription.updated → active でメンバーが active になる
    const webhookActiveEventId = `evnt_active_${randomUUID().slice(0, 8)}`;
    const webhookActive = makeWebhookEvent({
      id: webhookActiveEventId,
      type: 'subscription.updated',
      data: {
        id: 'sub_test_e2e',
        object: 'subscription',
        status: 'active',
        metadata: { discord_user_id: discordUserId },
        plan: { id: E2E_BILLING_CONFIG.allowedPlanIds[0] },
        current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
      },
    });
    const whRes = await postWebhook(app, webhookActive);
    expect(whRes.statusCode).toBe(200);

    const memberAfterWebhook = await getMember(pool, discordUserId);
    expect(memberAfterWebhook).toBeDefined();
    expect(memberAfterWebhook!.subscription_status).toBe('active');
    // active になったのでロール grant が呼ばれる（trial→active はステータス変化）
    expect(syncRole).toHaveBeenCalledWith(discordUserId, 'grant');
    syncRole.mockClear();

    // Step 3: Cancel リクエスト（新しい link_session が必要）
    const { rawToken: token2 } = await insertLinkedSession(pgDb, discordUserId);
    const cancelRes = await postCancel(app, token2);
    expect(cancelRes.statusCode).toBe(200);

    const memberAfterCancel = await getMember(pool, discordUserId);
    expect(memberAfterCancel!.cancel_requested_at).not.toBeNull();
    // キャンセル要求中はロール維持（revoke は呼ばれない）
    expect(syncRole).not.toHaveBeenCalledWith(discordUserId, 'revoke');

    // Step 4: access_end_at を過去に設定して CLI --all でロール剥奪
    await pool.query(
      "UPDATE members SET access_end_at = NOW() - INTERVAL '1 day', role_state = 'granted' WHERE discord_user_id = $1",
      [discordUserId],
    );

    const cliDeps = makeCliDeps(pool, {
      syncRole,
      getPayjpSubscription: vi.fn().mockResolvedValue({
        id: 'sub_test_e2e',
        status: 'canceled',
        metadata: { discord_user_id: discordUserId },
        current_period_end: Math.floor(Date.now() / 1000) - 86400,
      }),
    });
    const cliOutput = await runResyncCli(['--all'], cliDeps);
    expect(cliOutput.exitCode).toBe(0);

    // ロール剥奪が最終的に適用されること（期限内 canceled は grant と見なすため、最後の呼び出しが revoke である必要がある）
    const callsAfterCli = syncRole.mock.calls.filter(([uid]) => uid === discordUserId);
    expect(callsAfterCli.at(-1)).toEqual([discordUserId, 'revoke']);
    expect(syncRole).not.toHaveBeenCalledWith(discordUserId, 'grant');
  });

  // =========================================================================
  // シナリオ 2: 退会後再加入 — 2 回目は trial 非適用
  // =========================================================================
  it('シナリオ 2: 退会後再加入 — 2 回目は trial 非適用 (trialApplied=false)', async () => {
    const discordUserId = `lc-rejoin-${randomUUID().slice(0, 8)}`;
    const payjpMock = makeMockPayjpClient();
    const discordMock = makeMockDiscordClient();
    const app = buildE2EApp(pgDb, { payjp: payjpMock, discord: discordMock });

    // Step 1: 初回 Subscribe → trial
    const { rawToken: token1 } = await insertLinkedSession(pgDb, discordUserId);
    const firstSubRes = await postSubscribe(app, token1);
    expect(firstSubRes.statusCode).toBe(200);
    const firstBody = firstSubRes.json<{ trialApplied: boolean }>();
    expect(firstBody.trialApplied).toBe(true);

    // first_trial_granted_at が設定されていることを確認
    const memberAfterFirst = await getMember(pool, discordUserId);
    expect(memberAfterFirst!.first_trial_granted_at).not.toBeNull();
    expect(payjpMock.createCharge).toHaveBeenCalledOnce();

    // Step 2: access_end_at を過去に設定し canceled 状態にする（退会完了）
    await pool.query(
      `UPDATE members
         SET subscription_status = 'canceled',
             cancel_requested_at = NOW() - INTERVAL '35 days',
             access_end_at = NOW() - INTERVAL '1 day'
       WHERE discord_user_id = $1`,
      [discordUserId],
    );

    // Step 3: 再加入用の mock 設定（trial_end なし）
    (payjpMock.createSubscription as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'sub_rejoin',
      status: 'active',
      current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
      trial_end: null,
      plan: { id: E2E_BILLING_CONFIG.allowedPlanIds[0], interval: 'month' },
      metadata: {},
    });
    // createCharge は 2 回目呼ばれないはず → mockClear してカウントを 0 に戻す
    vi.mocked(payjpMock.createCharge).mockClear();

    // Step 4: 再加入 Subscribe
    const { rawToken: token2 } = await insertLinkedSession(pgDb, discordUserId);
    const secondSubRes = await postSubscribe(app, token2);
    expect(secondSubRes.statusCode).toBe(200);
    const secondBody = secondSubRes.json<{ trialApplied: boolean }>();
    expect(secondBody.trialApplied).toBe(false);

    // 2 回目は createCharge が呼ばれない
    expect(payjpMock.createCharge).not.toHaveBeenCalled();
    // createSubscription は trial_end なしで呼ばれていることを確認
    const createSubCalls = vi.mocked(payjpMock.createSubscription).mock.calls;
    const lastCall = createSubCalls[createSubCalls.length - 1][0] as Record<string, unknown>;
    expect(lastCall).not.toHaveProperty('trial_end');
  });

  // =========================================================================
  // シナリオ 3: 503 リカバリ → Cancel — クリーンな DB 状態
  // =========================================================================
  it('シナリオ 3: 503 リカバリ → Cancel — inflight なし・cancel_requested_at セット', async () => {
    const discordUserId = `lc-503-${randomUUID().slice(0, 8)}`;
    const payjpMock = makeMockPayjpClient();
    const discordMock = makeMockDiscordClient();

    // createSubscription をタイムアウトエラーにする
    const timeoutError = Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' });
    payjpMock.createSubscription = vi.fn().mockRejectedValue(timeoutError);

    const app = buildE2EApp(pgDb, { payjp: payjpMock, discord: discordMock });

    // Step 1: Subscribe → 503 + operationId
    const { rawToken: token1 } = await insertLinkedSession(pgDb, discordUserId);
    const res503 = await postSubscribe(app, token1);
    expect(res503.statusCode).toBe(503);
    const { operationId } = res503.json<{ operationId: string }>();
    expect(typeof operationId).toBe('string');
    expect(operationId.length).toBeGreaterThan(0);

    // DB に inflight が設定されていることを確認
    const memberAfter503 = await getMember(pool, discordUserId);
    expect(memberAfter503!.inflight_operation_id).toBe(operationId);
    expect(memberAfter503!.inflight_operation_type).toBe('subscribe');

    // Step 2: CLI --operation-id でリカバリ
    const cliDeps = makeCliDeps(pool, {
      listPayjpCharges: vi.fn().mockResolvedValue({
        data: [{ id: 'ch_recovered', metadata: { operation_id: operationId } }],
        has_more: false,
      }),
      createPayjpSubscription: vi.fn().mockResolvedValue({
        id: 'sub_recovered',
        status: 'active',
        current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
      }),
      getPayjpSubscription: vi.fn().mockResolvedValue({
        id: 'sub_recovered',
        status: 'active',
        metadata: { discord_user_id: discordUserId },
        current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
      }),
    });
    const cliOutput = await runResyncCli(['--operation-id', operationId], cliDeps);
    expect(cliOutput.exitCode).toBe(0);

    // inflight がクリアされていることを確認
    const memberAfterCli = await getMember(pool, discordUserId);
    expect(memberAfterCli!.inflight_operation_id).toBeNull();
    expect(memberAfterCli!.inflight_operation_type).toBeNull();
    expect(memberAfterCli!.payjp_subscription_id).toBe('sub_recovered');

    // Step 3: access_end_at を将来に設定して cancel が通るようにする
    await pool.query(
      "UPDATE members SET subscription_status = 'active', access_end_at = NOW() + INTERVAL '15 days' WHERE discord_user_id = $1",
      [discordUserId],
    );

    // Step 4: Cancel
    const { rawToken: token2 } = await insertLinkedSession(pgDb, discordUserId);
    // cancelSubscription の mock を正常応答に戻す
    payjpMock.cancelSubscription = vi.fn().mockResolvedValue({
      id: 'sub_recovered',
      status: 'canceled',
      current_period_end: Math.floor(Date.now() / 1000) + 15 * 86400,
      trial_end: null,
      plan: { id: E2E_BILLING_CONFIG.allowedPlanIds[0], interval: 'month' },
      metadata: {},
    });
    const cancelApp = buildE2EApp(pgDb, { payjp: payjpMock, discord: discordMock });
    const cancelRes = await postCancel(cancelApp, token2);
    expect(cancelRes.statusCode).toBe(200);

    // DB: cancel_requested_at がセット、inflight はなし
    const memberAfterCancel = await getMember(pool, discordUserId);
    expect(memberAfterCancel!.cancel_requested_at).not.toBeNull();
    expect(memberAfterCancel!.inflight_operation_id).toBeNull();
  });

  // =========================================================================
  // シナリオ 4: inflight 中の Webhook 処理
  // =========================================================================
  it('シナリオ 4: inflight 中の Webhook — メンバーステータスが Webhook で更新される', async () => {
    const discordUserId = `lc-inflight-wh-${randomUUID().slice(0, 8)}`;
    const operationId = randomUUID();
    const memberId = randomUUID();

    // inflight 状態のメンバーを直接挿入
    await pool.query(
      `INSERT INTO members
         (id, discord_user_id, email, subscription_status,
          payjp_customer_id, payjp_subscription_id, payjp_plan_id,
          inflight_operation_id, inflight_operation_type, inflight_operation_started_at,
          role_state)
       VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, 'subscribe', NOW(), 'unknown')`,
      [
        memberId,
        discordUserId,
        `${discordUserId}@e2e-test.example.com`,
        'cus_test_e2e',
        'sub_test_e2e',
        E2E_BILLING_CONFIG.allowedPlanIds[0],
        operationId,
      ],
    );

    const syncRole = vi.fn().mockResolvedValue(undefined);
    const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool, syncRole) });

    // Webhook subscription.updated → active を送信
    const eventId = `evnt_inflight_${randomUUID().slice(0, 8)}`;
    const whRes = await postWebhook(
      app,
      makeWebhookEvent({
        id: eventId,
        type: 'subscription.updated',
        data: {
          id: 'sub_test_e2e',
          object: 'subscription',
          status: 'active',
          metadata: { discord_user_id: discordUserId },
          plan: { id: E2E_BILLING_CONFIG.allowedPlanIds[0] },
          current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
        },
      }),
    );
    expect(whRes.statusCode).toBe(200);

    // Webhook によってメンバーが active になっていることを確認
    const member = await getMember(pool, discordUserId);
    expect(member!.subscription_status).toBe('active');

    // inflight_operation_id は Webhook では消えない（CLI が担当）
    // → inflight が残っていても Webhook 処理は成功する
    const evtRow = await pool.query('SELECT processing_result FROM payjp_events WHERE id = $1', [eventId]);
    expect(evtRow.rows[0].processing_result).toBe('processed');
  });

  // =========================================================================
  // シナリオ 5: 同秒 Webhook シーケンス
  // active → canceled（後の Webhook が優先される）
  // =========================================================================
  it('シナリオ 5: 同秒 Webhook シーケンス — active → canceled、最終状態は canceled', async () => {
    const discordUserId = `lc-same-sec-${randomUUID().slice(0, 8)}`;
    const baseCreated = Math.floor(Date.now() / 1000);

    // active メンバーを直接挿入
    await pool.query(
      `INSERT INTO members
         (id, discord_user_id, email, subscription_status,
          payjp_customer_id, payjp_subscription_id, payjp_plan_id,
          last_payjp_event_created_at, role_state)
       VALUES ($1, $2, $3, 'active', $4, $5, $6, $7, 'granted')`,
      [
        randomUUID(),
        discordUserId,
        `${discordUserId}@e2e-test.example.com`,
        'cus_test_e2e',
        'sub_test_e2e',
        E2E_BILLING_CONFIG.allowedPlanIds[0],
        baseCreated - 100,
      ],
    );

    const syncRole = vi.fn().mockResolvedValue(undefined);
    const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool, syncRole) });

    // 1 つ目の Webhook: subscription.updated (active) — 同じ created タイムスタンプ
    const eventId1 = `evnt_same1_${randomUUID().slice(0, 8)}`;
    const whRes1 = await postWebhook(
      app,
      makeWebhookEvent({
        id: eventId1,
        type: 'subscription.updated',
        created: baseCreated,
        data: {
          id: 'sub_test_e2e',
          object: 'subscription',
          status: 'active',
          metadata: { discord_user_id: discordUserId },
          plan: { id: E2E_BILLING_CONFIG.allowedPlanIds[0] },
        },
      }),
    );
    expect(whRes1.statusCode).toBe(200);

    // 2 つ目の Webhook: subscription.canceled — 同じ created タイムスタンプ、異なる event.id
    const eventId2 = `evnt_same2_${randomUUID().slice(0, 8)}`;
    const whRes2 = await postWebhook(
      app,
      makeWebhookEvent({
        id: eventId2,
        type: 'subscription.canceled',
        created: baseCreated,
        data: {
          id: 'sub_test_e2e',
          object: 'subscription',
          status: 'canceled',
          metadata: { discord_user_id: discordUserId },
          plan: { id: E2E_BILLING_CONFIG.allowedPlanIds[0] },
          current_period_end: baseCreated + 15 * 86400,
        },
      }),
    );
    expect(whRes2.statusCode).toBe(200);

    // 最終状態: canceled（後から来た Webhook で上書き）
    const member = await getMember(pool, discordUserId);
    expect(member!.subscription_status).toBe('canceled');
  });

  // =========================================================================
  // シナリオ 6: Cookie TTL 期限切れ
  // =========================================================================
  it('シナリオ 6: Cookie TTL 期限切れ — callback → 401、link_session 未生成', async () => {
    const discordUserId = `lc-cookie-exp-${randomUUID().slice(0, 8)}`;
    const app = buildE2EApp(pgDb);

    // OAuth start
    const startRes = await app.inject({ method: 'GET', url: '/v1/auth/discord/start' });
    expect(startRes.statusCode).toBe(302);

    const setCookie = startRes.headers['set-cookie'] as string;
    const oauthSessionToken = setCookie.match(/__Host-oauth_session=([^;]+)/)![1];
    const stateToken = new URL(startRes.headers.location as string).searchParams.get('state')!;

    // oauth_states.expires_at を過去に設定する
    await pool.query("UPDATE oauth_states SET expires_at = NOW() - INTERVAL '1 hour'");

    // callback with expired state
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

    const callbackRes = await app.inject({
      method: 'GET',
      url: `/v1/auth/discord/callback?code=mock-code&state=${stateToken}`,
      cookies: { '__Host-oauth_session': oauthSessionToken },
    });

    // 期限切れ state → 401
    expect(callbackRes.statusCode).toBe(401);

    // link_session が作成されていないことを確認
    const linkSessions = await pool.query('SELECT COUNT(*)::int AS cnt FROM discord_link_sessions');
    expect(linkSessions.rows[0].cnt).toBe(0);

    mockFetch.mockRestore();
  });

  // =========================================================================
  // シナリオ 7: プラン変更（退会後再加入）
  // =========================================================================
  it('シナリオ 7: プラン変更 — plan_e2e → plan_e2e_standard', async () => {
    const discordUserId = `lc-planchange-${randomUUID().slice(0, 8)}`;
    const payjpMock = makeMockPayjpClient();
    const discordMock = makeMockDiscordClient();
    const app = buildE2EApp(pgDb, { payjp: payjpMock, discord: discordMock });

    // Step 1: 初回 Subscribe (plan_e2e)
    const { rawToken: token1 } = await insertLinkedSession(pgDb, discordUserId);
    const firstSubRes = await postSubscribe(app, token1, { planId: E2E_BILLING_CONFIG.allowedPlanIds[0] });
    expect(firstSubRes.statusCode).toBe(200);

    // Step 2: 退会完了状態にする
    await pool.query(
      `UPDATE members
         SET subscription_status = 'canceled',
             cancel_requested_at = NOW() - INTERVAL '35 days',
             access_end_at = NOW() - INTERVAL '1 day'
       WHERE discord_user_id = $1`,
      [discordUserId],
    );

    // Step 3: 再加入用 mock 設定（別プラン、trial_end なし）
    (payjpMock.createSubscription as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'sub_rejoin_std',
      status: 'active',
      current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
      trial_end: null,
      plan: { id: 'plan_e2e_standard', interval: 'month' },
      metadata: {},
    });

    // Step 4: 再加入 Subscribe (plan_e2e_standard)
    const { rawToken: token2 } = await insertLinkedSession(pgDb, discordUserId);
    const secondSubRes = await postSubscribe(app, token2, { planId: 'plan_e2e_standard' });
    expect(secondSubRes.statusCode).toBe(200);

    // members.payjp_plan_id が新プランになっていることを確認
    const member = await getMember(pool, discordUserId);
    expect(member!.payjp_plan_id).toBe('plan_e2e_standard');
  });

  // =========================================================================
  // シナリオ 8: Webhook ステータス遷移
  // trial → active → paused → resumed(active)
  // =========================================================================
  it('シナリオ 8: Webhook ステータス遷移 — trial → active → paused → resumed(active)', async () => {
    const discordUserId = `lc-transitions-${randomUUID().slice(0, 8)}`;
    const baseCreated = Math.floor(new Date('2025-05-01T10:00:00Z').getTime() / 1000);

    // trial メンバーを直接挿入
    await pool.query(
      `INSERT INTO members
         (id, discord_user_id, email, subscription_status,
          payjp_customer_id, payjp_subscription_id, payjp_plan_id,
          last_payjp_event_created_at, role_state)
       VALUES ($1, $2, $3, 'trial', $4, $5, $6, $7, 'granted')`,
      [
        randomUUID(),
        discordUserId,
        `${discordUserId}@e2e-test.example.com`,
        'cus_test_e2e',
        'sub_test_e2e',
        E2E_BILLING_CONFIG.allowedPlanIds[0],
        baseCreated - 500,
      ],
    );

    const syncRole = vi.fn().mockResolvedValue(undefined);
    const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool, syncRole) });

    // Webhook 1: trial → active
    const ev1 = `evnt_tr1_${randomUUID().slice(0, 8)}`;
    const wh1 = await postWebhook(
      app,
      makeWebhookEvent({
        id: ev1,
        type: 'subscription.updated',
        created: baseCreated,
        data: {
          id: 'sub_test_e2e',
          object: 'subscription',
          status: 'active',
          metadata: { discord_user_id: discordUserId },
          plan: { id: E2E_BILLING_CONFIG.allowedPlanIds[0] },
          current_period_end: baseCreated + 30 * 86400,
        },
      }),
    );
    expect(wh1.statusCode).toBe(200);
    const m1 = await getMember(pool, discordUserId);
    expect(m1!.subscription_status).toBe('active');
    expect(syncRole).toHaveBeenCalledWith(discordUserId, 'grant');
    syncRole.mockClear();

    // Webhook 2: active → paused
    const ev2 = `evnt_tr2_${randomUUID().slice(0, 8)}`;
    const wh2 = await postWebhook(
      app,
      makeWebhookEvent({
        id: ev2,
        type: 'subscription.paused',
        created: baseCreated + 100,
        data: {
          id: 'sub_test_e2e',
          object: 'subscription',
          status: 'paused',
          metadata: { discord_user_id: discordUserId },
          plan: { id: E2E_BILLING_CONFIG.allowedPlanIds[0] },
        },
      }),
    );
    expect(wh2.statusCode).toBe(200);
    const m2 = await getMember(pool, discordUserId);
    expect(m2!.subscription_status).toBe('paused');
    expect(syncRole).toHaveBeenCalledWith(discordUserId, 'revoke');
    syncRole.mockClear();

    // Webhook 3: paused → resumed (active)
    const ev3 = `evnt_tr3_${randomUUID().slice(0, 8)}`;
    const wh3 = await postWebhook(
      app,
      makeWebhookEvent({
        id: ev3,
        type: 'subscription.resumed',
        created: baseCreated + 200,
        data: {
          id: 'sub_test_e2e',
          object: 'subscription',
          status: 'active',
          metadata: { discord_user_id: discordUserId },
          plan: { id: E2E_BILLING_CONFIG.allowedPlanIds[0] },
          current_period_end: baseCreated + 60 * 86400,
        },
      }),
    );
    expect(wh3.statusCode).toBe(200);
    const m3 = await getMember(pool, discordUserId);
    expect(m3!.subscription_status).toBe('active');
    expect(syncRole).toHaveBeenCalledWith(discordUserId, 'grant');
  });

  // =========================================================================
  // シナリオ 9: 日次 resync + Webhook 競合なし
  // =========================================================================
  it('シナリオ 9: 日次 resync + Webhook — inflight セットなし、member は active のまま', async () => {
    const discordUserId = `lc-resync-wh-${randomUUID().slice(0, 8)}`;
    const futureTs = Math.floor(Date.now() / 1000) + 30 * 86400;

    // active メンバーを事前挿入
    await pool.query(
      `INSERT INTO members
         (id, discord_user_id, email, subscription_status,
          payjp_customer_id, payjp_subscription_id, payjp_plan_id,
          access_end_at, last_payjp_event_created_at, role_state)
       VALUES ($1, $2, $3, 'active', $4, $5, $6, NOW() + INTERVAL '30 days', $7, 'granted')`,
      [
        randomUUID(),
        discordUserId,
        `${discordUserId}@e2e-test.example.com`,
        'cus_test_e2e',
        'sub_test_e2e',
        E2E_BILLING_CONFIG.allowedPlanIds[0],
        Math.floor(Date.now() / 1000) - 100,
      ],
    );

    const syncRole = vi.fn().mockResolvedValue(undefined);
    const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool, syncRole) });

    // Step 1: Webhook subscription.updated (タイムスタンプ更新)
    const eventId = `evnt_rsync_${randomUUID().slice(0, 8)}`;
    const whRes = await postWebhook(
      app,
      makeWebhookEvent({
        id: eventId,
        type: 'subscription.updated',
        created: Math.floor(Date.now() / 1000),
        data: {
          id: 'sub_test_e2e',
          object: 'subscription',
          status: 'active',
          metadata: { discord_user_id: discordUserId },
          plan: { id: E2E_BILLING_CONFIG.allowedPlanIds[0] },
          current_period_end: futureTs,
        },
      }),
    );
    expect(whRes.statusCode).toBe(200);

    // Step 2: CLI --all resync
    const cliDeps = makeCliDeps(pool, {
      syncRole,
      getPayjpSubscription: vi.fn().mockResolvedValue({
        id: 'sub_test_e2e',
        status: 'active',
        metadata: { discord_user_id: discordUserId },
        current_period_end: futureTs,
      }),
    });
    const cliOutput = await runResyncCli(['--all'], cliDeps);
    expect(cliOutput.exitCode).toBe(0);

    // 結果確認: member は active のまま、inflight なし
    const member = await getMember(pool, discordUserId);
    expect(member!.subscription_status).toBe('active');
    expect(member!.inflight_operation_id).toBeNull();
  });

  // =========================================================================
  // シナリオ 10: レートリミット設定確認
  // =========================================================================
  it('シナリオ 10: POST /v1/subscriptions のレートリミットは max=5 に設定されている', async () => {
    // rate limit の max 設定を確認するため、実際に 6 回リクエストして 429 を得るか、
    // あるいはルート設定が存在することを確認する。
    // Fastify inject はリクエストごとに rate-limit カウンターを共有するので
    // 同一 IP から 6 回送信して 429 を確認する。
    const syncRole = vi.fn().mockResolvedValue(undefined);
    const payjpMock = makeMockPayjpClient();
    const discordMock = makeMockDiscordClient();
    const syncDeps = buildSyncDepsForE2E(pool, syncRole);
    const app = buildE2EApp(pgDb, { payjp: payjpMock, discord: discordMock, syncDeps });

    const statusCodes: number[] = [];

    for (let i = 0; i < 6; i++) {
      const discordUserId = `lc-rate-${i}-${randomUUID().slice(0, 8)}`;
      const { rawToken } = await insertLinkedSession(pgDb, discordUserId);
      // payjpMock の mock を毎回セット（重複呼び出しに備える）
      (payjpMock.createCustomer as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: `cus_rate_${i}`,
        metadata: {},
      });
      (payjpMock.createCharge as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: `ch_rate_${i}`,
        amount: 1000,
        paid: true,
        metadata: {},
      });
      (payjpMock.createSubscription as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: `sub_rate_${i}`,
        status: 'trial',
        current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
        trial_end: Math.floor(Date.now() / 1000) + 30 * 86400,
        plan: { id: E2E_BILLING_CONFIG.allowedPlanIds[0], interval: 'month' },
        metadata: {},
      });
      const res = await postSubscribe(app, rawToken, { email: `rate${i}@e2e-test.example.com` });
      statusCodes.push(res.statusCode);
    }

    // 最初の 5 件は 200、6 件目は 429
    expect(statusCodes.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statusCodes[5]).toBe(429);
  });
});
