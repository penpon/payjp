/**
 * E2E セキュリティテスト — Issue #42
 *
 * 悪意ある/予期しない入力に対するエンドポイント防御を検証する。
 *
 * 受け入れ条件:
 * - すべての悪意ある入力は 4xx を返す（500 は絶対に返さない）
 * - SQL インジェクション / XSS のリフレクションなし
 * - サーバーがクラッシュまたはハングしない
 * - エラーレスポンスが内部情報を漏洩しない（スタックトレース・SQLエラー・生パスなし）
 *
 * 前提: DATABASE_URL_TEST または DATABASE_URL が設定済みの PostgreSQL に接続可能であること。
 */

import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildE2EApp,
  buildSyncDepsForE2E,
  closePool,
  createTestDb,
  E2E_BILLING_CONFIG,
  E2E_WEBHOOK_TOKEN,
  insertLinkedSession,
  makeWebhookEvent,
  type PgDbClient,
  TEST_DB_URL,
  truncateAll,
} from './helpers.js';

const hasTestDb = Boolean(TEST_DB_URL);

// ---------------------------------------------------------------------------
// 内部情報漏洩チェック用パターン
// ---------------------------------------------------------------------------
const INTERNAL_INFO_PATTERN = /SELECT|INSERT|UPDATE|DELETE|postgres|\.ts:|\.js:|stack\s*:/i;
const SQL_KEYWORDS = /SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER/i;

/** エラーボディが内部情報を含まないことを検証する */
function assertNoInternalInfo(responseBody: string): void {
  expect(responseBody).not.toMatch(INTERNAL_INFO_PATTERN);
}

/** ステータスコードが 4xx 範囲であることを検証する */
function assert4xx(statusCode: number): void {
  expect(statusCode).toBeGreaterThanOrEqual(400);
  expect(statusCode).toBeLessThan(500);
}

