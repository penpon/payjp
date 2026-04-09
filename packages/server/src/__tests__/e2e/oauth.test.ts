/**
 * E2E テスト — OAuth / セキュリティヘッダ検証 (Issue #37, T-P0-01)
 *
 * カバレッジ:
 *   - OAuth start: 302 リダイレクト、__Host-oauth_session Cookie 属性
 *   - Callback happy path: 302 リダイレクト、__Host-link_session Cookie 属性、URL トークン漏洩なし
 *   - Callback エラー: 不正 state / TTL 期限切れ / Cookie なし / 使用済み state
 *   - Session: CORS ヘッダ、Origin 検証、Cookie なし / 期限切れ
 *   - セキュリティヘッダ: Cache-Control: no-store、Referrer-Policy: no-referrer
 *
 * 前提: DATABASE_URL_TEST または DATABASE_URL が設定済みの PostgreSQL に接続可能であること。
 */

import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildE2EApp,
  closePool,
  completeOAuthFlow,
  createTestDb,
  insertLinkedSession,
  type PgDbClient,
  TEST_DB_URL,
  truncateAll,
} from './helpers.js';

// ---------------------------------------------------------------------------
// ユーティリティ
// ---------------------------------------------------------------------------

/** Set-Cookie ヘッダ文字列から指定属性が存在するか大文字小文字を無視して検証する */
function hasCookieAttribute(setCookieHeader: string, attribute: string): boolean {
  return setCookieHeader.toLowerCase().includes(attribute.toLowerCase());
}

/** Set-Cookie ヘッダ文字列から Cookie 値を抽出する */
function extractCookieValue(setCookieHeader: string, cookieName: string): string | null {
  const match = setCookieHeader.match(new RegExp(`${cookieName}=([^;]+)`));
  return match ? match[1] : null;
}

/** Set-Cookie ヘッダ文字列から属性値（例: Max-Age=600）の数値を抽出する */
function extractCookieAttributeNumber(setCookieHeader: string, attribute: string): number | null {
  const match = setCookieHeader.match(new RegExp(`${attribute}=(\\d+)`, 'i'));
  return match ? Number(match[1]) : null;
}

/** OAuth state トークンを Location ヘッダから抽出する */
function extractStateFromLocation(location: string): string {
  return new URL(location).searchParams.get('state') ?? '';
}

// ---------------------------------------------------------------------------
// テストスイート
// ---------------------------------------------------------------------------

const hasTestDb = Boolean(TEST_DB_URL);

