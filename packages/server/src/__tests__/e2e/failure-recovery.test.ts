/**
 * E2E テスト — 503 障害注入 + CLI operationId リカバリ (Issue #40, T-P0-04)
 *
 * カバレッジ:
 *   - createSubscription タイムアウト → 503 + operationId
 *   - 503 後の DB 状態: inflight_operation_* が設定されている
 *   - 503 後の再リクエスト → 同一 operationId で INFLIGHT_OPERATION 返却、PAY.JP 呼び出しなし
 *   - CLI --operation-id: 正常リカバリ、DB 更新、inflight クリア
 *   - CLI リカバリ: 既存 charge_id あり → charge 検索スキップ
 *   - CLI リカバリ: charge metadata 一致 → 既存 charge 使用
 *   - CLI リカバリ: payjp_customer_id NULL → fail-close, member_impact_logs 記録
 *   - CLI リカバリ: 複数 charge 一致 → fail-close
 *   - CLI リカバリ: pagination 上限超過 (has_more=true at offset 900) → fail-close
 *   - CLI リカバリ: last_payjp_event_created_at 更新
 *   - CLI 出力フォーマット: result オブジェクトのフィールド
 *   - CLI 終了コード: 0/1/2
 *   - 不正フラグ: exitCode=1
 *   - 相互排他フラグ: --operation-id + --discord-user-id → exitCode=1
 *   - 日次 resync: inflight を持つ member をスキップし inflight を保持
 *   - createCharge タイムアウト → 503 + operationId、payjp_customer_id 設定済み/charge_id 未設定
 *
 * 前提: DATABASE_URL_TEST または DATABASE_URL が設定済みの PostgreSQL に接続可能であること。
 */

import { randomUUID } from 'node:crypto';
import { runResyncCli } from '@hayane/sync-service';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildE2EApp,
  closePool,
  createTestDb,
  E2E_BILLING_CONFIG,
  insertLinkedSession,
  makeCliDeps,
  makeMockPayjpClient,
  type PgDbClient,
  TEST_DB_URL,
  truncateAll,
} from './helpers.js';

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------

const hasTestDb = Boolean(TEST_DB_URL);

/** 旧フィクスチャ: email のみで member を作るケース（discord_user_id は後続リンクまで NULL） */
const FAILURE_RECOVERY_SUBSCRIBE_EMAIL = 'failure-recovery-test@example.com';

// PAY.JP createSubscription の不確定失敗を模倣するエラー
function makeTimeoutError(): Error {
  const err = new Error('ETIMEDOUT') as NodeJS.ErrnoException;
  err.code = 'ETIMEDOUT';
  return err;
}

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

/** POST /v1/subscriptions を実行して結果を返す */
async function postSubscribe(
  app: ReturnType<typeof buildE2EApp>,
  linkToken: string,
  planId = E2E_BILLING_CONFIG.allowedPlanIds[0],
) {
  return app.inject({
    method: 'POST',
    url: '/v1/subscriptions',
    headers: { 'content-type': 'application/json', origin: 'https://example.com' },
    cookies: { '__Host-link_session': linkToken },
    body: JSON.stringify({
      planId,
      email: FAILURE_RECOVERY_SUBSCRIBE_EMAIL,
      payjpToken: 'tok_test_e2e',
      privacyConsented: true,
    }),
  });
}

/** members テーブルから discord_user_id で 1 行取得する */
async function getMember(pool: pg.Pool, discordUserId: string): Promise<Record<string, unknown> | undefined> {
  const res = await pool.query('SELECT * FROM members WHERE discord_user_id = $1', [discordUserId]);
  return res.rows[0] as Record<string, unknown> | undefined;
}

/** subscribe 後の member 行は email で突き合わせる（discord_user_id は link-discord まで NULL の旧パターン） */
async function getMemberByEmail(pool: pg.Pool, email: string): Promise<Record<string, unknown> | undefined> {
  const res = await pool.query('SELECT * FROM members WHERE email = $1', [email]);
  return res.rows[0] as Record<string, unknown> | undefined;
}

