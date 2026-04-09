/**
 * E2E テスト — Webhook 認証・バリデーション・エッジケース (Issue #47, T-P0-07)
 *
 * カバー範囲:
 *   - トークン認証 (401 / payjp_events 書き込みなし)
 *   - バリデーション失敗 → 200 + ignored / failed (PAY.JP リトライ増幅防止)
 *   - 必須フィールド欠損
 *   - 不明 status の fail-close (Discord ロール取消)
 *   - 同秒イベント・古いイベント
 *   - 冪等性
 *   - discord_user_id 解決 (metadata / 逆引き / 競合)
 *   - operation_id 保存
 *   - plan / period 更新挙動
 *
 * 前提: DATABASE_URL_TEST または DATABASE_URL が設定済みの PostgreSQL に接続可能であること。
 */

import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildE2EApp,
  buildSyncDepsForE2E,
  closePool,
  createTestDb,
  E2E_WEBHOOK_TOKEN,
  makeWebhookEvent,
  type PgDbClient,
  TEST_DB_URL,
  truncateAll,
} from './helpers.js';

const hasTestDb = Boolean(TEST_DB_URL);

// ---------------------------------------------------------------------------
// ヘルパー: members テーブルへの直接挿入
// ---------------------------------------------------------------------------

const DEFAULT_EVENT_CREATED = Math.floor(new Date('2025-04-01T10:00:00Z').getTime() / 1000);

async function insertMember(
  pool: pg.Pool,
  opts: {
    discordUserId: string;
    subscriptionId?: string;
    customerId?: string;
    subscriptionStatus?: string;
    lastEventCreatedAt?: number | null;
    planId?: string;
  },
): Promise<string> {
  const id = randomUUID();
  const {
    discordUserId,
    subscriptionId = 'sub_test_e2e',
    customerId = 'cus_test_e2e',
    subscriptionStatus = 'trial',
    lastEventCreatedAt = DEFAULT_EVENT_CREATED - 100,
    planId = null,
  } = opts;

  await pool.query(
    `INSERT INTO members
       (id, discord_user_id, email, subscription_status, last_payjp_event_created_at,
        payjp_subscription_id, payjp_customer_id, payjp_plan_id, role_state)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'unknown')`,
    [
      id,
      discordUserId,
      `${discordUserId}@e2e-test.example.com`,
      subscriptionStatus,
      lastEventCreatedAt,
      subscriptionId,
      customerId,
      planId,
    ],
  );
  return id;
}

// ---------------------------------------------------------------------------
// テスト本体
// ---------------------------------------------------------------------------