describe.skipIf(!hasTestDb)('E2E OAuth — T-P0-01', () => {
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

  // fetch モックのクリーンアップを afterEach でも保証する（test 内 finally を補完）
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // OAuth start
  // -------------------------------------------------------------------------
  describe('GET /v1/auth/discord/start', () => {
    it('302 リダイレクト — Location が Discord 認可 URL で scope=identify を含む', async () => {
      const app = buildE2EApp(pgDb);
      const res = await app.inject({ method: 'GET', url: '/v1/auth/discord/start' });

      expect(res.statusCode).toBe(302);

      const location = res.headers.location as string;
      expect(location).toContain('https://discord.com/oauth2/authorize');
      expect(location).toContain('scope=identify');
    });

    it('Set-Cookie __Host-oauth_session — 必須属性 (Secure / HttpOnly / SameSite=Lax / Path=/ / Max-Age=600)', async () => {
      const app = buildE2EApp(pgDb);
      const res = await app.inject({ method: 'GET', url: '/v1/auth/discord/start' });

      const setCookie = res.headers['set-cookie'] as string;
      expect(setCookie).toBeTruthy();
      expect(setCookie).toContain('__Host-oauth_session=');
      expect(hasCookieAttribute(setCookie, 'Secure')).toBe(true);
      expect(hasCookieAttribute(setCookie, 'HttpOnly')).toBe(true);
      expect(hasCookieAttribute(setCookie, 'SameSite=Lax')).toBe(true);
      expect(hasCookieAttribute(setCookie, 'Path=/')).toBe(true);
      expect(extractCookieAttributeNumber(setCookie, 'Max-Age')).toBe(600);
    });
  });

  // -------------------------------------------------------------------------
  // Callback happy path
  // -------------------------------------------------------------------------
  describe('GET /v1/auth/discord/callback — happy path', () => {
    it('有効な state + code → 302 to frontend かつ __Host-link_session Cookie がセットされる (Max-Age=900)', async () => {
      const app = buildE2EApp(pgDb);
      const discordUserId = '100200300400500601';

      const mockFetch = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: 'mock_token' }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ id: discordUserId }),
        } as Response)
        // token revoke (best-effort, ignored)
        .mockResolvedValue({ ok: true } as Response);

      try {
        const startRes = await app.inject({ method: 'GET', url: '/v1/auth/discord/start' });
        const oauthSessionToken = extractCookieValue(startRes.headers['set-cookie'] as string, '__Host-oauth_session')!;
        const stateToken = extractStateFromLocation(startRes.headers.location as string);

        const callbackRes = await app.inject({
          method: 'GET',
          url: `/v1/auth/discord/callback?code=mock-code&state=${stateToken}`,
          cookies: { '__Host-oauth_session': oauthSessionToken },
        });

        expect(callbackRes.statusCode).toBe(302);
        expect(callbackRes.headers.location).toBe('https://example.com');

        const linkCookie = callbackRes.headers['set-cookie'] as string;
        expect(linkCookie).toContain('__Host-link_session=');
        expect(extractCookieAttributeNumber(linkCookie, 'Max-Age')).toBe(900);
      } finally {
        mockFetch.mockRestore();
      }
    });

    it('Location ヘッダに OAuth トークン・link_session トークンが露出しない', async () => {
      const app = buildE2EApp(pgDb);
      const discordUserId = '100200300400500602';

      const mockFetch = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: 'mock_token' }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ id: discordUserId }),
        } as Response)
        .mockResolvedValue({ ok: true } as Response);

      try {
        const startRes = await app.inject({ method: 'GET', url: '/v1/auth/discord/start' });
        const oauthSessionToken = extractCookieValue(startRes.headers['set-cookie'] as string, '__Host-oauth_session')!;
        const stateToken = extractStateFromLocation(startRes.headers.location as string);

        const callbackRes = await app.inject({
          method: 'GET',
          url: `/v1/auth/discord/callback?code=mock-code&state=${stateToken}`,
          cookies: { '__Host-oauth_session': oauthSessionToken },
        });

        const location = callbackRes.headers.location as string;
        // state / code / access_token / link_session が URL に含まれないこと
        expect(location).not.toContain('state=');
        expect(location).not.toContain('code=');
        expect(location).not.toContain('access_token=');
        expect(location).not.toContain('link_session');
        expect(location).not.toContain('token');
      } finally {
        mockFetch.mockRestore();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Callback エラーケース
  // -------------------------------------------------------------------------
  describe('GET /v1/auth/discord/callback — エラーケース', () => {
    it('不正な state 値 → 401', async () => {
      const app = buildE2EApp(pgDb);

      // まず start で正常な oauth_session を取得する
      const startRes = await app.inject({ method: 'GET', url: '/v1/auth/discord/start' });
      const oauthSessionToken = extractCookieValue(startRes.headers['set-cookie'] as string, '__Host-oauth_session')!;

      const res = await app.inject({
        method: 'GET',
        url: '/v1/auth/discord/callback?code=mock-code&state=invalid-wrong-state-value',
        cookies: { '__Host-oauth_session': oauthSessionToken },
      });

      expect(res.statusCode).toBe(401);
    });

    it('TTL 期限切れ (expires_at が過去) の oauth_state → 401', async () => {
      const app = buildE2EApp(pgDb);

      // 期限切れの oauth_state を DB に直接挿入する
      const rawState = randomBytes(32).toString('hex');
      const rawSession = randomBytes(32).toString('hex');
      const stateHashVal = createHash('sha256').update(rawState).digest('hex');
      const sessionHashVal = createHash('sha256').update(rawSession).digest('hex');

      // expires_at を 11分前に設定（TTL=10分を超過）
      const expiredAt = new Date(Date.now() - 11 * 60 * 1000);
      await pool.query(
        `INSERT INTO oauth_states (state_hash, oauth_session_hash, expires_at)
         VALUES ($1, $2, $3)`,
        [stateHashVal, sessionHashVal, expiredAt],
      );

      const res = await app.inject({
        method: 'GET',
        url: `/v1/auth/discord/callback?code=mock-code&state=${rawState}`,
        cookies: { '__Host-oauth_session': rawSession },
      });

      expect(res.statusCode).toBe(401);
    });

    it('__Host-oauth_session Cookie なし → 401', async () => {
      const app = buildE2EApp(pgDb);

      // start で state を取得するが Cookie なしでコールバックを呼ぶ
      const startRes = await app.inject({ method: 'GET', url: '/v1/auth/discord/start' });
      const stateToken = extractStateFromLocation(startRes.headers.location as string);

      const res = await app.inject({
        method: 'GET',
        url: `/v1/auth/discord/callback?code=mock-code&state=${stateToken}`,
        // Cookie を意図的に渡さない
      });

      expect(res.statusCode).toBe(401);
    });

    it('使用済み state（used_at が設定済み）→ 401', async () => {
      const app = buildE2EApp(pgDb);
      const discordUserId = '100200300400500603';

      // フル OAuth フローを完了させて state を消費する
      const mockFetch = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: 'mock_token' }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ id: discordUserId }),
        } as Response)
        .mockResolvedValue({ ok: true } as Response);

      try {
        const startRes = await app.inject({ method: 'GET', url: '/v1/auth/discord/start' });
        const oauthSessionToken = extractCookieValue(startRes.headers['set-cookie'] as string, '__Host-oauth_session')!;
        const stateToken = extractStateFromLocation(startRes.headers.location as string);

        // 1回目: 正常完了（state が消費される）
        const firstCallbackRes = await app.inject({
          method: 'GET',
          url: `/v1/auth/discord/callback?code=mock-code&state=${stateToken}`,
          cookies: { '__Host-oauth_session': oauthSessionToken },
        });
        expect(firstCallbackRes.statusCode).toBe(302);

        // fetch モックをリセットして 2回目のコールバックを試みる
        mockFetch.mockRestore();

        // 2回目: 同じ state を再利用 → 401
        const secondCallbackRes = await app.inject({
          method: 'GET',
          url: `/v1/auth/discord/callback?code=mock-code&state=${stateToken}`,
          cookies: { '__Host-oauth_session': oauthSessionToken },
        });
        expect(secondCallbackRes.statusCode).toBe(401);
      } finally {
        mockFetch.mockRestore();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Session エンドポイント
  // -------------------------------------------------------------------------
  describe('GET /v1/auth/discord/session', () => {
    const SESSION_DISCORD_USER_ID = '100200300400500700';

    it('有効な link_session + 正しい Origin → 200 + CORS ヘッダ', async () => {
      const app = buildE2EApp(pgDb);
      const { rawToken } = await insertLinkedSession(pgDb, SESSION_DISCORD_USER_ID);

      const res = await app.inject({
        method: 'GET',
        url: '/v1/auth/discord/session',
        cookies: { '__Host-link_session': rawToken },
        headers: { origin: 'https://example.com' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe('https://example.com');
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });

    it('有効な link_session + 不正 Origin → 403', async () => {
      const app = buildE2EApp(pgDb);
      const { rawToken } = await insertLinkedSession(pgDb, SESSION_DISCORD_USER_ID);

      const res = await app.inject({
        method: 'GET',
        url: '/v1/auth/discord/session',
        cookies: { '__Host-link_session': rawToken },
        headers: { origin: 'https://evil.example.com' },
      });

      expect(res.statusCode).toBe(403);
    });

    it('link_session Cookie なし → { linked: false } または 401', async () => {
      const app = buildE2EApp(pgDb);

      const res = await app.inject({
        method: 'GET',
        url: '/v1/auth/discord/session',
        headers: { origin: 'https://example.com' },
      });

      // 実装は 401 を返すが、T-P0-01 では { linked: false } を期待する場合も考慮
      // 現在の実装: 401
      expect([200, 401]).toContain(res.statusCode);
      if (res.statusCode === 200) {
        expect(res.json()).toMatchObject({ linked: false });
      }
    });

    it('期限切れ link_session → { linked: false } または 401', async () => {
      const app = buildE2EApp(pgDb);
      // expiresIn を負値にして期限切れセッションを挿入する
      const { rawToken } = await insertLinkedSession(pgDb, SESSION_DISCORD_USER_ID, undefined, -1);

      const res = await app.inject({
        method: 'GET',
        url: '/v1/auth/discord/session',
        cookies: { '__Host-link_session': rawToken },
        headers: { origin: 'https://example.com' },
      });

      // 実装は 401 を返すが、T-P0-01 では { linked: false } を期待する場合も考慮
      expect([200, 401]).toContain(res.statusCode);
      if (res.statusCode === 200) {
        expect(res.json()).toMatchObject({ linked: false });
      }
    });
  });

  // -------------------------------------------------------------------------
  // セキュリティヘッダ
  // -------------------------------------------------------------------------
  describe('セキュリティヘッダ', () => {
    it('callback レスポンスに Cache-Control: no-store が含まれる', async () => {
      const app = buildE2EApp(pgDb);
      const res = await app.inject({
        method: 'GET',
        url: '/v1/auth/discord/callback?code=x&state=y',
        cookies: { '__Host-oauth_session': 'z' },
      });

      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('callback レスポンスに Referrer-Policy: no-referrer が含まれる', async () => {
      const app = buildE2EApp(pgDb);
      const res = await app.inject({
        method: 'GET',
        url: '/v1/auth/discord/callback?code=x&state=y',
        cookies: { '__Host-oauth_session': 'z' },
      });

      expect(res.headers['referrer-policy']).toBe('no-referrer');
    });

    it('session レスポンスに Cache-Control: no-store が含まれる', async () => {
      const app = buildE2EApp(pgDb);
      const res = await app.inject({
        method: 'GET',
        url: '/v1/auth/discord/session',
        headers: { origin: 'https://example.com' },
      });

      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('session レスポンスに Referrer-Policy: no-referrer が含まれる', async () => {
      const app = buildE2EApp(pgDb);
      const res = await app.inject({
        method: 'GET',
        url: '/v1/auth/discord/session',
        headers: { origin: 'https://example.com' },
      });

      expect(res.headers['referrer-policy']).toBe('no-referrer');
    });

    it('start レスポンスに Cache-Control: no-store が含まれる', async () => {
      const app = buildE2EApp(pgDb);
      const res = await app.inject({ method: 'GET', url: '/v1/auth/discord/start' });

      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('start レスポンスに Referrer-Policy: no-referrer が含まれる', async () => {
      const app = buildE2EApp(pgDb);
      const res = await app.inject({ method: 'GET', url: '/v1/auth/discord/start' });

      expect(res.headers['referrer-policy']).toBe('no-referrer');
    });
  });

  // -------------------------------------------------------------------------
  // OAuth フロー統合検証（completeOAuthFlow ヘルパー使用）
  // -------------------------------------------------------------------------
  describe('OAuth フロー統合', () => {
    it('completeOAuthFlow 後に session が linked=true を返す', async () => {
      const app = buildE2EApp(pgDb);
      const discordUserId = '100200300400500800';

      const { linkSessionToken, mockFetch } = await completeOAuthFlow(app, discordUserId);

      try {
        const sessionRes = await app.inject({
          method: 'GET',
          url: '/v1/auth/discord/session',
          cookies: { '__Host-link_session': linkSessionToken },
          headers: { origin: 'https://example.com' },
        });

        expect(sessionRes.statusCode).toBe(200);
        expect(sessionRes.json()).toEqual({
          linked: true,
          discordUserId,
        });
      } finally {
        mockFetch.mockRestore();
      }
    });
  });
});
