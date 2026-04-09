/**
 * E2E スモークテスト — Issue #20
 *
 * ハーネスが正常動作することを確認する最小シナリオ。
 * - Smoke 1: OAuth start → callback → session(linked=true)
 * - Smoke 2: Subscribe 初回ユーザー → charge + trial subscription → ロール付与
 *
 * 詳細 E2E シナリオは #37（OAuth/T-P0-01）・#38（Subscribe/T-P0-02）が担当。
 *
 * 前提: DATABASE_URL_TEST または DATABASE_URL が設定済みの PostgreSQL に接続可能であること。
 */

import { createHash } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildE2EApp,
  closePool,
  createTestDb,
  E2E_BILLING_CONFIG,
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
  // Smoke 2: Subscribe フロー
  // link_session を DB に直接挿入し、POST /v1/subscriptions を検証
  // ---------------------------------------------------------------------------
  describe('Smoke 2: Subscribe flow', () => {
    const DISCORD_USER_ID = '111222333444555002';
    const RAW_LINK_TOKEN = 'e2e-smoke-raw-link-token-subscribe';

    it('初回ユーザー → charge + trial subscription → ロール付与、DB に member が存在する', async () => {
      // link_session を DB に直接挿入（OAuth 完了後の状態を再現）
      const tokenHash = createHash('sha256').update(RAW_LINK_TOKEN).digest('hex');
      await pgDb.insertDiscordLinkSession({
        linkSessionTokenHash: tokenHash,
        discordUserId: DISCORD_USER_ID,
        expiresAt: new Date(Date.now() + 3600 * 1000),
      });

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
        cookies: { '__Host-link_session': RAW_LINK_TOKEN },
        body: JSON.stringify({
          planId: E2E_BILLING_CONFIG.allowedPlanIds[0],
          email: 'smoke-test@example.com',
          payjpToken: 'tok_test_e2e',
          privacyConsented: true,
        }),
      });

      expect(res.statusCode).toBe(200);

      // DB 確認: member が trial/active で作成されている
      const member = await pgDb.findMemberByDiscordUserId(DISCORD_USER_ID);
      expect(member).not.toBeNull();
      expect(['trial', 'active']).toContain(member!.subscription_status);
      expect(member!.payjp_subscription_id).toBe('sub_test_e2e');
      expect(member!.payjp_customer_id).toBe('cus_test_e2e');

      // Mock 確認: Discord ロール付与が呼ばれた
      expect(discordMock.assignRole).toHaveBeenCalledWith(
        E2E_BILLING_CONFIG.discordGuildId,
        DISCORD_USER_ID,
        E2E_BILLING_CONFIG.discordPaidRoleId,
      );

      // Mock 確認: PAY.JP 主要 API が呼ばれた
      expect(payjpMock.fetchToken).toHaveBeenCalledWith('tok_test_e2e');
      expect(payjpMock.createCustomer).toHaveBeenCalledOnce();
      expect(payjpMock.createSubscription).toHaveBeenCalledOnce();
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
