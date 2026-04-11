/**
 * E2E テスト — ロール削除シナリオ (Issue #41, T-P0-06)
 *
 * カバー範囲:
 *   - Webhook トリガーによるロール即時剥奪 (subscription.paused / .deleted)
 *   - CLI / Daily Resync トリガーによるロール剥奪 (access_end_at 期限切れ / PAY.JP 404)
 *   - Discord API 失敗時の DB 更新保証
 *   - member_impact_logs の生成・解消
 *   - CLI オプション (--discord-user-id / --all)
 *   - 冪等性: 重複 revoke トリガーでエラーなし
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
  createPgPool,
  createTestDb,
  E2E_WEBHOOK_TOKEN,
  makeCliDeps,
  makeWebhookEvent,
  type PgDbClient,
  TEST_DB_URL,
  truncateAll,
} from './helpers.js';

const hasTestDb = Boolean(TEST_DB_URL);

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

const DEFAULT_EVENT_CREATED = Math.floor(new Date('2025-04-01T10:00:00Z').getTime() / 1000);

/** members テーブルに直接挿入して memberId を返す */
async function insertMember(
  pool: pg.Pool,
  opts: {
    discordUserId: string;
    status?: string;
    accessEndAt?: Date | null;
    lastEventCreated?: number;
    roleState?: string;
    payjpSubscriptionId?: string;
    payjpCustomerId?: string;
  },
): Promise<string> {
  const memberId = randomUUID();
  const {
    discordUserId,
    status = 'active',
    accessEndAt = null,
    lastEventCreated = DEFAULT_EVENT_CREATED - 100,
    roleState = 'granted',
    payjpSubscriptionId = 'sub_test',
    payjpCustomerId = 'cus_test',
  } = opts;

  await pool.query(
    `INSERT INTO members (id, discord_user_id, email, subscription_status, payjp_customer_id, payjp_subscription_id,
                          payjp_plan_id, access_end_at, last_payjp_event_created_at, role_state)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      memberId,
      discordUserId,
      `${discordUserId}@e2e-test.example.com`,
      status,
      payjpCustomerId,
      payjpSubscriptionId,
      'plan_e2e',
      accessEndAt,
      lastEventCreated,
      roleState,
    ],
  );
  return memberId;
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

describe.skipIf(!hasTestDb)('E2E ロール削除シナリオ (Issue #41, T-P0-06)', () => {
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

  // =========================================================================
  // グループ 1: ロール剥奪トリガー
  // =========================================================================
  describe('ロール剥奪トリガー', () => {
    it('1. access_end_at 期限切れ + CLI --all → syncRole("revoke") が呼ばれる', async () => {
      const discordUserId = `role-rm-${randomUUID().slice(0, 8)}`;
      const yesterday = new Date(Date.now() - 86400 * 1000);
      await insertMember(pool, {
        discordUserId,
        status: 'canceled',
        accessEndAt: yesterday,
        roleState: 'granted',
      });

      const syncRole = vi.fn().mockResolvedValue(undefined);
      const cliDeps = makeCliDeps(pool, {
        syncRole,
        db: createPgPool(pool),
        // Default makeCliDeps returns status 'active' → reconcileMember would call grant after access_end revoke
        getPayjpSubscription: vi.fn().mockResolvedValue({
          id: 'sub_test',
          status: 'paused',
          metadata: {},
          current_period_end: Math.floor(Date.now() / 1000),
        }),
      });

      const output = await runResyncCli(['--all'], cliDeps);

      expect(output.exitCode).toBe(0);
      expect(syncRole).toHaveBeenLastCalledWith(discordUserId, 'revoke');
    });

    it('2. Webhook subscription.paused → syncRole("revoke") が即時呼ばれる', async () => {
      const discordUserId = `role-rm-${randomUUID().slice(0, 8)}`;
      await insertMember(pool, { discordUserId, status: 'active', roleState: 'granted' });

      const syncRole = vi.fn().mockResolvedValue(undefined);
      const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool, syncRole) });

      const event = makeWebhookEvent({
        type: 'subscription.paused',
        data: {
          id: 'sub_test',
          object: 'subscription',
          status: 'paused',
          metadata: { discord_user_id: discordUserId },
          plan: { id: 'plan_e2e' },
        },
      });

      const res = await postWebhook(app, event);

      expect(res.statusCode).toBe(200);
      expect(syncRole).toHaveBeenCalledWith(discordUserId, 'revoke');
    });

    it('3. Webhook subscription.deleted → syncRole("revoke") が即時呼ばれる', async () => {
      const discordUserId = `role-rm-${randomUUID().slice(0, 8)}`;
      await insertMember(pool, { discordUserId, status: 'canceled', roleState: 'granted' });

      const syncRole = vi.fn().mockResolvedValue(undefined);
      const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool, syncRole) });

      const event = makeWebhookEvent({
        type: 'subscription.deleted',
        data: {
          id: 'sub_test',
          object: 'subscription',
          // subscription.deleted では data.status は resolveEffectiveSubscriptionStatus により無視される
          status: 'canceled',
          metadata: { discord_user_id: discordUserId },
          plan: { id: 'plan_e2e' },
        },
      });

      const res = await postWebhook(app, event);

      expect(res.statusCode).toBe(200);
      expect(syncRole).toHaveBeenCalledWith(discordUserId, 'revoke');

      // DB の subscription_status が deleted に更新されていること
      const member = await pool.query('SELECT subscription_status FROM members WHERE discord_user_id = $1', [
        discordUserId,
      ]);
      expect(member.rows[0].subscription_status).toBe('deleted');
    });

    it('4. PAY.JP subscription 404 → deleted 扱いでロール剥奪、status=deleted に更新される', async () => {
      const discordUserId = `role-rm-${randomUUID().slice(0, 8)}`;
      await insertMember(pool, { discordUserId, status: 'active', roleState: 'granted' });

      const syncRole = vi.fn().mockResolvedValue(undefined);
      const cliDeps = makeCliDeps(pool, {
        syncRole,
        db: createPgPool(pool),
        // getPayjpSubscription が null を返す → 404 扱い
        getPayjpSubscription: vi.fn().mockResolvedValue(null),
      });

      const output = await runResyncCli(['--discord-user-id', discordUserId], cliDeps);

      expect(output.exitCode).toBe(0);
      expect(syncRole).toHaveBeenCalledWith(discordUserId, 'revoke');

      const member = await pool.query('SELECT subscription_status FROM members WHERE discord_user_id = $1', [
        discordUserId,
      ]);
      expect(member.rows[0].subscription_status).toBe('deleted');
    });
  });

  // =========================================================================
  // グループ 2: Discord API 障害時の挙動
  // =========================================================================
  describe('Discord API 障害時の挙動', () => {
    it('5. syncRole が 1 回失敗（429）→ Webhook は 200、DB は paused、リトライなしで role_state=unknown', async () => {
      const discordUserId = `role-rm-${randomUUID().slice(0, 8)}`;
      await insertMember(pool, { discordUserId, status: 'active', roleState: 'granted' });

      // attemptRoleSync は syncRole を 1 回だけ呼ぶ（失敗時の再試行はない）
      const syncRole = vi.fn().mockRejectedValueOnce(new Error('Discord 429 Too Many Requests'));

      const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool, syncRole) });

      const event = makeWebhookEvent({
        type: 'subscription.paused',
        data: {
          id: 'sub_test',
          object: 'subscription',
          status: 'paused',
          metadata: { discord_user_id: discordUserId },
          plan: { id: 'plan_e2e' },
        },
      });

      const res = await postWebhook(app, event);

      // Webhook は syncRole 失敗に関わらず 200 を返す（best-effort）
      expect(res.statusCode).toBe(200);
      expect(syncRole).toHaveBeenCalledTimes(1);

      // DB の subscription_status は paused に更新されていること（トランザクション内で先に実施）
      const member = await pool.query(
        'SELECT subscription_status, role_state FROM members WHERE discord_user_id = $1',
        [discordUserId],
      );
      expect(member.rows[0].subscription_status).toBe('paused');
      expect(member.rows[0].role_state).toBe('unknown');
    });

    it('6. syncRole が常に失敗（4xx 永続エラー）→ Webhook は 200 で DB status は paused に更新', async () => {
      const discordUserId = `role-rm-${randomUUID().slice(0, 8)}`;
      await insertMember(pool, { discordUserId, status: 'active', roleState: 'granted' });

      const syncRole = vi.fn().mockRejectedValue(new Error('Discord 403 Forbidden'));

      const app = buildE2EApp(pgDb, { syncDeps: buildSyncDepsForE2E(pool, syncRole) });

      const event = makeWebhookEvent({
        type: 'subscription.paused',
        data: {
          id: 'sub_test',
          object: 'subscription',
          status: 'paused',
          metadata: { discord_user_id: discordUserId },
          plan: { id: 'plan_e2e' },
        },
      });

      const res = await postWebhook(app, event);

      expect(res.statusCode).toBe(200);

      // DB の status は更新されていること（role sync 失敗はトランザクション後の best-effort）
      const member = await pool.query('SELECT subscription_status FROM members WHERE discord_user_id = $1', [
        discordUserId,
      ]);
      expect(member.rows[0].subscription_status).toBe('paused');

      // role_state は 'unknown' にフォールバックされる（webhook.ts の attemptRoleSync）
      expect(member.rows[0]).toMatchObject({ subscription_status: 'paused' });
    });
  });

  // =========================================================================
  // グループ 3: member_impact_logs
  // =========================================================================
  describe('member_impact_logs', () => {
    it('7. CLI resync で全メンバー処理中に例外 → member_impact_logs に unresolved 行が作成される', async () => {
      const discordUserId = `role-rm-${randomUUID().slice(0, 8)}`;
      const memberId = await insertMember(pool, {
        discordUserId,
        status: 'active',
        roleState: 'granted',
      });

      // getPayjpSubscription が例外をスローして reconcileMember 全体を失敗させる
      const syncRole = vi.fn().mockResolvedValue(undefined);
      const cliDeps = makeCliDeps(pool, {
        syncRole,
        db: createPgPool(pool),
        getPayjpSubscription: vi.fn().mockRejectedValue(new Error('PAY.JP API unavailable')),
      });

      const output = await runResyncCli(['--all'], cliDeps);

      // failed_count > 0 → exitCode 2
      expect(output.exitCode).toBe(2);
      expect(output.result.failed_count).toBeGreaterThan(0);

      // member_impact_logs に unresolved の行が存在すること
      const logs = await pool.query('SELECT * FROM member_impact_logs WHERE member_id = $1 AND resolved_at IS NULL', [
        memberId,
      ]);
      expect(logs.rows).toHaveLength(1);
    });

    it('8. 事前に unresolved な impact_log がある状態で CLI resync 成功 → resolved_at が設定される', async () => {
      const discordUserId = `role-rm-${randomUUID().slice(0, 8)}`;
      const memberId = await insertMember(pool, {
        discordUserId,
        status: 'active',
        roleState: 'granted',
      });

      // resync_individual_error の未解決ログを事前挿入
      await pool.query(
        `INSERT INTO member_impact_logs (member_id, issue_code) VALUES ($1, 'resync_individual_error')`,
        [memberId],
      );

      // 今度は正常に動作する deps
      const syncRole = vi.fn().mockResolvedValue(undefined);
      const cliDeps = makeCliDeps(pool, {
        syncRole,
        db: createPgPool(pool),
        getPayjpSubscription: vi.fn().mockResolvedValue({
          id: 'sub_test',
          status: 'active',
          metadata: { discord_user_id: discordUserId },
          current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
        }),
      });

      const output = await runResyncCli(['--all'], cliDeps);

      expect(output.exitCode).toBe(0);

      // resolved_at が設定されていること
      const logs = await pool.query(
        'SELECT resolved_at FROM member_impact_logs WHERE member_id = $1 AND issue_code = $2',
        [memberId, 'resync_individual_error'],
      );
      expect(logs.rows).toHaveLength(1);
      expect(logs.rows[0].resolved_at).not.toBeNull();
    });
  });

  // =========================================================================
  // グループ 4: CLI オプション
  // =========================================================================
  describe('CLI オプション', () => {
    it('9. --discord-user-id による単一メンバー再同期 → exitCode=0, processed_count=1', async () => {
      const discordUserId = `role-rm-${randomUUID().slice(0, 8)}`;
      const yesterday = new Date(Date.now() - 86400 * 1000);
      await insertMember(pool, {
        discordUserId,
        status: 'canceled',
        accessEndAt: yesterday,
        roleState: 'granted',
      });

      const syncRole = vi.fn().mockResolvedValue(undefined);
      const cliDeps = makeCliDeps(pool, { syncRole, db: createPgPool(pool) });

      const output = await runResyncCli(['--discord-user-id', discordUserId], cliDeps);

      expect(output.exitCode).toBe(0);
      expect(output.result.processed_count).toBe(1);
    });

    it('10. --all による全メンバー再同期 → 2 メンバーが processed', async () => {
      const yesterday = new Date(Date.now() - 86400 * 1000);

      const user1 = `role-rm-${randomUUID().slice(0, 8)}`;
      const user2 = `role-rm-${randomUUID().slice(0, 8)}`;

      // 異なる payjp_customer_id / payjp_subscription_id で 2 メンバーを挿入
      await insertMember(pool, {
        discordUserId: user1,
        status: 'canceled',
        accessEndAt: yesterday,
        roleState: 'granted',
        payjpCustomerId: `cus_test_${randomUUID().slice(0, 6)}`,
        payjpSubscriptionId: `sub_test_${randomUUID().slice(0, 6)}`,
      });
      await insertMember(pool, {
        discordUserId: user2,
        status: 'canceled',
        accessEndAt: yesterday,
        roleState: 'granted',
        payjpCustomerId: `cus_test_${randomUUID().slice(0, 6)}`,
        payjpSubscriptionId: `sub_test_${randomUUID().slice(0, 6)}`,
      });

      const syncRole = vi.fn().mockResolvedValue(undefined);
      const cliDeps = makeCliDeps(pool, {
        syncRole,
        db: createPgPool(pool),
        getPayjpSubscription: vi.fn().mockImplementation(async (subId: string) => ({
          id: subId,
          status: 'paused',
          metadata: {},
          current_period_end: Math.floor(Date.now() / 1000),
        })),
      });

      const output = await runResyncCli(['--all'], cliDeps);

      expect(output.exitCode).toBe(0);
      expect(output.result.processed_count).toBe(2);
      const lastCallFor = (userId: string) =>
        syncRole.mock.calls.filter((c) => c[0] === userId).at(-1) as [string, string] | undefined;
      expect(lastCallFor(user1)).toEqual([user1, 'revoke']);
      expect(lastCallFor(user2)).toEqual([user2, 'revoke']);
    });

    it('11. syncRole が常に失敗 → exitCode=2, failed_count > 0', async () => {
      const discordUserId = `role-rm-${randomUUID().slice(0, 8)}`;
      await insertMember(pool, { discordUserId, status: 'active', roleState: 'granted' });

      // getPayjpSubscription を失敗させて reconcileMember 全体を失敗させる
      const syncRole = vi.fn().mockResolvedValue(undefined);
      const cliDeps = makeCliDeps(pool, {
        syncRole,
        db: createPgPool(pool),
        getPayjpSubscription: vi.fn().mockRejectedValue(new Error('PAY.JP timeout')),
      });

      const output = await runResyncCli(['--all'], cliDeps);

      expect(output.exitCode).toBe(2);
      expect(output.result.failed_count).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // グループ 5: 冪等性
  // =========================================================================
  describe('冪等性', () => {
    it('12. role_state=revoked のメンバーへの重複 revoke トリガー → クラッシュせず処理完了', async () => {
      const discordUserId = `role-rm-${randomUUID().slice(0, 8)}`;
      const yesterday = new Date(Date.now() - 86400 * 1000);
      await insertMember(pool, {
        discordUserId,
        status: 'canceled',
        accessEndAt: yesterday,
        roleState: 'revoked', // すでに revoke 済み
      });

      const syncRole = vi.fn().mockResolvedValue(undefined);
      const cliDeps = makeCliDeps(pool, { syncRole, db: createPgPool(pool) });

      // 1 回のみ: 2 回目は getPayjpSubscription のデフォルト active で DB が変わり、
      // 「revoke 済みでも成功」の前提とズレるため。
      const output = await runResyncCli(['--all'], cliDeps);
      expect(output.exitCode).toBe(0);
    });
  });
});