describe.skipIf(!hasTestDb)('E2E Security — 悪意ある入力防御', () => {
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
  // OAuth エンドポイント攻撃
  // ---------------------------------------------------------------------------
  describe('OAuth エンドポイント攻撃', () => {
    it.each([
      ['SQL インジェクション', "'; DROP TABLE oauth_states; --"],
      ['null バイト', 'abc\x00def'],
      ['XSS スクリプトタグ', '<script>alert(1)</script>'],
      ['パストラバーサル', '../../../etc/passwd'],
      ['CRLF インジェクション', 'abc\r\nX-Injected: evil'],
    ])('callback の state パラメータ攻撃 (%s) → 401 を返し内部情報を漏洩しない', async (_label, maliciousState) => {
      const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool) });
      const res = await app.inject({
        method: 'GET',
        url: `/v1/auth/discord/callback?code=mock-code&state=${encodeURIComponent(maliciousState)}`,
        cookies: { '__Host-oauth_session': 'invalid-session-token' },
      });

      expect(res.statusCode).toBe(401);
      assertNoInternalInfo(res.body);
    });

    it('state パラメータに null バイト → 401', async () => {
      const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool) });
      // null バイトは URL エンコードしてサーバーへ送信
      const res = await app.inject({
        method: 'GET',
        url: '/v1/auth/discord/callback?code=mock-code&state=abc%00def',
        cookies: { '__Host-oauth_session': 'invalid-token' },
      });

      assert4xx(res.statusCode);
      assertNoInternalInfo(res.body);
    });

    it('callback URL に state パラメータが複数 → 401（最初の値のみ使用、セッション不一致で失敗）', async () => {
      const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool) });
      const res = await app.inject({
        method: 'GET',
        url: '/v1/auth/discord/callback?code=mock-code&state=first-state&state=second-state',
        cookies: { '__Host-oauth_session': 'invalid-token' },
      });

      assert4xx(res.statusCode);
      assertNoInternalInfo(res.body);
    });

    it('callback URL に余分なクエリパラメータ → 401 または 302（安全に処理する）', async () => {
      const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool) });
      const res = await app.inject({
        method: 'GET',
        url: '/v1/auth/discord/callback?code=mock-code&state=some-state&evil=injected&__proto__=polluted',
        cookies: { '__Host-oauth_session': 'invalid-token' },
      });

      // サーバーはクラッシュしないこと; 認証失敗で 4xx または 302 リダイレクト
      expect(res.statusCode).not.toBe(500);
      assertNoInternalInfo(res.body);
    });

    it('callback に空の code パラメータ → 401', async () => {
      const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool) });
      const res = await app.inject({
        method: 'GET',
        url: '/v1/auth/discord/callback?code=&state=some-state',
        cookies: { '__Host-oauth_session': 'invalid-token' },
      });

      assert4xx(res.statusCode);
      assertNoInternalInfo(res.body);
    });

    it('部分一致 Cookie 名（__Host-oauth_sess）→ 401（正しい Cookie 名でないため認証失敗）', async () => {
      const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool) });
      const res = await app.inject({
        method: 'GET',
        url: '/v1/auth/discord/callback?code=mock-code&state=some-state',
        // 意図的に誤った Cookie 名を使用
        cookies: { '__Host-oauth_sess': 'some-session-token' },
      });

      assert4xx(res.statusCode);
      assertNoInternalInfo(res.body);
    });
  });

  // ---------------------------------------------------------------------------
  // Subscription エンドポイント攻撃
  // ---------------------------------------------------------------------------
  describe('Subscription エンドポイント攻撃', () => {
    async function postSubscribe(
      body: Record<string, unknown>,
      opts: { rawToken?: string; contentType?: string } = {},
    ) {
      const { rawToken: existingToken, contentType = 'application/json' } = opts;
      const rawToken = existingToken ?? (await insertLinkedSession(pgDb, `discord-sec-${randomUUID()}`)).rawToken;
      const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool) });
      return app.inject({
        method: 'POST',
        url: '/v1/subscriptions',
        headers: {
          'content-type': contentType,
          origin: 'https://example.com',
        },
        cookies: { '__Host-link_session': rawToken },
        body: JSON.stringify(body),
      });
    }

    it.each([
      [
        'SQL インジェクション (payjpToken)',
        { payjpToken: "'; DROP TABLE members; --", planId: 'plan_e2e', email: 'test@x.com', privacyConsented: true },
      ],
      [
        'SQL インジェクション (planId)',
        { planId: "'; DROP TABLE members; --", email: 'test@x.com', payjpToken: 'tok', privacyConsented: true },
      ],
      [
        'SQL インジェクション (email)',
        { email: "' OR '1'='1", planId: 'plan_e2e', payjpToken: 'tok', privacyConsented: true },
      ],
    ])('悪意ある payjpToken/planId/email (%s) → 4xx（500 なし）', async (_label, body) => {
      const res = await postSubscribe(body);
      assert4xx(res.statusCode);
      assertNoInternalInfo(res.body);
    });

    it('email フィールドに XSS → 4xx またはリフレクションなし（スクリプトタグが返されない）', async () => {
      const res = await postSubscribe({
        planId: 'plan_e2e',
        email: '<script>alert(1)</script>@example.com',
        payjpToken: 'tok',
        privacyConsented: true,
      });

      // 400 以上であること（schema maxLength が通れば billing ロジックが 4xx を返す）
      assert4xx(res.statusCode);
      // XSS ペイロードがレスポンスにリフレクションされていないこと
      expect(res.body).not.toContain('<script>');
    });

    it('planId にパストラバーサル → 422（不正な planId）', async () => {
      const res = await postSubscribe({
        planId: '../../../etc/passwd',
        email: 'test@example.com',
        payjpToken: 'tok_test',
        privacyConsented: true,
      });

      assert4xx(res.statusCode);
      assertNoInternalInfo(res.body);
    });

    it('空の JSON ボディ {} → 400（必須フィールド欠如）', async () => {
      const res = await postSubscribe({});
      expect(res.statusCode).toBe(400);
      assertNoInternalInfo(res.body);
    });

    it('不正な JSON ボディ → 400', async () => {
      const { rawToken } = await insertLinkedSession(pgDb, `discord-sec-${randomUUID()}`);
      const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool) });
      const res = await app.inject({
        method: 'POST',
        url: '/v1/subscriptions',
        headers: {
          'content-type': 'application/json',
          origin: 'https://example.com',
        },
        cookies: { '__Host-link_session': rawToken },
        body: '{ this is not valid json !!!',
      });

      expect(res.statusCode).toBe(400);
      assertNoInternalInfo(res.body);
    });

    it('Content-Type が text/plain（JSON ボディ付き）→ 400 または 415', async () => {
      const { rawToken } = await insertLinkedSession(pgDb, `discord-sec-${randomUUID()}`);
      const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool) });
      const res = await app.inject({
        method: 'POST',
        url: '/v1/subscriptions',
        headers: {
          'content-type': 'text/plain',
          origin: 'https://example.com',
        },
        cookies: { '__Host-link_session': rawToken },
        body: JSON.stringify({
          planId: 'plan_e2e',
          email: 'test@example.com',
          payjpToken: 'tok',
          privacyConsented: true,
        }),
      });

      assert4xx(res.statusCode);
      assertNoInternalInfo(res.body);
    });

    it('1MB を超える巨大なリクエストボディ → 413 または 400', async () => {
      const { rawToken } = await insertLinkedSession(pgDb, `discord-sec-${randomUUID()}`);
      const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool) });
      const oversizedValue = 'x'.repeat(1024 * 1024 + 1); // >1MB
      const res = await app.inject({
        method: 'POST',
        url: '/v1/subscriptions',
        headers: {
          'content-type': 'application/json',
          origin: 'https://example.com',
        },
        cookies: { '__Host-link_session': rawToken },
        body: JSON.stringify({
          planId: 'plan_e2e',
          email: 'test@example.com',
          payjpToken: oversizedValue,
          privacyConsented: true,
        }),
      });

      assert4xx(res.statusCode);
      assertNoInternalInfo(res.body);
    });

    it('additionalProperties に悪意ある追加フィールド → 400（スキーマ: additionalProperties: false）', async () => {
      // `__proto__:` リテラルはプロトタイプを汚染するだけで own プロパティにならず JSON に載らない。
      // 計算プロパティで own キーとして送り、プロトタイプ汚染ペイロードがサーバーに届くことを検証する。
      const res = await postSubscribe({
        planId: 'plan_e2e',
        email: 'test@example.com',
        payjpToken: 'tok',
        privacyConsented: true,
        evil: 'data',
        ['__proto__']: { isAdmin: true },
        constructor: 'override',
      });

      expect(res.statusCode).toBe(400);
      assertNoInternalInfo(res.body);
    });

    it('email フィールドが 254 文字超（maxLength 違反）→ 400', async () => {
      const longEmail = `${'a'.repeat(250)}@b.com`; // 256 文字
      const res = await postSubscribe({
        planId: 'plan_e2e',
        email: longEmail,
        payjpToken: 'tok',
        privacyConsented: true,
      });

      expect(res.statusCode).toBe(400);
      assertNoInternalInfo(res.body);
    });

    it('email フィールドに Unicode 正規化攻撃（混合文字）→ 4xx（クラッシュしない）', async () => {
      // Unicode 正規化攻撃: 見た目が同じでも異なるコードポイントを持つ文字を混在させる
      const unicodeEmail = '\u0041\uFF20\u0065\u0078\u0061\u006D\u0070\u006C\u0065\u002E\u0063\u006F\u006D'; // A＠example.com
      const res = await postSubscribe({
        planId: 'plan_e2e',
        email: unicodeEmail,
        payjpToken: 'tok',
        privacyConsented: true,
      });

      // クラッシュせず、4xx または処理済み（500 は不可）
      expect(res.statusCode).not.toBe(500);
      assertNoInternalInfo(res.body);
    });
  });

  // ---------------------------------------------------------------------------
  // Webhook エンドポイント攻撃
  // ---------------------------------------------------------------------------
  describe('Webhook エンドポイント攻撃', () => {
    const WEBHOOK_DISCORD_USER_ID = 'discord-e2e-user';
    const WEBHOOK_SUB_ID = 'sub_test_e2e';

    async function insertWebhookTestMember() {
      await pool.query(
        `INSERT INTO members (id, discord_user_id, email, subscription_status, payjp_subscription_id, payjp_customer_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (discord_user_id) DO NOTHING`,
        [
          randomUUID(),
          WEBHOOK_DISCORD_USER_ID,
          `${WEBHOOK_DISCORD_USER_ID}@e2e.test`,
          'active',
          WEBHOOK_SUB_ID,
          'cus_test_e2e',
        ],
      );
    }

    function buildWebhookApp() {
      return buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool) });
    }

    it('1MB を超える巨大なペイロード → 413 または 400', async () => {
      const app = buildWebhookApp();
      const oversizedBody = 'x'.repeat(1024 * 1024 + 1);
      const res = await app.inject({
        method: 'POST',
        url: '/v1/payjp/webhook',
        headers: {
          'content-type': 'application/json',
          'x-payjp-webhook-token': E2E_WEBHOOK_TOKEN,
        },
        body: oversizedBody,
      });

      assert4xx(res.statusCode);
      assertNoInternalInfo(res.body);
    });

    it('バイナリ/非 JSON ペイロード → 400', async () => {
      const app = buildWebhookApp();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/payjp/webhook',
        headers: {
          'content-type': 'application/json',
          'x-payjp-webhook-token': E2E_WEBHOOK_TOKEN,
        },
        body: Buffer.from([0x00, 0xff, 0xfe, 0xfd, 0xfc]),
      });

      assert4xx(res.statusCode);
      assertNoInternalInfo(res.body);
    });

    it('x-payjp-webhook-token ヘッダーが重複（配列）→ 401（無効/欠落として扱う）', async () => {
      const app = buildWebhookApp();
      const event = makeWebhookEvent();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/payjp/webhook',
        // Fastify の inject は headers を Record<string, string> で受け取るため
        // 重複ヘッダーはカンマ結合値として送信する（RFC 7230 準拠）
        headers: {
          'content-type': 'application/json',
          'x-payjp-webhook-token': `${E2E_WEBHOOK_TOKEN}, ${E2E_WEBHOOK_TOKEN}`,
        },
        payload: event,
      });

      // カンマ結合値はトークンと一致しないため 401
      expect(res.statusCode).toBe(401);
      assertNoInternalInfo(res.body);
    });

    it('event.id に SQL インジェクション → 200（安全に処理、SQL エラーなし）', async () => {
      await insertWebhookTestMember();
      const app = buildWebhookApp();
      const event = makeWebhookEvent({
        id: "'; DROP TABLE payjp_events; --",
        data: {
          id: WEBHOOK_SUB_ID,
          object: 'subscription',
          status: 'active',
          metadata: { discord_user_id: WEBHOOK_DISCORD_USER_ID },
          plan: { id: E2E_BILLING_CONFIG.allowedPlanIds[0] },
          current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
        },
      });
      const res = await app.inject({
        method: 'POST',
        url: '/v1/payjp/webhook',
        headers: {
          'content-type': 'application/json',
          'x-payjp-webhook-token': E2E_WEBHOOK_TOKEN,
        },
        payload: event,
      });

      // SQL インジェクションによりサーバーがクラッシュしないこと
      expect(res.statusCode).not.toBe(500);
      // payjp_events テーブルが存在していること（DROP が実行されていない）
      const tableCheck = await pool.query(
        "SELECT COUNT(*)::int AS cnt FROM information_schema.tables WHERE table_name = 'payjp_events'",
      );
      expect(tableCheck.rows[0].cnt).toBe(1);
    });

    it.each([
      ['未来の created（2099年）', Math.floor(new Date('2099-01-01T00:00:00Z').getTime() / 1000)],
      ['負の created', -1000],
      ['古い created（2000年）', Math.floor(new Date('2000-01-01T00:00:00Z').getTime() / 1000)],
    ])('event.created が %s → 200（処理または無視、エラーなし）', async (_label, created) => {
      await insertWebhookTestMember();
      const app = buildWebhookApp();
      const event = makeWebhookEvent({
        id: `evnt_e2e_time_${randomUUID().slice(0, 8)}`,
        created,
        data: {
          id: WEBHOOK_SUB_ID,
          object: 'subscription',
          status: 'active',
          metadata: { discord_user_id: WEBHOOK_DISCORD_USER_ID },
          plan: { id: E2E_BILLING_CONFIG.allowedPlanIds[0] },
          current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
        },
      });
      const res = await app.inject({
        method: 'POST',
        url: '/v1/payjp/webhook',
        headers: {
          'content-type': 'application/json',
          'x-payjp-webhook-token': E2E_WEBHOOK_TOKEN,
        },
        payload: event,
      });

      // クラッシュせず 200 を返すこと（処理または無視）
      expect(res.statusCode).toBe(200);
      assertNoInternalInfo(res.body);
    });

    it('Content-Type ヘッダーなし → 400 または安全に処理', async () => {
      const app = buildWebhookApp();
      const event = makeWebhookEvent();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/payjp/webhook',
        headers: {
          'x-payjp-webhook-token': E2E_WEBHOOK_TOKEN,
          // content-type を意図的に省略
        },
        payload: event,
      });

      // サーバーがクラッシュしないこと
      expect(res.statusCode).not.toBe(500);
      assertNoInternalInfo(res.body);
    });

    it('同一 event.id を並行送信 → payjp_events に 1 件のみ（冪等性保証）', async () => {
      await insertWebhookTestMember();
      const app = buildWebhookApp();
      const uniqueEventId = `evnt_concurrent_${randomUUID().slice(0, 8)}`;
      const event = makeWebhookEvent({
        id: uniqueEventId,
        data: {
          id: WEBHOOK_SUB_ID,
          object: 'subscription',
          status: 'active',
          metadata: { discord_user_id: WEBHOOK_DISCORD_USER_ID },
          plan: { id: E2E_BILLING_CONFIG.allowedPlanIds[0] },
          current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
        },
      });

      const [res1, res2] = await Promise.all([
        app.inject({
          method: 'POST',
          url: '/v1/payjp/webhook',
          headers: {
            'content-type': 'application/json',
            'x-payjp-webhook-token': E2E_WEBHOOK_TOKEN,
          },
          payload: event,
        }),
        app.inject({
          method: 'POST',
          url: '/v1/payjp/webhook',
          headers: {
            'content-type': 'application/json',
            'x-payjp-webhook-token': E2E_WEBHOOK_TOKEN,
          },
          payload: event,
        }),
      ]);

      // 両リクエストとも成功すること
      expect(res1.statusCode).toBe(200);
      expect(res2.statusCode).toBe(200);

      // payjp_events テーブルに当該 event_id のレコードが 1 件のみ存在すること
      const result = await pool.query('SELECT COUNT(*)::int AS cnt FROM payjp_events WHERE id = $1', [uniqueEventId]);
      expect(result.rows[0].cnt).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Cancel エンドポイント攻撃
  // ---------------------------------------------------------------------------
  describe('Cancel エンドポイント攻撃', () => {
    it('ボディなし / Cookie なし → 401 または 403', async () => {
      const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool) });
      const res = await app.inject({
        method: 'POST',
        url: '/v1/subscriptions/cancel',
        headers: {
          'content-type': 'application/json',
          origin: 'https://example.com',
        },
        // Cookie なし、ボディなし
      });

      assert4xx(res.statusCode);
      assertNoInternalInfo(res.body);
    });

    it('Origin: null ヘッダー → 403（null Origin はクロスオリジンブラウザリクエストを示す）', async () => {
      const { rawToken } = await insertLinkedSession(pgDb, `discord-cancel-${randomUUID()}`);
      const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool) });
      const res = await app.inject({
        method: 'POST',
        url: '/v1/subscriptions/cancel',
        headers: {
          'content-type': 'application/json',
          origin: 'null',
        },
        cookies: { '__Host-link_session': rawToken },
        // application/json かつボディ欠落は Fastify が 400 になり、Origin 検証まで届かない
        payload: {},
      });

      expect(res.statusCode).toBe(403);
      assertNoInternalInfo(res.body);
    });
  });

  // ---------------------------------------------------------------------------
  // クロスエンドポイント: エラーレスポンス検査
  // ---------------------------------------------------------------------------
  describe('エラーレスポンス品質検査', () => {
    it('4xx レスポンスが内部情報（SQL・スタックトレース・ファイルパス・UUID）を含まない', async () => {
      const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool) });

      const maliciousRequests = await Promise.all([
        // OAuth: 不正な state
        app.inject({
          method: 'GET',
          url: `/v1/auth/discord/callback?code=x&state=${encodeURIComponent("'; DROP TABLE oauth_states; --")}`,
          cookies: { '__Host-oauth_session': 'bad-token' },
        }),
        // Subscription: 必須フィールド欠如
        app.inject({
          method: 'POST',
          url: '/v1/subscriptions',
          headers: { 'content-type': 'application/json', origin: 'https://example.com' },
          body: '{}',
        }),
        // Subscription: 不正な JSON
        app.inject({
          method: 'POST',
          url: '/v1/subscriptions',
          headers: { 'content-type': 'application/json', origin: 'https://example.com' },
          body: 'not-json',
        }),
        // Webhook: 不正なトークン
        app.inject({
          method: 'POST',
          url: '/v1/payjp/webhook',
          headers: {
            'content-type': 'application/json',
            'x-payjp-webhook-token': 'wrong-token',
          },
          payload: makeWebhookEvent(),
        }),
      ]);

      for (const res of maliciousRequests) {
        // すべて 4xx であること
        assert4xx(res.statusCode);

        // レスポンスボディが内部情報を含まないこと
        const bodyStr = res.body;
        expect(bodyStr).not.toMatch(SQL_KEYWORDS);
        expect(bodyStr).not.toContain('postgres');
        expect(bodyStr).not.toMatch(/\.ts:/);
        expect(bodyStr).not.toMatch(/\.js:/);
        expect(bodyStr).not.toMatch(/stack\s*:/i);
        // UUID はエラーフィールドに含まれないこと（[REDACTED] で置換済みのはず）
        expect(bodyStr).not.toMatch(/error.*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      }
    });

    it('すべてのエラーレスポンスにセキュリティヘッダーが含まれる', async () => {
      const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool) });

      const errorResponses = await Promise.all([
        // 401: OAuth callback（不正なセッション）
        app.inject({
          method: 'GET',
          url: '/v1/auth/discord/callback?code=x&state=bad',
          cookies: { '__Host-oauth_session': 'bad' },
        }),
        // 400: Subscription（空ボディ）
        app.inject({
          method: 'POST',
          url: '/v1/subscriptions',
          headers: { 'content-type': 'application/json', origin: 'https://example.com' },
          body: '{}',
        }),
        // 401: Webhook（不正なトークン）
        app.inject({
          method: 'POST',
          url: '/v1/payjp/webhook',
          headers: {
            'content-type': 'application/json',
            'x-payjp-webhook-token': 'wrong',
          },
          payload: makeWebhookEvent(),
        }),
      ]);

      for (const res of errorResponses) {
        expect(res.headers['x-content-type-options']).toBe('nosniff');
        expect(res.headers['x-frame-options']).toBe('DENY');
      }
    });
  });
});
