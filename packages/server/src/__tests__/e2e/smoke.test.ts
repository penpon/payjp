/**
 * E2E スモークテスト — Issue #20
 *
 * ハーネスが正常動作することを確認する最小シナリオ。
 * - Smoke 1: OAuth start → callback → session(linked=true)
 * - Smoke 2: Subscribe 初回ユーザー → charge + trial subscription（Discord ロールは link-discord）
 *
 * 詳細 E2E シナリオは #37（OAuth/T-P0-01）・#38（Subscribe/T-P0-02）が担当。
 *
 * 前提: DATABASE_URL_TEST または DATABASE_URL が設定済みの PostgreSQL に接続可能であること。
 */

import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildE2EApp,
  buildSyncDepsForE2E,
  closePool,
  createTestDb,
  E2E_BILLING_CONFIG,
  E2E_WEBHOOK_TOKEN,
  makeMockDiscordClient,
  makeMockPayjpClient,
  type PgDbClient,
  TEST_DB_URL,
  truncateAll,
} from './helpers.js';

const hasTestDb = Boolean(TEST_DB_URL);

describe.skipIf(!hasTestDb)('E2E Smoke — ハーネス動作確認', () => {
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
  // Smoke 1: OAuth フロー
  // Discord OAuth の HTTP 呼び出しを vi.spyOn(fetch) でモック
  // ---------------------------------------------------------------------------
  describe('Smoke 1: OAuth flow', () => {
    it('start → callback → session が linked=true を返し、DB に link_session が書き込まれる', async () => {
      const app = buildE2EApp(pgDb);

      // Discord token exchange + user fetch をモック
      const mockFetch = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: 'mock_discord_token' }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ id: '111222333444555001' }),
        } as Response);

      try {
        // Step 1: OAuth start
        const startRes = await app.inject({ method: 'GET', url: '/v1/auth/discord/start' });
        expect(startRes.statusCode).toBe(302);

        const setCookie = startRes.headers['set-cookie'] as string;
        const sessionMatch = setCookie.match(/__Host-oauth_session=([^;]+)/);
        expect(sessionMatch).not.toBeNull();
        const oauthSessionToken = sessionMatch![1];

        const locationUrl = new URL(startRes.headers.location as string);
        const stateToken = locationUrl.searchParams.get('state');
        expect(stateToken).not.toBeNull();

        // Step 2: OAuth callback
        const callbackRes = await app.inject({
          method: 'GET',
          url: `/v1/auth/discord/callback?code=mock-code&state=${stateToken}`,
          cookies: { '__Host-oauth_session': oauthSessionToken },
        });
        expect(callbackRes.statusCode).toBe(302);
        expect(callbackRes.headers.location).toBe('https://example.com');

        const linkCookieHeader = callbackRes.headers['set-cookie'] as string;
        const linkMatch = linkCookieHeader.match(/__Host-link_session=([^;]+)/);
        expect(linkMatch).not.toBeNull();
        const linkSessionToken = linkMatch![1];

        // Step 3: Session 確認
        const sessionRes = await app.inject({
          method: 'GET',
          url: '/v1/auth/discord/session',
          cookies: { '__Host-link_session': linkSessionToken },
          headers: { origin: 'https://example.com' },
        });
        expect(sessionRes.statusCode).toBe(200);
        expect(sessionRes.json()).toEqual({
          linked: true,
          discordUserId: '111222333444555001',
        });

        // DB 確認: discord_link_sessions に 1 レコード書き込まれている
        const dbResult = await pool.query('SELECT COUNT(*)::int AS cnt FROM discord_link_sessions');
        expect(dbResult.rows[0].cnt).toBe(1);
      } finally {
        mockFetch.mockRestore();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Smoke 2: Subscribe フロー（課金先行 — link_session 不要）
  // ---------------------------------------------------------------------------
  describe('Smoke 2: Subscribe flow', () => {
    it('初回ユーザー → charge + trial subscription、DB に member が存在する（subscribe では Discord 未使用）', async () => {
      const payjpMock = makeMockPayjpClient();
      const discordMock = makeMockDiscordClient();
      const app = buildE2EApp(pgDb, { payjp: payjpMock, discord: discordMock });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/subscriptions',
        headers: {
          'content-type': 'application/json',
          origin: 'https://example.com',
        },
        body: JSON.stringify({
          planId: E2E_BILLING_CONFIG.allowedPlanIds[0],
          email: 'smoke-test@example.com',
          payjpToken: 'tok_test_e2e',
          privacyConsented: true,
        }),
      });

      expect(res.statusCode).toBe(200);

      const idRow = await pool.query<{ id: string }>('SELECT id FROM members WHERE email = $1', [
        'smoke-test@example.com',
      ]);
      expect(idRow.rows.length).toBe(1);
      const member = await pgDb.findMemberById(idRow.rows[0].id);
      expect(member).not.toBeNull();
      expect(['trial', 'active']).toContain(member!.subscription_status);
      expect(member!.payjp_subscription_id).toBe('sub_test_e2e');
      expect(member!.payjp_customer_id).toBe('cus_test_e2e');

      expect(discordMock.assignRole).not.toHaveBeenCalled();
      expect(discordMock.checkMembership).not.toHaveBeenCalled();

      expect(payjpMock.fetchToken).toHaveBeenCalledWith('tok_test_e2e');
      expect(payjpMock.createCustomer).toHaveBeenCalledOnce();
      expect(payjpMock.createSubscription).toHaveBeenCalledOnce();
    });
  });

  // ---------------------------------------------------------------------------
  // Scenarios 3-5: Webhook フロー
  // 実 PostgreSQL を使い、Webhook 受信 → DB 更新 の E2E を検証
  // ---------------------------------------------------------------------------
  describe('Webhook flow — Scenarios 3-5', () => {
    const WEBHOOK_DISCORD_USER_ID = '111222333444555010';
    const WEBHOOK_SUB_ID = 'sub_e2e_webhook_001';
    const NOW_UNIX = Math.floor(Date.now() / 1000);

    async function insertTestMember(
      overrides: { subscription_status?: string; last_payjp_event_created_at?: number } = {},
    ) {
      const { subscription_status = 'trial', last_payjp_event_created_at = NOW_UNIX - 1000 } = overrides;
      await pool.query(
        `INSERT INTO members (discord_user_id, email, subscription_status, payjp_subscription_id, last_payjp_event_created_at, role_state)
         VALUES ($1, $2, $3, $4, $5, 'unknown')`,
        [
          WEBHOOK_DISCORD_USER_ID,
          'webhook-e2e@example.com',
          subscription_status,
          WEBHOOK_SUB_ID,
          last_payjp_event_created_at,
        ],
      );
    }

    function makeWebhookEvent(topOverrides: Record<string, unknown> = {}, dataOverrides: Record<string, unknown> = {}) {
      return {
        id: 'evnt_e2e_webhook_001',
        type: 'subscription.updated',
        livemode: false,
        created: NOW_UNIX,
        ...topOverrides,
        data: {
          id: WEBHOOK_SUB_ID,
          object: 'subscription',
          status: 'active',
          metadata: { discord_user_id: WEBHOOK_DISCORD_USER_ID },
          plan: { id: E2E_BILLING_CONFIG.allowedPlanIds[0] },
          current_period_end: NOW_UNIX + 30 * 86400,
          ...dataOverrides,
        },
      };
    }

    it('Scenario 3: subscription.updated → members が更新され payjp_events にレコードが挿入される', async () => {
      await insertTestMember();
      const syncRole = vi.fn().mockResolvedValue(undefined);
      const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool, syncRole) });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/payjp/webhook',
        headers: {
          'content-type': 'application/json',
          'x-payjp-webhook-token': E2E_WEBHOOK_TOKEN,
        },
        payload: makeWebhookEvent(),
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });

      // payjp_events に processed レコードが挿入されている
      const events = await pool.query("SELECT processing_result FROM payjp_events WHERE id = 'evnt_e2e_webhook_001'");
      expect(events.rows).toHaveLength(1);
      expect(events.rows[0].processing_result).toBe('processed');

      // members の subscription_status が active に更新されている
      const member = await pgDb.findMemberByDiscordUserId(WEBHOOK_DISCORD_USER_ID);
      expect(member!.subscription_status).toBe('active');

      // syncRole が trial→active のロール付与で呼ばれた
      expect(syncRole).toHaveBeenCalledWith(WEBHOOK_DISCORD_USER_ID, 'grant');
    });

    it('Scenario 4: 同一 event.id の重複送信 → 二重処理なし（冪等）', async () => {
      await insertTestMember();
      const syncRole = vi.fn().mockResolvedValue(undefined);
      const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool, syncRole) });

      const payload = makeWebhookEvent();

      const res1 = await app.inject({
        method: 'POST',
        url: '/v1/payjp/webhook',
        headers: { 'content-type': 'application/json', 'x-payjp-webhook-token': E2E_WEBHOOK_TOKEN },
        payload,
      });
      const res2 = await app.inject({
        method: 'POST',
        url: '/v1/payjp/webhook',
        headers: { 'content-type': 'application/json', 'x-payjp-webhook-token': E2E_WEBHOOK_TOKEN },
        payload,
      });

      expect(res1.statusCode).toBe(200);
      expect(res2.statusCode).toBe(200);

      // payjp_events に 1 件のみ（ON CONFLICT DO NOTHING）
      const events = await pool.query(
        "SELECT COUNT(*)::int AS cnt FROM payjp_events WHERE id = 'evnt_e2e_webhook_001'",
      );
      expect(events.rows[0].cnt).toBe(1);

      // syncRole は 1 回のみ呼ばれた
      expect(syncRole).toHaveBeenCalledOnce();
    });

    it('Scenario 5: 古い event.created → 無視（members 更新なし）', async () => {
      await insertTestMember({ last_payjp_event_created_at: NOW_UNIX });
      const syncRole = vi.fn().mockResolvedValue(undefined);
      const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool, syncRole) });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/payjp/webhook',
        headers: { 'content-type': 'application/json', 'x-payjp-webhook-token': E2E_WEBHOOK_TOKEN },
        payload: makeWebhookEvent({ id: 'evnt_e2e_stale_001', created: NOW_UNIX - 1000 }),
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });

      // payjp_events に ignored レコードが挿入されている
      const events = await pool.query("SELECT processing_result FROM payjp_events WHERE id = 'evnt_e2e_stale_001'");
      expect(events.rows).toHaveLength(1);
      expect(events.rows[0].processing_result).toBe('ignored');

      // members の subscription_status は変更されていない
      const member = await pgDb.findMemberByDiscordUserId(WEBHOOK_DISCORD_USER_ID);
      expect(member!.subscription_status).toBe('trial');

      // syncRole は呼ばれていない
      expect(syncRole).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // テスト間 DB 分離の確認
  // ---------------------------------------------------------------------------
  describe('DB 分離', () => {
    it('beforeEach の TRUNCATE により前テストのデータが残らない', async () => {
      // このテストが実行される時点で TRUNCATE 済みのはず
      const members = await pool.query('SELECT COUNT(*)::int AS cnt FROM members');
      const linkSessions = await pool.query('SELECT COUNT(*)::int AS cnt FROM discord_link_sessions');
      expect(members.rows[0].cnt).toBe(0);
      expect(linkSessions.rows[0].cnt).toBe(0);
    });
  });
});