/** member_impact_logs を member_id で取得する */
async function getImpactLogs(pool: pg.Pool, memberId: string): Promise<Array<Record<string, unknown>>> {
  const res = await pool.query('SELECT * FROM member_impact_logs WHERE member_id = $1', [memberId]);
  return res.rows as Array<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// テストスイート
// ---------------------------------------------------------------------------

describe.skipIf(!hasTestDb)('E2E 503 障害注入 + CLI リカバリ — T-P0-04', () => {
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
  // グループ 1: HTTP 経由での 503 注入
  // =========================================================================

  describe('503 注入 — HTTP', () => {
    it('Scenario 1: createSubscription タイムアウト → 503 + operationId', async () => {
      const discordUserId = `user-${randomUUID()}`;
      const payjpMock = makeMockPayjpClient();
      payjpMock.createSubscription = vi.fn().mockRejectedValue(makeTimeoutError());

      const app = buildE2EApp(pgDb, { payjp: payjpMock });
      const { rawToken } = await insertLinkedSession(pgDb, discordUserId);

      const res = await postSubscribe(app, rawToken);

      expect(res.statusCode).toBe(503);
      const body = res.json<{ ok: boolean; errorCode: string; operationId?: string }>();
      expect(body.ok).toBe(false);
      expect(body.errorCode).toBe('PAYJP_UNCERTAIN');
      expect(typeof body.operationId).toBe('string');
      expect(body.operationId!.length).toBeGreaterThan(0);
    });

    it('Scenario 2: 503 後の DB 状態 — inflight_operation_* が設定されている', async () => {
      const discordUserId = `user-${randomUUID()}`;
      const payjpMock = makeMockPayjpClient();
      payjpMock.createSubscription = vi.fn().mockRejectedValue(makeTimeoutError());

      const app = buildE2EApp(pgDb, { payjp: payjpMock });
      const { rawToken } = await insertLinkedSession(pgDb, discordUserId);

      const res = await postSubscribe(app, rawToken);
      expect(res.statusCode).toBe(503);
      const { operationId } = res.json<{ operationId: string }>();

      const member = await getMemberByEmail(pool, FAILURE_RECOVERY_SUBSCRIBE_EMAIL);
      expect(member).toBeDefined();
      expect(member!.inflight_operation_id).toBe(operationId);
      expect(member!.inflight_operation_type).toBe('subscribe');
      expect(member!.inflight_operation_started_at).not.toBeNull();
    });

    it('Scenario 3: 503 後の再リクエスト → 同一 operationId / PAY.JP 未呼び出し', async () => {
      const discordUserId = `user-${randomUUID()}`;
      const payjpMock = makeMockPayjpClient();
      payjpMock.createSubscription = vi.fn().mockRejectedValue(makeTimeoutError());

      const app = buildE2EApp(pgDb, { payjp: payjpMock });

      // 1 回目のリクエスト
      const { rawToken: token1 } = await insertLinkedSession(pgDb, discordUserId);
      const res1 = await postSubscribe(app, token1);
      expect(res1.statusCode).toBe(503);
      const { operationId: firstOperationId } = res1.json<{ operationId: string }>();

      // createSubscription の呼び出し回数をリセット
      vi.mocked(payjpMock.createSubscription).mockClear();

      // 2 回目のリクエスト（新しい link_session）
      const { rawToken: token2 } = await insertLinkedSession(pgDb, discordUserId);
      const res2 = await postSubscribe(app, token2);

      expect(res2.statusCode).toBe(503);
      const body2 = res2.json<{ ok: boolean; errorCode: string; operationId: string }>();
      // INFLIGHT_OPERATION として同一 operationId が返る
      expect(body2.errorCode).toBe('INFLIGHT_OPERATION');
      expect(body2.operationId).toBe(firstOperationId);
      // PAY.JP が再び呼ばれていない
      expect(payjpMock.createSubscription).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // グループ 2: CLI リカバリ (--operation-id)
  // =========================================================================

  describe('CLI リカバリ — --operation-id', () => {
    it('Scenario 4: 正常リカバリ — charge 見つかり subscription 作成、DB 更新、inflight クリア', async () => {
      const discordUserId = `user-${randomUUID()}`;
      const operationId = randomUUID();
      const memberId = randomUUID();

      await pool.query(
        `INSERT INTO members (id, discord_user_id, email, subscription_status, payjp_customer_id, inflight_operation_id, inflight_operation_type, inflight_operation_started_at, inflight_subscribe_plan_id)
         VALUES ($1, $2, $3, NULL, $4, $5, 'subscribe', NOW(), $6)`,
        [
          memberId,
          discordUserId,
          `${discordUserId}@e2e.test`,
          'cus_test_e2e',
          operationId,
          E2E_BILLING_CONFIG.allowedPlanIds[0],
        ],
      );

      const cliDeps = makeCliDeps(pool, {
        listPayjpCharges: vi.fn().mockResolvedValue({
          data: [{ id: 'ch_found', metadata: { operation_id: operationId } }],
          has_more: false,
        }),
        createPayjpSubscription: vi.fn().mockResolvedValue({ id: 'sub_cli_recovered', status: 'active' }),
        getPayjpSubscription: vi.fn().mockResolvedValue({
          id: 'sub_cli_recovered',
          status: 'active',
          metadata: { discord_user_id: discordUserId },
          current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
        }),
      });

      const output = await runResyncCli(['--operation-id', operationId], cliDeps);

      expect(output.exitCode).toBe(0);

      const member = await getMember(pool, discordUserId);
      expect(member!.inflight_operation_id).toBeNull();
      expect(member!.inflight_operation_type).toBeNull();
      expect(member!.inflight_operation_started_at).toBeNull();
      expect(member!.payjp_subscription_id).toBe('sub_cli_recovered');
      expect(member!.subscription_status).toBe('active');
    });

    it('Scenario 5: 既存 charge_id あり → charge 検索スキップ、subscription 直接作成', async () => {
      const discordUserId = `user-${randomUUID()}`;
      const operationId = randomUUID();
      const memberId = randomUUID();

      await pool.query(
        `INSERT INTO members (id, discord_user_id, email, subscription_status, payjp_customer_id, payjp_initial_charge_id, inflight_operation_id, inflight_operation_type, inflight_operation_started_at, inflight_subscribe_plan_id)
         VALUES ($1, $2, $3, NULL, $4, $5, $6, 'subscribe', NOW(), $7)`,
        [
          memberId,
          discordUserId,
          `${discordUserId}@e2e.test`,
          'cus_test_e2e',
          'ch_pre_existing',
          operationId,
          E2E_BILLING_CONFIG.allowedPlanIds[0],
        ],
      );

      const listPayjpCharges = vi.fn().mockResolvedValue({ data: [], has_more: false });
      const createPayjpSubscription = vi.fn().mockResolvedValue({ id: 'sub_from_existing_charge', status: 'trial' });
      const getPayjpSubscription = vi.fn().mockResolvedValue({
        id: 'sub_from_existing_charge',
        status: 'trial',
        metadata: { discord_user_id: discordUserId },
        current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
      });

      const cliDeps = makeCliDeps(pool, { listPayjpCharges, createPayjpSubscription, getPayjpSubscription });

      const output = await runResyncCli(['--operation-id', operationId], cliDeps);

      expect(output.exitCode).toBe(0);
      // charge 検索は呼ばれない（payjp_initial_charge_id が設定済みのため）
      expect(listPayjpCharges).not.toHaveBeenCalled();
      expect(createPayjpSubscription).toHaveBeenCalledOnce();

      const member = await getMember(pool, discordUserId);
      expect(member!.inflight_operation_id).toBeNull();
      expect(member!.payjp_subscription_id).toBe('sub_from_existing_charge');
    });

    it('Scenario 6: charge が metadata 一致で見つかる → 既存 charge 使用', async () => {
      const discordUserId = `user-${randomUUID()}`;
      const operationId = randomUUID();
      const memberId = randomUUID();

      await pool.query(
        `INSERT INTO members (id, discord_user_id, email, subscription_status, payjp_customer_id, inflight_operation_id, inflight_operation_type, inflight_operation_started_at, inflight_subscribe_plan_id)
         VALUES ($1, $2, $3, NULL, $4, $5, 'subscribe', NOW(), $6)`,
        [
          memberId,
          discordUserId,
          `${discordUserId}@e2e.test`,
          'cus_test_e2e',
          operationId,
          E2E_BILLING_CONFIG.allowedPlanIds[0],
        ],
      );

      const createPayjpCharge = vi.fn().mockResolvedValue({ id: 'ch_should_not_create' });
      const cliDeps = makeCliDeps(pool, {
        listPayjpCharges: vi.fn().mockResolvedValue({
          data: [{ id: 'ch_metadata_match', metadata: { operation_id: operationId } }],
          has_more: false,
        }),
        createPayjpCharge,
        getPayjpSubscription: vi.fn().mockResolvedValue({
          id: 'sub_cli_e2e',
          status: 'active',
          metadata: { discord_user_id: discordUserId },
          current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
        }),
      });

      const output = await runResyncCli(['--operation-id', operationId], cliDeps);

      expect(output.exitCode).toBe(0);
      // 既存 charge を使用したため createPayjpCharge は呼ばれない
      expect(createPayjpCharge).not.toHaveBeenCalled();

      const member = await getMember(pool, discordUserId);
      expect(member!.payjp_initial_charge_id).toBe('ch_metadata_match');
    });

    it('Scenario 7: payjp_customer_id が NULL → fail-close, member_impact_logs 記録', async () => {
      const discordUserId = `user-${randomUUID()}`;
      const operationId = randomUUID();
      const memberId = randomUUID();

      // payjp_customer_id を NULL のまま挿入（plan は必須 — CLI は customer 欠落で fail-close）
      await pool.query(
        `INSERT INTO members (id, discord_user_id, email, subscription_status, payjp_customer_id, inflight_operation_id, inflight_operation_type, inflight_operation_started_at, inflight_subscribe_plan_id)
         VALUES ($1, $2, $3, NULL, NULL, $4, 'subscribe', NOW(), $5)`,
        [memberId, discordUserId, `${discordUserId}@e2e.test`, operationId, E2E_BILLING_CONFIG.allowedPlanIds[0]],
      );

      const cliDeps = makeCliDeps(pool);
      const output = await runResyncCli(['--operation-id', operationId], cliDeps);

      expect(output.exitCode).toBe(2);

      const logs = await getImpactLogs(pool, memberId);
      const failLog = logs.find((l) => l.issue_code === 'subscribe_recovery_no_customer');
      expect(failLog).toBeDefined();
    });

    it('Scenario 8: 複数 charge が operation_id と一致 (2+) → fail-close', async () => {
      const discordUserId = `user-${randomUUID()}`;
      const operationId = randomUUID();
      const memberId = randomUUID();

      await pool.query(
        `INSERT INTO members (id, discord_user_id, email, subscription_status, payjp_customer_id, inflight_operation_id, inflight_operation_type, inflight_operation_started_at, inflight_subscribe_plan_id)
         VALUES ($1, $2, $3, NULL, $4, $5, 'subscribe', NOW(), $6)`,
        [
          memberId,
          discordUserId,
          `${discordUserId}@e2e.test`,
          'cus_test_e2e',
          operationId,
          E2E_BILLING_CONFIG.allowedPlanIds[0],
        ],
      );

      const cliDeps = makeCliDeps(pool, {
        listPayjpCharges: vi.fn().mockResolvedValue({
          data: [
            { id: 'ch_ambiguous_1', metadata: { operation_id: operationId } },
            { id: 'ch_ambiguous_2', metadata: { operation_id: operationId } },
          ],
          has_more: false,
        }),
      });

      const output = await runResyncCli(['--operation-id', operationId], cliDeps);

      expect(output.exitCode).toBe(2);

      const logs = await getImpactLogs(pool, memberId);
      const ambiguousLog = logs.find((l) => l.issue_code === 'subscribe_recovery_charge_ambiguous');
      expect(ambiguousLog).toBeDefined();
    });

    it('Scenario 9: pagination 上限 (offset=900 で has_more=true) → fail-close', async () => {
      const discordUserId = `user-${randomUUID()}`;
      const operationId = randomUUID();
      const memberId = randomUUID();

      await pool.query(
        `INSERT INTO members (id, discord_user_id, email, subscription_status, payjp_customer_id, inflight_operation_id, inflight_operation_type, inflight_operation_started_at, inflight_subscribe_plan_id)
         VALUES ($1, $2, $3, NULL, $4, $5, 'subscribe', NOW(), $6)`,
        [
          memberId,
          discordUserId,
          `${discordUserId}@e2e.test`,
          'cus_test_e2e',
          operationId,
          E2E_BILLING_CONFIG.allowedPlanIds[0],
        ],
      );

      // 各ページは一致なし、最後のページで has_more=true のまま
      const listPayjpCharges = vi
        .fn()
        .mockImplementation(
          (_params: unknown, offset: number): Promise<{ data: Array<{ id: string }>; has_more: boolean }> => {
            if (offset >= 900) {
              return Promise.resolve({ data: [], has_more: true });
            }
            return Promise.resolve({ data: [], has_more: true });
          },
        );

      const cliDeps = makeCliDeps(pool, { listPayjpCharges });
      const output = await runResyncCli(['--operation-id', operationId], cliDeps);

      expect(output.exitCode).toBe(2);

      const logs = await getImpactLogs(pool, memberId);
      const ambiguousLog = logs.find((l) => l.issue_code === 'subscribe_recovery_charge_ambiguous');
      expect(ambiguousLog).toBeDefined();
    });

    it('Scenario 10: リカバリ後に last_payjp_event_created_at が更新される', async () => {
      const discordUserId = `user-${randomUUID()}`;
      const operationId = randomUUID();
      const memberId = randomUUID();
      const oldTimestamp = Math.floor(Date.now() / 1000) - 86400; // 1 日前

      await pool.query(
        `INSERT INTO members (id, discord_user_id, email, subscription_status, payjp_customer_id, inflight_operation_id, inflight_operation_type, inflight_operation_started_at, last_payjp_event_created_at, inflight_subscribe_plan_id)
         VALUES ($1, $2, $3, NULL, $4, $5, 'subscribe', NOW(), $6, $7)`,
        [
          memberId,
          discordUserId,
          `${discordUserId}@e2e.test`,
          'cus_test_e2e',
          operationId,
          oldTimestamp,
          E2E_BILLING_CONFIG.allowedPlanIds[0],
        ],
      );

      const cliDeps = makeCliDeps(pool, {
        listPayjpCharges: vi.fn().mockResolvedValue({
          data: [{ id: 'ch_for_ts_test', metadata: { operation_id: operationId } }],
          has_more: false,
        }),
        getPayjpSubscription: vi.fn().mockResolvedValue({
          id: 'sub_cli_e2e',
          status: 'active',
          metadata: { discord_user_id: discordUserId },
          current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
        }),
      });

      const beforeCall = Math.floor(Date.now() / 1000);
      const output = await runResyncCli(['--operation-id', operationId], cliDeps);
      expect(output.exitCode).toBe(0);

      const member = await getMember(pool, discordUserId);
      expect(member).toBeDefined();
      const updatedTimestamp = Number(member!.last_payjp_event_created_at);
      // 古いタイムスタンプより新しく更新されている
      expect(updatedTimestamp).toBeGreaterThanOrEqual(oldTimestamp);
      // CLI 実行前の時刻以上（リカバリ時刻が反映される）
      expect(updatedTimestamp).toBeGreaterThanOrEqual(beforeCall);
    });
  });

  // =========================================================================
  // グループ 3: CLI 出力フォーマットと終了コード
  // =========================================================================

  describe('CLI 出力フォーマットと終了コード', () => {
    it('Scenario 11: result オブジェクトが必須フィールドを持つ', async () => {
      const discordUserId = `user-${randomUUID()}`;
      const operationId = randomUUID();
      const memberId = randomUUID();

      await pool.query(
        `INSERT INTO members (id, discord_user_id, email, subscription_status, payjp_customer_id, inflight_operation_id, inflight_operation_type, inflight_operation_started_at, inflight_subscribe_plan_id)
         VALUES ($1, $2, $3, NULL, $4, $5, 'subscribe', NOW(), $6)`,
        [
          memberId,
          discordUserId,
          `${discordUserId}@e2e.test`,
          'cus_test_e2e',
          operationId,
          E2E_BILLING_CONFIG.allowedPlanIds[0],
        ],
      );

      const cliDeps = makeCliDeps(pool, {
        listPayjpCharges: vi.fn().mockResolvedValue({
          data: [{ id: 'ch_format_test', metadata: { operation_id: operationId } }],
          has_more: false,
        }),
        getPayjpSubscription: vi.fn().mockResolvedValue({
          id: 'sub_cli_e2e',
          status: 'active',
          metadata: { discord_user_id: discordUserId },
          current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
        }),
      });

      const output = await runResyncCli(['--operation-id', operationId], cliDeps);

      expect(output.exitCode).toBe(0);
      const { result } = output;
      expect(typeof result.mode).toBe('string');
      expect(result.target).toBeDefined();
      expect(typeof result.processed_count).toBe('number');
      expect(typeof result.succeeded_count).toBe('number');
      expect(typeof result.failed_count).toBe('number');
      expect(result.started_at).toBeDefined();
      expect(result.finished_at).toBeDefined();
      expect(typeof result.duration_ms).toBe('number');
    });

    it('Scenario 12a: 不正フラグ → exitCode=1', async () => {
      const cliDeps = makeCliDeps(pool);
      const output = await runResyncCli(['--bad-flag'], cliDeps);
      expect(output.exitCode).toBe(1);
    });

    it('Scenario 12b: リカバリ失敗 (customer_id NULL) → exitCode=2', async () => {
      const discordUserId = `user-${randomUUID()}`;
      const operationId = randomUUID();
      const memberId = randomUUID();

      await pool.query(
        `INSERT INTO members (id, discord_user_id, email, subscription_status, payjp_customer_id, inflight_operation_id, inflight_operation_type, inflight_operation_started_at, inflight_subscribe_plan_id)
         VALUES ($1, $2, $3, NULL, NULL, $4, 'subscribe', NOW(), $5)`,
        [memberId, discordUserId, `${discordUserId}@e2e.test`, operationId, E2E_BILLING_CONFIG.allowedPlanIds[0]],
      );

      const cliDeps = makeCliDeps(pool);
      const output = await runResyncCli(['--operation-id', operationId], cliDeps);
      expect(output.exitCode).toBe(2);
    });

    it('Scenario 13: --operation-id と --discord-user-id の同時指定 → exitCode=1', async () => {
      const cliDeps = makeCliDeps(pool);
      const output = await runResyncCli(['--operation-id', randomUUID(), '--discord-user-id', 'user-123'], cliDeps);
      expect(output.exitCode).toBe(1);
    });
  });

  // =========================================================================
  // グループ 4: 日次 resync との分離
  // =========================================================================

  describe('日次 resync との分離', () => {
    it('Scenario 14: 日次 resync (--all) は inflight を保持したまま処理をスキップする', async () => {
      const discordUserId = `user-${randomUUID()}`;
      const operationId = randomUUID();
      const memberId = randomUUID();

      // 503 後の状態を直接作成
      await pool.query(
        `INSERT INTO members (id, discord_user_id, email, subscription_status, payjp_customer_id, inflight_operation_id, inflight_operation_type, inflight_operation_started_at, inflight_subscribe_plan_id)
         VALUES ($1, $2, $3, NULL, $4, $5, 'subscribe', NOW(), $6)`,
        [
          memberId,
          discordUserId,
          `${discordUserId}@e2e.test`,
          'cus_test_e2e',
          operationId,
          E2E_BILLING_CONFIG.allowedPlanIds[0],
        ],
      );

      const cliDeps = makeCliDeps(pool);
      // --all で日次 resync を実行
      const output = await runResyncCli(['--all'], cliDeps);

      // --all は inflight member をスキップ（success 扱い）するため exitCode=0
      expect(output.exitCode).toBe(0);

      // inflight は保持されたまま
      const member = await getMember(pool, discordUserId);
      expect(member!.inflight_operation_id).toBe(operationId);
      expect(member!.inflight_operation_type).toBe('subscribe');
    });
  });

  // =========================================================================
  // グループ 5: createCharge タイムアウト
  // =========================================================================

  describe('createCharge タイムアウト — HTTP', () => {
    it('Scenario 15: createCharge タイムアウト → 503 + operationId、payjp_customer_id 設定済み/charge_id 未設定', async () => {
      const discordUserId = `user-${randomUUID()}`;
      const payjpMock = makeMockPayjpClient();
      // createCharge をタイムアウトで失敗させる
      payjpMock.createCharge = vi.fn().mockRejectedValue(makeTimeoutError());

      const app = buildE2EApp(pgDb, { payjp: payjpMock });
      const { rawToken } = await insertLinkedSession(pgDb, discordUserId);

      const res = await postSubscribe(app, rawToken);

      expect(res.statusCode).toBe(503);
      const body = res.json<{ ok: boolean; errorCode: string; operationId?: string }>();
      expect(body.ok).toBe(false);
      expect(body.errorCode).toBe('PAYJP_UNCERTAIN');
      expect(typeof body.operationId).toBe('string');

      // DB 確認: payjp_customer_id は設定済み（customer 作成は成功）、charge_id は未設定
      const member = await getMemberByEmail(pool, FAILURE_RECOVERY_SUBSCRIBE_EMAIL);
      expect(member).toBeDefined();
      expect(member!.payjp_customer_id).not.toBeNull();
      expect(member!.payjp_initial_charge_id).toBeNull();
      expect(member!.inflight_operation_id).toBe(body.operationId);
    });
  });
});
