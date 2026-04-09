/**
 * E2E テスト — Webhook イベント種別・状態遷移 (Issue #21 + #48)
 *
 * カバー範囲:
 *   #21 基本 Webhook シナリオ
 *     - 正常処理 / 重複冪等 / 古いイベント無視
 *   #48 イベント種別別ステータス遷移
 *     - subscription.renewed / canceled / paused / deleted / resumed
 *     - ロール同期有無の検証
 *     - plan.id / current_period_end 更新挙動
 *     - last_payjp_event_created_at 更新
 *     - payjp_events レコード内容確認
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
// 定数
// ---------------------------------------------------------------------------

const DEFAULT_EVENT_CREATED = Math.floor(new Date('2025-04-01T10:00:00Z').getTime() / 1000);

// ---------------------------------------------------------------------------
// ヘルパー: members テーブルへの直接挿入
// ---------------------------------------------------------------------------

async function insertMember(
  pool: pg.Pool,
  opts: {
    discordUserId: string;
    subscriptionId?: string;
    customerId?: string;
    subscriptionStatus?: string;
    lastEventCreatedAt?: number | null;
    planId?: string;
    roleState?: string;
  },
): Promise<string> {
  const id = randomUUID();
  const {
    discordUserId,
    subscriptionId = 'sub_test_e2e',
    customerId = 'cus_test_e2e',
    subscriptionStatus = 'active',
    lastEventCreatedAt = DEFAULT_EVENT_CREATED - 100,
    planId = 'plan_e2e',
    roleState = 'granted',
  } = opts;

  await pool.query(
    `INSERT INTO members
       (id, discord_user_id, email, subscription_status, last_payjp_event_created_at,
        payjp_subscription_id, payjp_customer_id, payjp_plan_id, role_state)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      discordUserId,
      `${discordUserId}@e2e-test.example.com`,
      subscriptionStatus,
      lastEventCreatedAt,
      subscriptionId,
      customerId,
      planId,
      roleState,
    ],
  );
  return id;
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

// ---------------------------------------------------------------------------
// テスト本体
// ---------------------------------------------------------------------------

describe.skipIf(!hasTestDb)('E2E Webhook — イベント種別・状態遷移 (Issue #21 + #48)', () => {
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
  // グループ 1: #21 基本 Webhook シナリオ
  // =========================================================================
  describe('#21 基本 Webhook シナリオ', () => {
    it('1. 正常処理: subscription.updated + status=active → processed, member 更新', async () => {
      const discordUserId = `discord-basic-${randomUUID().slice(0, 8)}`;
      await insertMember(pool, { discordUserId, subscriptionStatus: 'trial', roleState: 'unknown' });

      const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool, syncRole) });
      const eventId = `evnt_e2e_${randomUUID().slice(0, 8)}`;
      const event = makeWebhookEvent({
        id: eventId,
        type: 'subscription.updated',
        data: {
          id: 'sub_test_e2e',
          object: 'subscription',
          status: 'active',
          metadata: { discord_user_id: discordUserId },
          plan: { id: 'plan_e2e' },
        },
      });

      const res = await postWebhook(app, event);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });

      const evtRow = await pool.query('SELECT processing_result, event_type FROM payjp_events WHERE id = $1', [
        eventId,
      ]);
      expect(evtRow.rows).toHaveLength(1);
      expect(evtRow.rows[0].processing_result).toBe('processed');
      expect(evtRow.rows[0].event_type).toBe('subscription.updated');

      const member = await pool.query('SELECT subscription_status FROM members WHERE discord_user_id = $1', [
        discordUserId,
      ]);
      expect(member.rows[0].subscription_status).toBe('active');
    });

    it('2. 重複冪等: 同一 event.id を 2 回送信 → 2 件目も 200, payjp_events は 1 件のみ', async () => {
      const discordUserId = `discord-dup-${randomUUID().slice(0, 8)}`;
      await insertMember(pool, { discordUserId });

      const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool, syncRole) });
      const eventId = `evnt_e2e_${randomUUID().slice(0, 8)}`;
      const event = makeWebhookEvent({
        id: eventId,
        data: {
          id: 'sub_test_e2e',
          object: 'subscription',
          status: 'active',
          metadata: { discord_user_id: discordUserId },
        },
      });

      const res1 = await postWebhook(app, event);
      const res2 = await postWebhook(app, event);

      expect(res1.statusCode).toBe(200);
      expect(res2.statusCode).toBe(200);

      const cnt = await pool.query('SELECT COUNT(*)::int AS cnt FROM payjp_events WHERE id = $1', [eventId]);
      expect(cnt.rows[0].cnt).toBe(1);

      // 2 回目は早期リターンするため syncRole は 1 回のみ呼ばれる
      expect(syncRole).toHaveBeenCalledOnce();
    });

    it('3. 古いイベント: event.created < last_payjp_event_created_at → processing_result = ignored, member 未更新', async () => {
      const discordUserId = `discord-stale-${randomUUID().slice(0, 8)}`;
      const newerTimestamp = DEFAULT_EVENT_CREATED + 500;
      await insertMember(pool, { discordUserId, lastEventCreatedAt: newerTimestamp, subscriptionStatus: 'active' });

      const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool, syncRole) });
      const eventId = `evnt_e2e_${randomUUID().slice(0, 8)}`;
      const event = makeWebhookEvent({
        id: eventId,
        created: DEFAULT_EVENT_CREATED, // 古い
        data: {
          id: 'sub_test_e2e',
          object: 'subscription',
          status: 'paused',
          metadata: { discord_user_id: discordUserId },
        },
      });

      const res = await postWebhook(app, event);
      expect(res.statusCode).toBe(200);

      const evtRow = await pool.query('SELECT processing_result FROM payjp_events WHERE id = $1', [eventId]);
      expect(evtRow.rows).toHaveLength(1);
      expect(evtRow.rows[0].processing_result).toBe('ignored');

      const member = await pool.query('SELECT subscription_status FROM members WHERE discord_user_id = $1', [
        discordUserId,
      ]);
      // status は変わっていないこと
      expect(member.rows[0].subscription_status).toBe('active');
      expect(syncRole).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // グループ 2: #48 イベント種別別ステータス遷移
  // =========================================================================
  describe('#48 イベント種別別ステータス遷移', () => {
    it('4. subscription.renewed → status 更新, access_end_at 更新, ロール維持 (grant)', async () => {
      const discordUserId = `discord-renew-${randomUUID().slice(0, 8)}`;
      await insertMember(pool, { discordUserId, subscriptionStatus: 'active', roleState: 'granted' });

      const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool, syncRole) });
      const eventId = `evnt_e2e_${randomUUID().slice(0, 8)}`;
      const periodEnd = DEFAULT_EVENT_CREATED + 30 * 86400;
      const event = makeWebhookEvent({
        id: eventId,
        type: 'subscription.renewed',
        data: {
          id: 'sub_test_e2e',
          object: 'subscription',
          status: 'active',
          metadata: { discord_user_id: discordUserId },
          plan: { id: 'plan_e2e' },
          current_period_end: periodEnd,
        },
      });

      const res = await postWebhook(app, event);
      expect(res.statusCode).toBe(200);

      const evtRow = await pool.query('SELECT processing_result FROM payjp_events WHERE id = $1', [eventId]);
      expect(evtRow.rows[0].processing_result).toBe('processed');

      const member = await pool.query(
        'SELECT subscription_status, access_end_at FROM members WHERE discord_user_id = $1',
        [discordUserId],
      );
      expect(member.rows[0].subscription_status).toBe('active');
      expect(member.rows[0].access_end_at).not.toBeNull();

      // active → active はステータス同一のため syncRole は呼ばれない
      expect(syncRole).not.toHaveBeenCalled();
    });

    it('5. subscription.canceled → status = canceled, role MAINTAINED (canceled は grant ステータス)', async () => {
      const discordUserId = `discord-cancel-${randomUUID().slice(0, 8)}`;
      await insertMember(pool, { discordUserId, subscriptionStatus: 'active', roleState: 'granted' });

      const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool, syncRole) });
      const eventId = `evnt_e2e_${randomUUID().slice(0, 8)}`;
      const periodEnd = DEFAULT_EVENT_CREATED + 15 * 86400;
      const event = makeWebhookEvent({
        id: eventId,
        type: 'subscription.canceled',
        data: {
          id: 'sub_test_e2e',
          object: 'subscription',
          status: 'canceled',
          metadata: { discord_user_id: discordUserId },
          plan: { id: 'plan_e2e' },
          current_period_end: periodEnd,
        },
      });

      const res = await postWebhook(app, event);
      expect(res.statusCode).toBe(200);

      const member = await pool.query(
        'SELECT subscription_status, access_end_at FROM members WHERE discord_user_id = $1',
        [discordUserId],
      );
      expect(member.rows[0].subscription_status).toBe('canceled');
      expect(member.rows[0].access_end_at).not.toBeNull();

      // canceled は GRANT_STATUSES に含まれるため syncRole は grant で呼ばれる (active→canceled でステータス変化あり)
      expect(syncRole).not.toHaveBeenCalledWith(discordUserId, 'revoke');
    });

    it('6. subscription.paused → status = paused, Discord ロール即時 revoke', async () => {
      const discordUserId = `discord-pause-${randomUUID().slice(0, 8)}`;
      await insertMember(pool, { discordUserId, subscriptionStatus: 'active', roleState: 'granted' });

      const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool, syncRole) });
      const eventId = `evnt_e2e_${randomUUID().slice(0, 8)}`;
      const event = makeWebhookEvent({
        id: eventId,
        type: 'subscription.paused',
        data: {
          id: 'sub_test_e2e',
          object: 'subscription',
          status: 'paused',
          metadata: { discord_user_id: discordUserId },
          plan: { id: 'plan_e2e' },
        },
      });

      const res = await postWebhook(app, event);
      expect(res.statusCode).toBe(200);

      const evtRow = await pool.query('SELECT processing_result FROM payjp_events WHERE id = $1', [eventId]);
      expect(evtRow.rows[0].processing_result).toBe('processed');

      const member = await pool.query('SELECT subscription_status FROM members WHERE discord_user_id = $1', [
        discordUserId,
      ]);
      expect(member.rows[0].subscription_status).toBe('paused');

      expect(syncRole).toHaveBeenCalledWith(discordUserId, 'revoke');
    });

    it('7. subscription.deleted → status = deleted, Discord ロール即時 revoke', async () => {
      const discordUserId = `discord-del-${randomUUID().slice(0, 8)}`;
      await insertMember(pool, { discordUserId, subscriptionStatus: 'canceled', roleState: 'granted' });

      const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool, syncRole) });
      const eventId = `evnt_e2e_${randomUUID().slice(0, 8)}`;
      const event = makeWebhookEvent({
        id: eventId,
        type: 'subscription.deleted',
        // subscription.deleted は resolveEffectiveSubscriptionStatus により status は常に deleted
        data: {
          id: 'sub_test_e2e',
          object: 'subscription',
          status: 'canceled', // payload の status は無視される
          metadata: { discord_user_id: discordUserId },
          plan: { id: 'plan_e2e' },
        },
      });

      const res = await postWebhook(app, event);
      expect(res.statusCode).toBe(200);

      const evtRow = await pool.query('SELECT processing_result FROM payjp_events WHERE id = $1', [eventId]);
      expect(evtRow.rows[0].processing_result).toBe('processed');

      const member = await pool.query('SELECT subscription_status FROM members WHERE discord_user_id = $1', [
        discordUserId,
      ]);
      expect(member.rows[0].subscription_status).toBe('deleted');

      expect(syncRole).toHaveBeenCalledWith(discordUserId, 'revoke');
    });

    it('8. subscription.resumed → status = active, Discord ロール grant', async () => {
      const discordUserId = `discord-resume-${randomUUID().slice(0, 8)}`;
      await insertMember(pool, { discordUserId, subscriptionStatus: 'paused', roleState: 'revoked' });

      const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool, syncRole) });
      const eventId = `evnt_e2e_${randomUUID().slice(0, 8)}`;
      const event = makeWebhookEvent({
        id: eventId,
        type: 'subscription.resumed',
        data: {
          id: 'sub_test_e2e',
          object: 'subscription',
          status: 'active',
          metadata: { discord_user_id: discordUserId },
          plan: { id: 'plan_e2e' },
        },
      });

      const res = await postWebhook(app, event);
      expect(res.statusCode).toBe(200);

      const evtRow = await pool.query('SELECT processing_result FROM payjp_events WHERE id = $1', [eventId]);
      expect(evtRow.rows[0].processing_result).toBe('processed');

      const member = await pool.query('SELECT subscription_status FROM members WHERE discord_user_id = $1', [
        discordUserId,
      ]);
      expect(member.rows[0].subscription_status).toBe('active');

      expect(syncRole).toHaveBeenCalledWith(discordUserId, 'grant');
    });
  });

  // =========================================================================
  // グループ 3: ステータス変化とロール遷移
  // =========================================================================
  describe('ステータス変化とロール遷移', () => {
    it('9. active → paused (subscription.updated): status 変化 + ロール revoke', async () => {
      const discordUserId = `discord-ap-${randomUUID().slice(0, 8)}`;
      await insertMember(pool, { discordUserId, subscriptionStatus: 'active', roleState: 'granted' });

      const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool, syncRole) });
      const eventId = `evnt_e2e_${randomUUID().slice(0, 8)}`;
      const event = makeWebhookEvent({
        id: eventId,
        type: 'subscription.updated',
        data: {
          id: 'sub_test_e2e',
          object: 'subscription',
          status: 'paused',
          metadata: { discord_user_id: discordUserId },
          plan: { id: 'plan_e2e' },
        },
      });

      const res = await postWebhook(app, event);
      expect(res.statusCode).toBe(200);

      const member = await pool.query('SELECT subscription_status FROM members WHERE discord_user_id = $1', [
        discordUserId,
      ]);
      expect(member.rows[0].subscription_status).toBe('paused');
      expect(syncRole).toHaveBeenCalledWith(discordUserId, 'revoke');
    });

    it('10. canceled → deleted (subscription.deleted): status 変化 + ロール revoke', async () => {
      const discordUserId = `discord-cd-${randomUUID().slice(0, 8)}`;
      await insertMember(pool, { discordUserId, subscriptionStatus: 'canceled', roleState: 'granted' });

      const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool, syncRole) });
      const eventId = `evnt_e2e_${randomUUID().slice(0, 8)}`;
      const event = makeWebhookEvent({
        id: eventId,
        type: 'subscription.deleted',
        data: {
          id: 'sub_test_e2e',
          object: 'subscription',
          metadata: { discord_user_id: discordUserId },
          plan: { id: 'plan_e2e' },
          // data.status は subscription.deleted では無視されるため省略可
        },
      });

      const res = await postWebhook(app, event);
      expect(res.statusCode).toBe(200);

      const member = await pool.query('SELECT subscription_status FROM members WHERE discord_user_id = $1', [
        discordUserId,
      ]);
      expect(member.rows[0].subscription_status).toBe('deleted');
      expect(syncRole).toHaveBeenCalledWith(discordUserId, 'revoke');
    });
  });

  // =========================================================================
  // グループ 4: ステータス同一 — ロール同期なし
  // =========================================================================
  describe('ステータス同一 — ロール同期なし', () => {
    it('11. active → active: plan_id 更新, syncRole 呼ばれない', async () => {
      const discordUserId = `discord-aa-${randomUUID().slice(0, 8)}`;
      await insertMember(pool, {
        discordUserId,
        subscriptionStatus: 'active',
        planId: 'plan_old_e2e',
        roleState: 'granted',
      });

      const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool, syncRole) });
      const eventId = `evnt_e2e_${randomUUID().slice(0, 8)}`;
      const event = makeWebhookEvent({
        id: eventId,
        type: 'subscription.updated',
        data: {
          id: 'sub_test_e2e',
          object: 'subscription',
          status: 'active',
          metadata: { discord_user_id: discordUserId },
          plan: { id: 'plan_new_e2e' }, // plan.id だけ変わる
        },
      });

      const res = await postWebhook(app, event);
      expect(res.statusCode).toBe(200);

      const member = await pool.query(
        'SELECT subscription_status, payjp_plan_id FROM members WHERE discord_user_id = $1',
        [discordUserId],
      );
      expect(member.rows[0].subscription_status).toBe('active');
      expect(member.rows[0].payjp_plan_id).toBe('plan_new_e2e');

      // ステータス同一なので syncRole は呼ばれない
      expect(syncRole).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // グループ 5: data.plan.id 更新挙動
  // =========================================================================
  describe('data.plan.id 更新挙動', () => {
    it('12. data.plan.id あり → members.payjp_plan_id が新値に更新される', async () => {
      const discordUserId = `discord-planup-${randomUUID().slice(0, 8)}`;
      await insertMember(pool, { discordUserId, planId: 'plan_before' });

      const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool, syncRole) });
      const eventId = `evnt_e2e_${randomUUID().slice(0, 8)}`;
      const event = makeWebhookEvent({
        id: eventId,
        data: {
          id: 'sub_test_e2e',
          object: 'subscription',
          status: 'active',
          metadata: { discord_user_id: discordUserId },
          plan: { id: 'plan_after' },
        },
      });

      await postWebhook(app, event);

      const member = await pool.query('SELECT payjp_plan_id FROM members WHERE discord_user_id = $1', [discordUserId]);
      expect(member.rows[0].payjp_plan_id).toBe('plan_after');
    });

    it('13. data.plan.id なし → members.payjp_plan_id は既存値を保持', async () => {
      const discordUserId = `discord-plankeep-${randomUUID().slice(0, 8)}`;
      await insertMember(pool, { discordUserId, planId: 'plan_keep' });

      const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool, syncRole) });
      const eventId = `evnt_e2e_${randomUUID().slice(0, 8)}`;
      const event = makeWebhookEvent({
        id: eventId,
        data: {
          id: 'sub_test_e2e',
          object: 'subscription',
          status: 'active',
          metadata: { discord_user_id: discordUserId },
          // plan フィールドを省略
        },
      });

      await postWebhook(app, event);

      const member = await pool.query('SELECT payjp_plan_id FROM members WHERE discord_user_id = $1', [discordUserId]);
      expect(member.rows[0].payjp_plan_id).toBe('plan_keep');
    });
  });

  // =========================================================================
  // グループ 6: data.current_period_end 更新挙動
  // =========================================================================
  describe('data.current_period_end 更新挙動', () => {
    it('14. current_period_end あり + active → members.access_end_at 更新', async () => {
      const discordUserId = `discord-period-${randomUUID().slice(0, 8)}`;
      await insertMember(pool, { discordUserId, subscriptionStatus: 'active' });

      const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool, syncRole) });
      const eventId = `evnt_e2e_${randomUUID().slice(0, 8)}`;
      const periodEnd = DEFAULT_EVENT_CREATED + 30 * 86400;
      const event = makeWebhookEvent({
        id: eventId,
        data: {
          id: 'sub_test_e2e',
          object: 'subscription',
          status: 'active',
          metadata: { discord_user_id: discordUserId },
          plan: { id: 'plan_e2e' },
          current_period_end: periodEnd,
        },
      });

      await postWebhook(app, event);

      const member = await pool.query('SELECT access_end_at FROM members WHERE discord_user_id = $1', [discordUserId]);
      expect(member.rows[0].access_end_at).not.toBeNull();
      // Unix タイムスタンプと誤差 1 秒以内で一致
      const storedTs = Math.floor(new Date(member.rows[0].access_end_at as string).getTime() / 1000);
      expect(storedTs).toBe(periodEnd);
    });

    it('15. current_period_end なし → members.access_end_at は既存値を保持', async () => {
      const discordUserId = `discord-noperiod-${randomUUID().slice(0, 8)}`;
      await insertMember(pool, { discordUserId, subscriptionStatus: 'active' });

      // 事前に access_end_at を設定
      const fixedEnd = new Date('2025-06-01T00:00:00Z');
      await pool.query('UPDATE members SET access_end_at = $1 WHERE discord_user_id = $2', [fixedEnd, discordUserId]);

      const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool, syncRole) });
      const eventId = `evnt_e2e_${randomUUID().slice(0, 8)}`;
      const event = makeWebhookEvent({
        id: eventId,
        data: {
          id: 'sub_test_e2e',
          object: 'subscription',
          status: 'active',
          metadata: { discord_user_id: discordUserId },
          plan: { id: 'plan_e2e' },
          // current_period_end 省略
        },
      });

      await postWebhook(app, event);

      const member = await pool.query('SELECT access_end_at FROM members WHERE discord_user_id = $1', [discordUserId]);
      const storedDate = new Date(member.rows[0].access_end_at as string);
      expect(storedDate.toISOString()).toBe(fixedEnd.toISOString());
    });
  });

  // =========================================================================
  // グループ 7: data.status 欠損
  // =========================================================================
  describe('data.status 欠損', () => {
    it('16. subscription.updated で data.status なし → processing_result = failed, members 更新なし', async () => {
      const discordUserId = `discord-nostatus-${randomUUID().slice(0, 8)}`;
      await insertMember(pool, { discordUserId, subscriptionStatus: 'active' });

      const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool, syncRole) });
      const eventId = `evnt_e2e_${randomUUID().slice(0, 8)}`;
      const event = makeWebhookEvent({
        id: eventId,
        type: 'subscription.updated',
        data: {
          id: 'sub_test_e2e',
          object: 'subscription',
          // status 意図的に省略
          metadata: { discord_user_id: discordUserId },
        },
      });

      const res = await postWebhook(app, event);
      expect(res.statusCode).toBe(200);

      const evtRow = await pool.query('SELECT processing_result FROM payjp_events WHERE id = $1', [eventId]);
      expect(evtRow.rows).toHaveLength(1);
      expect(evtRow.rows[0].processing_result).toBe('failed');

      const member = await pool.query('SELECT subscription_status FROM members WHERE discord_user_id = $1', [
        discordUserId,
      ]);
      expect(member.rows[0].subscription_status).toBe('active');
    });
  });

  // =========================================================================
  // グループ 8: last_payjp_event_created_at 更新
  // =========================================================================
  describe('last_payjp_event_created_at 更新', () => {
    it('17. 正常処理後 → members.last_payjp_event_created_at が event.created に更新される', async () => {
      const discordUserId = `discord-ts-${randomUUID().slice(0, 8)}`;
      const initialTs = DEFAULT_EVENT_CREATED - 100;
      await insertMember(pool, { discordUserId, lastEventCreatedAt: initialTs });

      const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool, syncRole) });
      const eventId = `evnt_e2e_${randomUUID().slice(0, 8)}`;
      const event = makeWebhookEvent({
        id: eventId,
        created: DEFAULT_EVENT_CREATED,
        data: {
          id: 'sub_test_e2e',
          object: 'subscription',
          status: 'active',
          metadata: { discord_user_id: discordUserId },
          plan: { id: 'plan_e2e' },
        },
      });

      await postWebhook(app, event);

      const member = await pool.query('SELECT last_payjp_event_created_at FROM members WHERE discord_user_id = $1', [
        discordUserId,
      ]);
      expect(Number(member.rows[0].last_payjp_event_created_at)).toBe(DEFAULT_EVENT_CREATED);
    });
  });

  // =========================================================================
  // グループ 9: payjp_events レコード内容
  // =========================================================================
  describe('payjp_events レコード内容', () => {
    it('18. 処理済みイベント → event_type, processing_result, data_metadata_operation_id が正しく記録される', async () => {
      const discordUserId = `discord-evtrec-${randomUUID().slice(0, 8)}`;
      await insertMember(pool, { discordUserId });

      const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool, syncRole) });
      const eventId = `evnt_e2e_${randomUUID().slice(0, 8)}`;
      const operationId = `op_${randomUUID()}`;
      const event = makeWebhookEvent({
        id: eventId,
        type: 'subscription.updated',
        data: {
          id: 'sub_test_e2e',
          object: 'subscription',
          status: 'active',
          metadata: { discord_user_id: discordUserId, operation_id: operationId },
          plan: { id: 'plan_e2e' },
        },
      });

      const res = await postWebhook(app, event);
      expect(res.statusCode).toBe(200);

      // event_type と processing_result の確認
      const evtRow = await pool.query('SELECT event_type, processing_result FROM payjp_events WHERE id = $1', [
        eventId,
      ]);
      expect(evtRow.rows).toHaveLength(1);
      expect(evtRow.rows[0].event_type).toBe('subscription.updated');
      expect(evtRow.rows[0].processing_result).toBe('processed');

      // data_metadata_operation_id は payload._processing.data_metadata_operation_id に格納される
      const opIdRow = await pool.query(
        `SELECT payload->'_processing'->>'data_metadata_operation_id' AS op_id
           FROM payjp_events WHERE id = $1`,
        [eventId],
      );
      expect(opIdRow.rows[0].op_id).toBe(operationId);
    });
  });
});