describe.skipIf(!hasTestDb)('E2E Webhook — 認証・バリデーション・エッジケース (Issue #47)', () => {
  let pool: pg.Pool;
  let pgDb: PgDbClient;
  let syncRole: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    ({ pool, pgDb } = await createTestDb());
  });

  afterAll(async () => {
    await closePool(pool);
  });

  beforeEach(async () => {
    await truncateAll(pool);
    syncRole = vi.fn().mockResolvedValue(undefined);
  });

  // =========================================================================
  // グループ 1: トークン認証
  // =========================================================================
  describe('トークン認証', () => {
    it('1. x-payjp-webhook-token ヘッダーが存在しない場合 → 401 かつ payjp_events にレコードなし', async () => {
      const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool, syncRole) });
      const event = makeWebhookEvent({ id: `evnt_${randomUUID().slice(0, 8)}` });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/payjp/webhook',
        headers: { 'content-type': 'application/json' },
        payload: event,
      });

      expect(res.statusCode).toBe(401);

      const rows = await pool.query('SELECT COUNT(*)::int AS cnt FROM payjp_events');
      expect(rows.rows[0].cnt).toBe(0);
    });

    it('2. x-payjp-webhook-token が誤った値の場合 → 401 かつ payjp_events にレコードなし', async () => {
      const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool, syncRole) });
      const event = makeWebhookEvent({ id: `evnt_${randomUUID().slice(0, 8)}` });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/payjp/webhook',
        headers: {
          'content-type': 'application/json',
          'x-payjp-webhook-token': 'wrong_token_value',
        },
        payload: event,
      });

      expect(res.statusCode).toBe(401);

      const rows = await pool.query('SELECT COUNT(*)::int AS cnt FROM payjp_events');
      expect(rows.rows[0].cnt).toBe(0);
    });
  });

  // =========================================================================
  // グループ 2: バリデーション失敗 → 200 + ignored (PAY.JP リトライ増幅防止)
  // =========================================================================
  describe('バリデーション失敗 → 200 + ignored', () => {
    it('3. livemode: true (expectedLivemode=false と不一致) → 200 + processing_result = ignored', async () => {
      const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool, syncRole) });
      const eventId = `evnt_${randomUUID().slice(0, 8)}`;
      const event = makeWebhookEvent({ id: eventId, livemode: true });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/payjp/webhook',
        headers: {
          'content-type': 'application/json',
          'x-payjp-webhook-token': E2E_WEBHOOK_TOKEN,
        },
        payload: event,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });

      const rows = await pool.query('SELECT processing_result FROM payjp_events WHERE id = $1', [eventId]);
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].processing_result).toBe('ignored');
    });

    it('4. 未知の event.type (charge.succeeded) → 200 + processing_result = ignored', async () => {
      const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool, syncRole) });
      const eventId = `evnt_${randomUUID().slice(0, 8)}`;
      const event = makeWebhookEvent({ id: eventId, type: 'charge.succeeded' });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/payjp/webhook',
        headers: {
          'content-type': 'application/json',
          'x-payjp-webhook-token': E2E_WEBHOOK_TOKEN,
        },
        payload: event,
      });

      expect(res.statusCode).toBe(200);

      const rows = await pool.query('SELECT processing_result FROM payjp_events WHERE id = $1', [eventId]);
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].processing_result).toBe('ignored');
    });

    it('5. data.object が subscription でない → 200 + processing_result = ignored', async () => {
      const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool, syncRole) });
      const eventId = `evnt_${randomUUID().slice(0, 8)}`;
      const event = makeWebhookEvent({ id: eventId, data: { object: 'customer' } });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/payjp/webhook',
        headers: {
          'content-type': 'application/json',
          'x-payjp-webhook-token': E2E_WEBHOOK_TOKEN,
        },
        payload: event,
      });

      expect(res.statusCode).toBe(200);

      const rows = await pool.query('SELECT processing_result FROM payjp_events WHERE id = $1', [eventId]);
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].processing_result).toBe('ignored');
    });

    it('6. subscription.created イベント → 200 + processing_result = ignored かつ members 更新なし', async () => {
      const discordUserId = `discord-sc-${randomUUID().slice(0, 8)}`;
      await insertMember(pool, { discordUserId });

      const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool, syncRole) });
      const eventId = `evnt_${randomUUID().slice(0, 8)}`;
      const event = makeWebhookEvent({
        id: eventId,
        type: 'subscription.created',
        data: { status: 'trial', metadata: { discord_user_id: discordUserId } },
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

      expect(res.statusCode).toBe(200);

      const rows = await pool.query('SELECT processing_result FROM payjp_events WHERE id = $1', [eventId]);
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].processing_result).toBe('ignored');

      // members が更新されていないこと
      const member = await pool.query('SELECT subscription_status FROM members WHERE discord_user_id = $1', [
        discordUserId,
      ]);
      expect(member.rows[0].subscription_status).toBe('trial');
      expect(syncRole).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // グループ 3: 必須フィールドバリデーション
  // =========================================================================
  describe('必須フィールドバリデーション', () => {
    it('7. event.id が欠損している場合 → 200 + processing_result = failed', async () => {
      const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool, syncRole) });
      // id を undefined にするため、makeWebhookEvent の戻り値から id を削除
      const event = makeWebhookEvent() as Record<string, unknown>;
      delete event.id;

      const res = await app.inject({
        method: 'POST',
        url: '/v1/payjp/webhook',
        headers: {
          'content-type': 'application/json',
          'x-payjp-webhook-token': E2E_WEBHOOK_TOKEN,
        },
        payload: event,
      });

      expect(res.statusCode).toBe(200);

      // id が unknown-* で始まるレコードが 1 件挿入されていること
      const rows = await pool.query("SELECT processing_result FROM payjp_events WHERE id LIKE 'unknown-%'");
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].processing_result).toBe('failed');
    });

    it('8. subscription.updated で data.status が欠損 → 200 + processing_result = failed かつ members 更新なし', async () => {
      const discordUserId = `discord-ns-${randomUUID().slice(0, 8)}`;
      await insertMember(pool, { discordUserId, subscriptionStatus: 'trial' });

      const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool, syncRole) });
      const eventId = `evnt_${randomUUID().slice(0, 8)}`;

      // status を含まない data
      const event = makeWebhookEvent({
        id: eventId,
        type: 'subscription.updated',
        data: {
          id: 'sub_test_e2e',
          object: 'subscription',
          metadata: { discord_user_id: discordUserId },
          // status intentionally omitted
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

      expect(res.statusCode).toBe(200);

      const rows = await pool.query('SELECT processing_result FROM payjp_events WHERE id = $1', [eventId]);
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].processing_result).toBe('failed');

      // members の subscription_status は変更されていないこと
      const member = await pool.query('SELECT subscription_status FROM members WHERE discord_user_id = $1', [
        discordUserId,
      ]);
      expect(member.rows[0].subscription_status).toBe('trial');
    });
  });

  // =========================================================================
  // グループ 4: 不明 status の fail-close
  // =========================================================================
  describe('不明 status の fail-close', () => {
    it('9. data.status が不明な値 → processing_result = failed かつ syncRole が revoke で呼ばれる', async () => {
      const discordUserId = `discord-us-${randomUUID().slice(0, 8)}`;
      await insertMember(pool, { discordUserId, subscriptionStatus: 'active' });

      const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool, syncRole) });
      const eventId = `evnt_${randomUUID().slice(0, 8)}`;
      const event = makeWebhookEvent({
        id: eventId,
        data: {
          id: 'sub_test_e2e',
          object: 'subscription',
          status: 'unknown_status',
          metadata: { discord_user_id: discordUserId },
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

      expect(res.statusCode).toBe(200);

      const rows = await pool.query('SELECT processing_result FROM payjp_events WHERE id = $1', [eventId]);
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].processing_result).toBe('failed');

      expect(syncRole).toHaveBeenCalledWith(discordUserId, 'revoke');
    });
  });

  // =========================================================================
  // グループ 5: 同秒・古いイベント処理
  // =========================================================================
  describe('同秒・古いイベント処理', () => {
    it('10. event.created == member.last_payjp_event_created_at (同秒) → 処理される (ignored にならない)', async () => {
      const discordUserId = `discord-ss-${randomUUID().slice(0, 8)}`;
      // 同秒: lastEventCreatedAt と eventCreated を同じ値にする
      const sameSecond = DEFAULT_EVENT_CREATED;
      await insertMember(pool, { discordUserId, subscriptionStatus: 'trial', lastEventCreatedAt: sameSecond });

      const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool, syncRole) });
      const eventId = `evnt_${randomUUID().slice(0, 8)}`;
      const event = makeWebhookEvent({
        id: eventId,
        created: sameSecond,
        data: {
          id: 'sub_test_e2e',
          object: 'subscription',
          status: 'active',
          metadata: { discord_user_id: discordUserId },
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

      expect(res.statusCode).toBe(200);

      const rows = await pool.query('SELECT processing_result FROM payjp_events WHERE id = $1', [eventId]);
      expect(rows.rows).toHaveLength(1);
      // 同秒は stale ではないので processed になること
      expect(rows.rows[0].processing_result).toBe('processed');
    });

    it('11. event.created < member.last_payjp_event_created_at (古いイベント) → processing_result = ignored', async () => {
      const discordUserId = `discord-st-${randomUUID().slice(0, 8)}`;
      const newerTimestamp = DEFAULT_EVENT_CREATED + 500;
      await insertMember(pool, { discordUserId, lastEventCreatedAt: newerTimestamp });

      const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool, syncRole) });
      const eventId = `evnt_${randomUUID().slice(0, 8)}`;
      const event = makeWebhookEvent({
        id: eventId,
        created: DEFAULT_EVENT_CREATED, // 古い
        data: {
          id: 'sub_test_e2e',
          object: 'subscription',
          status: 'active',
          metadata: { discord_user_id: discordUserId },
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

      expect(res.statusCode).toBe(200);

      const rows = await pool.query('SELECT processing_result FROM payjp_events WHERE id = $1', [eventId]);
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].processing_result).toBe('ignored');
    });
  });

  // =========================================================================
  // グループ 6: 冪等性
  // =========================================================================
  describe('冪等性', () => {
    it('12. 同一 event.id を 2 回送信 → 2 回目も 200 かつ payjp_events のレコードは 1 件', async () => {
      const discordUserId = `discord-idm-${randomUUID().slice(0, 8)}`;
      await insertMember(pool, { discordUserId });

      const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool, syncRole) });
      const eventId = `evnt_${randomUUID().slice(0, 8)}`;
      const event = makeWebhookEvent({
        id: eventId,
        data: {
          id: 'sub_test_e2e',
          object: 'subscription',
          status: 'active',
          metadata: { discord_user_id: discordUserId },
        },
      });

      const headers = { 'content-type': 'application/json', 'x-payjp-webhook-token': E2E_WEBHOOK_TOKEN };

      const res1 = await app.inject({ method: 'POST', url: '/v1/payjp/webhook', headers, payload: event });
      const res2 = await app.inject({ method: 'POST', url: '/v1/payjp/webhook', headers, payload: event });

      expect(res1.statusCode).toBe(200);
      expect(res2.statusCode).toBe(200);

      const rows = await pool.query('SELECT COUNT(*)::int AS cnt FROM payjp_events WHERE id = $1', [eventId]);
      expect(rows.rows[0].cnt).toBe(1);

      // syncRole は 1 回のみ
      expect(syncRole).toHaveBeenCalledOnce();
    });
  });

  // =========================================================================
  // グループ 7: discord_user_id 解決
  // =========================================================================
  describe('discord_user_id 解決', () => {
    it('13. data.metadata.discord_user_id が存在する → 正しい member を解決して処理', async () => {
      const discordUserId = `discord-meta-${randomUUID().slice(0, 8)}`;
      await insertMember(pool, { discordUserId, subscriptionStatus: 'trial' });

      const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool, syncRole) });
      const eventId = `evnt_${randomUUID().slice(0, 8)}`;
      const event = makeWebhookEvent({
        id: eventId,
        data: {
          id: 'sub_test_e2e',
          object: 'subscription',
          status: 'active',
          metadata: { discord_user_id: discordUserId },
        },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/payjp/webhook',
        headers: { 'content-type': 'application/json', 'x-payjp-webhook-token': E2E_WEBHOOK_TOKEN },
        payload: event,
      });

      expect(res.statusCode).toBe(200);

      const member = await pool.query('SELECT subscription_status FROM members WHERE discord_user_id = $1', [
        discordUserId,
      ]);
      expect(member.rows[0].subscription_status).toBe('active');
    });

    it('14. metadata.discord_user_id なし → payjp_subscription_id による逆引きで member を解決', async () => {
      const discordUserId = `discord-rev-${randomUUID().slice(0, 8)}`;
      const subId = `sub_rev_${randomUUID().slice(0, 8)}`;
      await insertMember(pool, { discordUserId, subscriptionId: subId, subscriptionStatus: 'trial' });

      const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool, syncRole) });
      const eventId = `evnt_${randomUUID().slice(0, 8)}`;
      const event = makeWebhookEvent({
        id: eventId,
        data: {
          id: subId, // metadata なし → data.id で逆引き
          object: 'subscription',
          status: 'active',
          // metadata omitted intentionally
        },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/payjp/webhook',
        headers: { 'content-type': 'application/json', 'x-payjp-webhook-token': E2E_WEBHOOK_TOKEN },
        payload: event,
      });

      expect(res.statusCode).toBe(200);

      const rows = await pool.query('SELECT processing_result FROM payjp_events WHERE id = $1', [eventId]);
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].processing_result).toBe('processed');

      const member = await pool.query('SELECT subscription_status FROM members WHERE discord_user_id = $1', [
        discordUserId,
      ]);
      expect(member.rows[0].subscription_status).toBe('active');
    });

    it('15. 逆引きでも一致する member が存在しない → processing_result = failed', async () => {
      const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool, syncRole) });
      const eventId = `evnt_${randomUUID().slice(0, 8)}`;
      const event = makeWebhookEvent({
        id: eventId,
        data: {
          id: 'sub_nonexistent_xyz', // DB に存在しない subscription_id
          object: 'subscription',
          status: 'active',
          // metadata.discord_user_id も指定しない
        },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/payjp/webhook',
        headers: { 'content-type': 'application/json', 'x-payjp-webhook-token': E2E_WEBHOOK_TOKEN },
        payload: event,
      });

      expect(res.statusCode).toBe(200);

      const rows = await pool.query('SELECT processing_result FROM payjp_events WHERE id = $1', [eventId]);
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].processing_result).toBe('failed');
    });

    it('16. metadata と逆引きが異なる discord_user_id を指す → processing_result = failed', async () => {
      // 2 人の member を登録 — それぞれ別の subscription_id
      const userA = `discord-ca-${randomUUID().slice(0, 8)}`;
      const userB = `discord-cb-${randomUUID().slice(0, 8)}`;
      const subIdB = `sub_cb_${randomUUID().slice(0, 8)}`;

      await insertMember(pool, { discordUserId: userA, subscriptionId: 'sub_test_e2e_a' });
      await insertMember(pool, { discordUserId: userB, subscriptionId: subIdB, customerId: 'cus_test_e2e_b' });

      const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool, syncRole) });
      const eventId = `evnt_${randomUUID().slice(0, 8)}`;
      // metadata は userA を指すが、data.id は userB の subscription_id を指す → 競合
      const event = makeWebhookEvent({
        id: eventId,
        data: {
          id: subIdB,
          object: 'subscription',
          status: 'active',
          metadata: { discord_user_id: userA },
        },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/payjp/webhook',
        headers: { 'content-type': 'application/json', 'x-payjp-webhook-token': E2E_WEBHOOK_TOKEN },
        payload: event,
      });

      expect(res.statusCode).toBe(200);

      const rows = await pool.query('SELECT processing_result FROM payjp_events WHERE id = $1', [eventId]);
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].processing_result).toBe('failed');
    });
  });

  // =========================================================================
  // グループ 8: operation_id 保存
  // =========================================================================
  describe('operation_id 保存', () => {
    it('17. data.metadata.operation_id が存在する → payload._processing.data_metadata_operation_id に保存される', async () => {
      const discordUserId = `discord-opid-${randomUUID().slice(0, 8)}`;
      await insertMember(pool, { discordUserId });

      const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool, syncRole) });
      const eventId = `evnt_${randomUUID().slice(0, 8)}`;
      const operationId = `op_${randomUUID()}`;
      const event = makeWebhookEvent({
        id: eventId,
        data: {
          id: 'sub_test_e2e',
          object: 'subscription',
          status: 'active',
          metadata: { discord_user_id: discordUserId, operation_id: operationId },
        },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/payjp/webhook',
        headers: { 'content-type': 'application/json', 'x-payjp-webhook-token': E2E_WEBHOOK_TOKEN },
        payload: event,
      });

      expect(res.statusCode).toBe(200);

      // payload JSONB の _processing.data_metadata_operation_id で確認
      const rows = await pool.query(
        `SELECT payload->'_processing'->>'data_metadata_operation_id' AS op_id
           FROM payjp_events WHERE id = $1`,
        [eventId],
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].op_id).toBe(operationId);
    });

    it('18. data.metadata.operation_id が存在しない → payload._processing.data_metadata_operation_id は null', async () => {
      const discordUserId = `discord-nopid-${randomUUID().slice(0, 8)}`;
      await insertMember(pool, { discordUserId });

      const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool, syncRole) });
      const eventId = `evnt_${randomUUID().slice(0, 8)}`;
      const event = makeWebhookEvent({
        id: eventId,
        data: {
          id: 'sub_test_e2e',
          object: 'subscription',
          status: 'active',
          metadata: { discord_user_id: discordUserId },
          // operation_id omitted
        },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/payjp/webhook',
        headers: { 'content-type': 'application/json', 'x-payjp-webhook-token': E2E_WEBHOOK_TOKEN },
        payload: event,
      });

      expect(res.statusCode).toBe(200);

      const rows = await pool.query(
        `SELECT payload->'_processing'->>'data_metadata_operation_id' AS op_id
           FROM payjp_events WHERE id = $1`,
        [eventId],
      );
      expect(rows.rows).toHaveLength(1);
      // キー自体が存在しないか null
      expect(rows.rows[0].op_id).toBeNull();
    });
  });

  // =========================================================================
  // グループ 9: plan / period 更新挙動
  // =========================================================================
  describe('plan / period 更新挙動', () => {
    it('19. data.plan.id が存在する → members.payjp_plan_id が更新される', async () => {
      const discordUserId = `discord-plan-${randomUUID().slice(0, 8)}`;
      await insertMember(pool, { discordUserId, planId: 'plan_old' });

      const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool, syncRole) });
      const eventId = `evnt_${randomUUID().slice(0, 8)}`;
      const event = makeWebhookEvent({
        id: eventId,
        data: {
          id: 'sub_test_e2e',
          object: 'subscription',
          status: 'active',
          metadata: { discord_user_id: discordUserId },
          plan: { id: 'plan_new_e2e' },
        },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/payjp/webhook',
        headers: { 'content-type': 'application/json', 'x-payjp-webhook-token': E2E_WEBHOOK_TOKEN },
        payload: event,
      });

      expect(res.statusCode).toBe(200);

      const member = await pool.query('SELECT payjp_plan_id FROM members WHERE discord_user_id = $1', [discordUserId]);
      expect(member.rows[0].payjp_plan_id).toBe('plan_new_e2e');
    });

    it('20. data.plan.id が存在しない → members.payjp_plan_id は変更されない (既存値を保持)', async () => {
      const discordUserId = `discord-noplan-${randomUUID().slice(0, 8)}`;
      await insertMember(pool, { discordUserId, planId: 'plan_keep_existing' });

      const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool, syncRole) });
      const eventId = `evnt_${randomUUID().slice(0, 8)}`;
      // plan フィールドを含まない event
      const event = makeWebhookEvent({
        id: eventId,
        data: {
          id: 'sub_test_e2e',
          object: 'subscription',
          status: 'active',
          metadata: { discord_user_id: discordUserId },
          // plan intentionally omitted
        },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/payjp/webhook',
        headers: { 'content-type': 'application/json', 'x-payjp-webhook-token': E2E_WEBHOOK_TOKEN },
        payload: event,
      });

      expect(res.statusCode).toBe(200);

      const member = await pool.query('SELECT payjp_plan_id FROM members WHERE discord_user_id = $1', [discordUserId]);
      expect(member.rows[0].payjp_plan_id).toBe('plan_keep_existing');
    });
  });
});
