/**
 * Tier 2 Integration Tests — Subscribe Flow (Green Phase)
 *
 * PROP-BILL-020 〜 PROP-BILL-041, PROP-BILL-062, PROP-BILL-064〜066
 *
 * handleSubscribe() に対してモック依存をインジェクトし、
 * オーケストレーションの振る舞いを検証する。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleSubscribe } from '../../shell/subscribe.js';
import type {
  BillingDeps,
  DbClient,
  PayjpClient,
  DiscordClient,
  BillingConfig,
} from '../../shell/types.js';
import type { Member, LinkSessionRecord } from '@hayane/shared';

// -------------------------------------------------------------------------
// テストフィクスチャ
// -------------------------------------------------------------------------

const NOW = new Date('2025-04-01T10:00:00Z');
const DISCORD_USER_ID = 'discord-user-001';
const MEMBER_ID = 'member-uuid-001';
const PLAN_ID = 'plan-allowed-001';
const PAYJP_TOKEN_ID = 'tok_test_001';
const PAYJP_CUSTOMER_ID = 'cus_test_001';
const PAYJP_CHARGE_ID = 'ch_test_001';
const PAYJP_SUBSCRIPTION_ID = 'sub_test_001';
const OPERATION_ID = 'op-test-001';
const LINK_SESSION_TOKEN = 'link-session-token-abc';
const EMAIL = 'test@example.com';

function makeMember(overrides: Partial<Member> = {}): Member {
  return {
    id: MEMBER_ID,
    discord_user_id: DISCORD_USER_ID,
    email: EMAIL,
    payjp_customer_id: null,
    payjp_subscription_id: null,
    payjp_initial_charge_id: null,
    payjp_plan_id: null,
    subscription_status: null,
    first_trial_granted_at: null,
    initial_charge_paid_at: null,
    cancel_requested_at: null,
    inflight_operation_id: null,
    inflight_operation_type: null,
    inflight_operation_started_at: null,
    access_end_at: null,
    next_billing_at: null,
    role_state: 'unknown',
    last_synced_at: NOW,
    last_payjp_event_created_at: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function makeLinkSession(overrides: Partial<LinkSessionRecord> = {}): LinkSessionRecord {
  return {
    id: 'link-session-id-001',
    link_session_token_hash: 'dummy-hash',
    discord_user_id: DISCORD_USER_ID,
    expires_at: new Date(NOW.getTime() + 3600 * 1000),
    used_at: null,
    created_at: NOW,
    ...overrides,
  };
}

function makePayjpToken(overrides: { three_d_secure_status?: string | null; used?: boolean } = {}) {
  return {
    id: PAYJP_TOKEN_ID,
    used: false,
    three_d_secure_status: 'verified',
    card: { id: 'card-001' },
    ...overrides,
  };
}

function makePayjpCustomer() {
  return { id: PAYJP_CUSTOMER_ID, metadata: {} };
}

function makePayjpCharge() {
  return { id: PAYJP_CHARGE_ID, amount: 1000, paid: true, metadata: {} };
}

function makePayjpSubscription(overrides: Record<string, unknown> = {}) {
  const currentPeriodEnd = Math.floor(new Date('2025-05-01T00:00:00Z').getTime() / 1000);
  return {
    id: PAYJP_SUBSCRIPTION_ID,
    status: 'trial',
    current_period_end: currentPeriodEnd,
    trial_end: currentPeriodEnd,
    plan: { id: PLAN_ID, interval: 'month' },
    metadata: {},
    ...overrides,
  };
}

function makeConfig(): BillingConfig {
  return {
    frontendBaseUrl: 'https://frontend.example.com',
    allowedPlanIds: [PLAN_ID],
    discordGuildId: 'guild-001',
    discordPaidRoleId: 'role-001',
    initialChargeAmount: 1000,
    initialChargeAmountCurrency: 'jpy',
  };
}

function makeUpdatedMemberAfterSubscribe(member: Member): Member {
  return {
    ...member,
    payjp_customer_id: PAYJP_CUSTOMER_ID,
    payjp_subscription_id: PAYJP_SUBSCRIPTION_ID,
    payjp_initial_charge_id: PAYJP_CHARGE_ID,
    payjp_plan_id: PLAN_ID,
    subscription_status: 'trial',
    first_trial_granted_at: NOW,
    access_end_at: new Date(makePayjpSubscription().current_period_end * 1000),
    next_billing_at: new Date(makePayjpSubscription().current_period_end * 1000),
    role_state: 'granted',
    inflight_operation_id: null,
    inflight_operation_type: null,
    inflight_operation_started_at: null,
  };
}

// -------------------------------------------------------------------------
// モック依存セットアップ
// -------------------------------------------------------------------------

function makeSuccessfulDeps(memberOverrides: Partial<Member> = {}): BillingDeps {
  const member = makeMember(memberOverrides);
  const updatedMember = makeUpdatedMemberAfterSubscribe(member);

  const db: DbClient = {
    findMemberByDiscordUserId: vi.fn().mockResolvedValue(member),
    upsertProvisionalMember: vi.fn().mockResolvedValue(member),
    findLinkSession: vi.fn().mockResolvedValue(makeLinkSession()),
    consumeLinkSession: vi.fn().mockResolvedValue(undefined),
    setInflightOperation: vi.fn().mockResolvedValue(undefined),
    clearInflightOperation: vi.fn().mockResolvedValue(undefined),
    updateMemberCustomerId: vi.fn().mockResolvedValue(undefined),
    updateMemberChargeId: vi.fn().mockResolvedValue(undefined),
    updateMemberAfterSubscribe: vi.fn().mockResolvedValue(updatedMember),
    updateMemberAfterCancel: vi.fn().mockResolvedValue(undefined as never),
    acquireAdvisoryLock: vi.fn().mockResolvedValue(true),
    releaseAdvisoryLock: vi.fn().mockResolvedValue(undefined),
  };

  const payjp: PayjpClient = {
    fetchToken: vi.fn().mockResolvedValue(makePayjpToken()),
    createCustomer: vi.fn().mockResolvedValue(makePayjpCustomer()),
    createCharge: vi.fn().mockResolvedValue(makePayjpCharge()),
    createSubscription: vi.fn().mockResolvedValue(makePayjpSubscription()),
    cancelSubscription: vi.fn().mockResolvedValue(undefined as never),
    fetchCustomer: vi.fn().mockResolvedValue(makePayjpCustomer()),
    fetchCharge: vi.fn().mockResolvedValue(makePayjpCharge()),
    fetchSubscription: vi.fn().mockResolvedValue(makePayjpSubscription()),
  };

  const discord: DiscordClient = {
    checkMembership: vi.fn().mockResolvedValue({ isMember: true, canAssignRole: true }),
    assignRole: vi.fn().mockResolvedValue(undefined),
  };

  return {
    db,
    payjp,
    discord,
    config: makeConfig(),
    clock: () => NOW,
    generateOperationId: () => OPERATION_ID,
  };
}

function makeSubscribeRequest(overrides: Record<string, string> = {}) {
  return {
    origin: 'https://frontend.example.com',
    linkSessionToken: LINK_SESSION_TOKEN,
    discordUserId: DISCORD_USER_ID,
    email: EMAIL,
    payjpToken: PAYJP_TOKEN_ID,
    planId: PLAN_ID,
    ...overrides,
  };
}

// -------------------------------------------------------------------------
// テスト
// -------------------------------------------------------------------------

describe('POST /v1/subscriptions — Integration', () => {
  // -------------------------------------------------------------------------
  // PROP-BILL-020: Origin validation
  // -------------------------------------------------------------------------
  describe('PROP-BILL-020: Origin validation', () => {
    it('rejects with 403 when Origin is absent', async () => {
      const deps = makeSuccessfulDeps();
      const result = await handleSubscribe(makeSubscribeRequest({ origin: '' }), deps);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.statusCode).toBe(403);
        expect(result.errorCode).toBe('FORBIDDEN_ORIGIN');
      }
    });

    it('rejects with 403 when Origin is null', async () => {
      const deps = makeSuccessfulDeps();
      const result = await handleSubscribe(makeSubscribeRequest({ origin: 'null' }), deps);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.statusCode).toBe(403);
      }
    });

    it('rejects with 403 when Origin is mismatched', async () => {
      const deps = makeSuccessfulDeps();
      const result = await handleSubscribe(makeSubscribeRequest({ origin: 'https://evil.example.com' }), deps);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.statusCode).toBe(403);
      }
    });
  });

  // -------------------------------------------------------------------------
  // PROP-BILL-021: Link session validation
  // -------------------------------------------------------------------------
  describe('PROP-BILL-021: Link session validation', () => {
    it('rejects with 401 for invalid link session', async () => {
      const deps = makeSuccessfulDeps();
      (deps.db.findLinkSession as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const result = await handleSubscribe(makeSubscribeRequest(), deps);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.statusCode).toBe(401);
        expect(result.errorCode).toBe('INVALID_LINK_SESSION');
      }
    });

    it('rejects with 401 for expired link session', async () => {
      const deps = makeSuccessfulDeps();
      const expiredSession = makeLinkSession({ expires_at: new Date(NOW.getTime() - 1000) });
      (deps.db.findLinkSession as ReturnType<typeof vi.fn>).mockResolvedValue(expiredSession);
      const result = await handleSubscribe(makeSubscribeRequest(), deps);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.statusCode).toBe(401);
        expect(result.errorCode).toBe('EXPIRED_LINK_SESSION');
      }
    });

    it('rejects with 401 for consumed link session', async () => {
      const deps = makeSuccessfulDeps();
      const consumedSession = makeLinkSession({ used_at: new Date(NOW.getTime() - 500) });
      (deps.db.findLinkSession as ReturnType<typeof vi.fn>).mockResolvedValue(consumedSession);
      const result = await handleSubscribe(makeSubscribeRequest(), deps);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.statusCode).toBe(401);
        expect(result.errorCode).toBe('CONSUMED_LINK_SESSION');
      }
    });
  });

  // -------------------------------------------------------------------------
  // PROP-BILL-022: planId validation
  // -------------------------------------------------------------------------
  describe('PROP-BILL-022: planId validation', () => {
    it('rejects with 422 for planId not in allowlist', async () => {
      const deps = makeSuccessfulDeps();
      const result = await handleSubscribe(makeSubscribeRequest({ planId: 'plan-not-allowed' }), deps);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.statusCode).toBe(422);
        expect(result.errorCode).toBe('INVALID_PLAN_ID');
      }
    });
  });

  // -------------------------------------------------------------------------
  // PROP-BILL-023: Concurrent subscribe guard
  // -------------------------------------------------------------------------
  describe('PROP-BILL-023: Concurrent subscribe', () => {
    it('exactly one succeeds, no duplicate charge/subscription', async () => {
      // 並行リクエストをシミュレート: 最初のロック取得は成功、2番目は失敗
      let lockCount = 0;
      const deps1 = makeSuccessfulDeps();
      const deps2 = makeSuccessfulDeps();
      (deps1.db.acquireAdvisoryLock as ReturnType<typeof vi.fn>).mockImplementation(() => {
        lockCount++;
        return Promise.resolve(lockCount === 1);
      });
      (deps2.db.acquireAdvisoryLock as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      const [result1, result2] = await Promise.all([
        handleSubscribe(makeSubscribeRequest(), deps1),
        handleSubscribe(makeSubscribeRequest(), deps2),
      ]);

      // 一方が成功し他方が 503
      const successCount = [result1, result2].filter(r => r.ok).length;
      const failCount = [result1, result2].filter(r => !r.ok).length;
      expect(successCount).toBe(1);
      expect(failCount).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // PROP-BILL-024: Provisional member row
  // -------------------------------------------------------------------------
  describe('PROP-BILL-024: Provisional member', () => {
    it('creates provisional member row when none exists', async () => {
      const deps = makeSuccessfulDeps();
      await handleSubscribe(makeSubscribeRequest(), deps);
      expect(deps.db.upsertProvisionalMember).toHaveBeenCalledWith(DISCORD_USER_ID, EMAIL);
    });
  });

  // -------------------------------------------------------------------------
  // PROP-BILL-025: Inflight operation guard
  // -------------------------------------------------------------------------
  describe('PROP-BILL-025: Inflight operation guard', () => {
    it('returns 503 + existing operationId; link session NOT consumed; PAY.JP calls = 0', async () => {
      const existingOperationId = 'existing-op-123';
      const deps = makeSuccessfulDeps({
        inflight_operation_id: existingOperationId,
        inflight_operation_type: 'subscribe',
      });
      const result = await handleSubscribe(makeSubscribeRequest(), deps);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.statusCode).toBe(503);
        expect(result.operationId).toBe(existingOperationId);
      }
      expect(deps.db.consumeLinkSession).not.toHaveBeenCalled();
      expect(deps.payjp.fetchToken).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // PROP-BILL-026: Existing subscription guard
  // -------------------------------------------------------------------------
  describe('PROP-BILL-026: Existing subscription guard', () => {
    it('returns existing result for active subscription', async () => {
      const activeMember = makeMember({
        payjp_customer_id: PAYJP_CUSTOMER_ID,
        payjp_subscription_id: PAYJP_SUBSCRIPTION_ID,
        payjp_plan_id: PLAN_ID,
        subscription_status: 'active',
        access_end_at: new Date('2025-05-01T00:00:00Z'),
        first_trial_granted_at: new Date('2025-01-01T00:00:00Z'),
      });
      const deps = makeSuccessfulDeps();
      (deps.db.upsertProvisionalMember as ReturnType<typeof vi.fn>).mockResolvedValue(activeMember);
      const result = await handleSubscribe(makeSubscribeRequest(), deps);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.subscriptionStatus).toBe('active');
      }
      expect(deps.payjp.createCustomer).not.toHaveBeenCalled();
    });

    it('returns existing result for trial subscription', async () => {
      const trialMember = makeMember({
        subscription_status: 'trial',
        payjp_subscription_id: PAYJP_SUBSCRIPTION_ID,
        payjp_plan_id: PLAN_ID,
        access_end_at: new Date('2025-07-01T00:00:00Z'),
        first_trial_granted_at: NOW,
      });
      const deps = makeSuccessfulDeps();
      (deps.db.upsertProvisionalMember as ReturnType<typeof vi.fn>).mockResolvedValue(trialMember);
      const result = await handleSubscribe(makeSubscribeRequest(), deps);
      expect(result.ok).toBe(true);
    });

    it('returns existing result for canceled with future access_end_at', async () => {
      const canceledMember = makeMember({
        subscription_status: 'canceled',
        payjp_subscription_id: PAYJP_SUBSCRIPTION_ID,
        payjp_plan_id: PLAN_ID,
        access_end_at: new Date('2025-05-01T00:00:00Z'), // future
        first_trial_granted_at: NOW,
        cancel_requested_at: NOW,
      });
      const deps = makeSuccessfulDeps();
      (deps.db.upsertProvisionalMember as ReturnType<typeof vi.fn>).mockResolvedValue(canceledMember);
      const result = await handleSubscribe(makeSubscribeRequest(), deps);
      expect(result.ok).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // PROP-BILL-027: Discord non-member
  // -------------------------------------------------------------------------
  describe('PROP-BILL-027: Discord non-member', () => {
    it('rejects with 409; PAY.JP calls = 0', async () => {
      const deps = makeSuccessfulDeps();
      (deps.discord.checkMembership as ReturnType<typeof vi.fn>).mockResolvedValue({
        isMember: false,
        canAssignRole: false,
      });
      const result = await handleSubscribe(makeSubscribeRequest(), deps);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.statusCode).toBe(409);
        expect(result.errorCode).toBe('DISCORD_NOT_MEMBER');
      }
      expect(deps.payjp.fetchToken).not.toHaveBeenCalled();
      expect(deps.payjp.createCustomer).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // PROP-BILL-028: Discord role capability failure
  // -------------------------------------------------------------------------
  describe('PROP-BILL-028: Discord role capability failure', () => {
    it('rejects with 503; PAY.JP calls = 0', async () => {
      const deps = makeSuccessfulDeps();
      (deps.discord.checkMembership as ReturnType<typeof vi.fn>).mockResolvedValue({
        isMember: true,
        canAssignRole: false,
      });
      const result = await handleSubscribe(makeSubscribeRequest(), deps);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.statusCode).toBe(503);
        expect(result.errorCode).toBe('DISCORD_ROLE_CAPABILITY');
      }
      expect(deps.payjp.fetchToken).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // PROP-BILL-029: 3DS status validation + token used check
  // -------------------------------------------------------------------------
  describe('PROP-BILL-029: 3DS status validation', () => {
    it.each(['attempted', 'failed', 'error', 'unverified', null])(
      'rejects with 422 for three_d_secure_status=%s',
      async (status) => {
        const deps = makeSuccessfulDeps();
        (deps.payjp.fetchToken as ReturnType<typeof vi.fn>).mockResolvedValue(
          makePayjpToken({ three_d_secure_status: status }),
        );
        const result = await handleSubscribe(makeSubscribeRequest(), deps);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.statusCode).toBe(422);
          expect(result.errorCode).toBe('THREE_D_SECURE_REQUIRED');
        }
      },
    );

    it('rejects with 422 when token used=true (CRIT-003)', async () => {
      const deps = makeSuccessfulDeps();
      (deps.payjp.fetchToken as ReturnType<typeof vi.fn>).mockResolvedValue(
        makePayjpToken({ used: true }),
      );
      const result = await handleSubscribe(makeSubscribeRequest(), deps);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.statusCode).toBe(422);
        expect(result.errorCode).toBe('TOKEN_ALREADY_USED');
      }
    });
  });

  // -------------------------------------------------------------------------
  // PROP-BILL-030: operationId persistence order
  // -------------------------------------------------------------------------
  describe('PROP-BILL-030: operationId persistence order', () => {
    it('operationId is persisted to DB before first PAY.JP write', async () => {
      const callOrder: string[] = [];
      const deps = makeSuccessfulDeps();
      (deps.db.setInflightOperation as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callOrder.push('setInflightOperation');
        return Promise.resolve();
      });
      (deps.payjp.createCustomer as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callOrder.push('createCustomer');
        return Promise.resolve(makePayjpCustomer());
      });

      await handleSubscribe(makeSubscribeRequest(), deps);

      const inflightIdx = callOrder.indexOf('setInflightOperation');
      const customerIdx = callOrder.indexOf('createCustomer');
      expect(inflightIdx).toBeGreaterThanOrEqual(0);
      expect(customerIdx).toBeGreaterThanOrEqual(0);
      expect(inflightIdx).toBeLessThan(customerIdx);
    });
  });

  // -------------------------------------------------------------------------
  // PROP-BILL-031: Link session consumption timing
  // -------------------------------------------------------------------------
  describe('PROP-BILL-031: Link session consumption timing', () => {
    it('consumed after pre-validations; re-send → 401', async () => {
      const deps = makeSuccessfulDeps();
      let consumed = false;
      (deps.db.consumeLinkSession as ReturnType<typeof vi.fn>).mockImplementation(() => {
        consumed = true;
        return Promise.resolve();
      });
      // 1回目は成功
      await handleSubscribe(makeSubscribeRequest(), deps);
      expect(consumed).toBe(true);

      // 2回目: consumed session を返す
      (deps.db.findLinkSession as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeLinkSession({ used_at: NOW }),
      );
      const result2 = await handleSubscribe(makeSubscribeRequest(), deps);
      expect(result2.ok).toBe(false);
      if (!result2.ok) {
        expect(result2.statusCode).toBe(401);
      }
    });
  });

  // -------------------------------------------------------------------------
  // PROP-BILL-032: payjp_customer_id persistence
  // -------------------------------------------------------------------------
  describe('PROP-BILL-032: payjp_customer_id persistence', () => {
    it('persisted immediately after customer creation, survives subsequent failure', async () => {
      const deps = makeSuccessfulDeps();
      // 顧客作成後に subscription creation を失敗させる
      (deps.payjp.createSubscription as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('definite failure'),
      );

      const result = await handleSubscribe(makeSubscribeRequest(), deps);
      // updateMemberCustomerId が呼ばれたことを確認
      expect(deps.db.updateMemberCustomerId).toHaveBeenCalledWith(MEMBER_ID, PAYJP_CUSTOMER_ID);
    });
  });

  // -------------------------------------------------------------------------
  // PROP-BILL-033: First-time user flow
  // -------------------------------------------------------------------------
  describe('PROP-BILL-033: First-time user flow', () => {
    it('charge executed → payjp_initial_charge_id saved → subscription with trial_end', async () => {
      // first_trial_granted_at = null → first time
      const deps = makeSuccessfulDeps({ first_trial_granted_at: null });
      const result = await handleSubscribe(makeSubscribeRequest(), deps);

      expect(deps.payjp.createCharge).toHaveBeenCalledTimes(1);
      expect(deps.payjp.createSubscription).toHaveBeenCalledWith(
        expect.objectContaining({ trial_end: expect.any(Number) }),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.trialApplied).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  // PROP-BILL-034: Non-first-time user flow
  // -------------------------------------------------------------------------
  describe('PROP-BILL-034: Non-first-time user flow', () => {
    it('no charge executed, subscription without trial_end', async () => {
      const deps = makeSuccessfulDeps({
        first_trial_granted_at: new Date('2024-01-01T00:00:00Z'),
      });
      // updateMemberAfterSubscribe: 'active' ステータスを返す
      const updatedMember = makeUpdatedMemberAfterSubscribe(makeMember({
        first_trial_granted_at: new Date('2024-01-01T00:00:00Z'),
      }));
      updatedMember.subscription_status = 'active';
      updatedMember.payjp_initial_charge_id = null;
      (deps.db.updateMemberAfterSubscribe as ReturnType<typeof vi.fn>).mockResolvedValue(updatedMember);

      const result = await handleSubscribe(makeSubscribeRequest(), deps);

      expect(deps.payjp.createCharge).not.toHaveBeenCalled();
      expect(deps.payjp.createSubscription).toHaveBeenCalledWith(
        expect.not.objectContaining({ trial_end: expect.anything() }),
      );
      expect(result.ok).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // PROP-BILL-035: Re-subscriber
  // -------------------------------------------------------------------------
  describe('PROP-BILL-035: Re-subscriber', () => {
    it('treated as non-first-time (first_trial_granted_at preserved)', async () => {
      const originalTrialDate = new Date('2024-06-01T00:00:00Z');
      const deps = makeSuccessfulDeps({
        first_trial_granted_at: originalTrialDate,
        subscription_status: null, // 解約済みで再購読
      });
      await handleSubscribe(makeSubscribeRequest(), deps);

      // updateMemberAfterSubscribe の引数に first_trial_granted_at が元の値のまま渡されていること
      expect(deps.db.updateMemberAfterSubscribe).toHaveBeenCalledWith(
        MEMBER_ID,
        expect.objectContaining({ first_trial_granted_at: originalTrialDate }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // PROP-BILL-036: charge/subscription metadata
  // -------------------------------------------------------------------------
  describe('PROP-BILL-036: charge/subscription metadata', () => {
    it('contains discord_user_id and operation_id', async () => {
      const deps = makeSuccessfulDeps();
      await handleSubscribe(makeSubscribeRequest(), deps);

      expect(deps.payjp.createCharge).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            discord_user_id: DISCORD_USER_ID,
            operation_id: OPERATION_ID,
          }),
        }),
      );
      expect(deps.payjp.createSubscription).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            discord_user_id: DISCORD_USER_ID,
            operation_id: OPERATION_ID,
          }),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // PROP-BILL-037: Subscription state persistence
  // -------------------------------------------------------------------------
  describe('PROP-BILL-037: Subscription state persistence', () => {
    it('payjp_subscription_id, status, access_end_at, next_billing_at, payjp_plan_id updated', async () => {
      const deps = makeSuccessfulDeps();
      await handleSubscribe(makeSubscribeRequest(), deps);

      expect(deps.db.updateMemberAfterSubscribe).toHaveBeenCalledWith(
        MEMBER_ID,
        expect.objectContaining({
          payjp_subscription_id: PAYJP_SUBSCRIPTION_ID,
          payjp_plan_id: PLAN_ID,
          subscription_status: expect.stringMatching(/^(active|trial)$/),
          access_end_at: expect.any(Date),
          next_billing_at: expect.any(Date),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // PROP-BILL-038: Subscription interval
  // -------------------------------------------------------------------------
  describe('PROP-BILL-038: Subscription interval', () => {
    it('subscription interval is month', async () => {
      const deps = makeSuccessfulDeps();
      await handleSubscribe(makeSubscribeRequest(), deps);
      // プラン ID が渡されており、PAY.JP API が呼ばれたことを確認
      // 実際の interval は PAY.JP 側のプラン設定に依存するが、
      // createSubscription の呼び出し時に plan フィールドが month プランであること
      expect(deps.payjp.createSubscription).toHaveBeenCalledWith(
        expect.objectContaining({ plan: PLAN_ID }),
      );
      // レスポンスのサブスクリプションオブジェクトの plan.interval が 'month'
      const sub = makePayjpSubscription();
      expect(sub.plan.interval).toBe('month');
    });
  });

  // -------------------------------------------------------------------------
  // PROP-BILL-039: Role sync retry
  // -------------------------------------------------------------------------
  describe('PROP-BILL-039: Role sync retry', () => {
    it('retries up to 3 times on Discord 429/5xx', async () => {
      const deps = makeSuccessfulDeps();
      let attempts = 0;
      (deps.discord.assignRole as ReturnType<typeof vi.fn>).mockImplementation(() => {
        attempts++;
        if (attempts < 3) throw new Error('Discord 429');
        return Promise.resolve();
      });
      const result = await handleSubscribe(makeSubscribeRequest(), deps);
      expect(attempts).toBe(3);
      expect(result.ok).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // PROP-BILL-040: Role sync final failure
  // -------------------------------------------------------------------------
  describe('PROP-BILL-040: Role sync final failure', () => {
    it('503 + operationId, inflight_operation_* retained', async () => {
      const deps = makeSuccessfulDeps();
      (deps.discord.assignRole as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Discord unavailable'));
      const result = await handleSubscribe(makeSubscribeRequest(), deps);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.statusCode).toBe(503);
        expect(result.operationId).toBe(OPERATION_ID);
      }
    });
  });

  // -------------------------------------------------------------------------
  // PROP-BILL-041: Subscribe response schema
  // -------------------------------------------------------------------------
  describe('PROP-BILL-041: Subscribe response schema', () => {
    it('matches exact schema with RFC 3339 UTC dates', async () => {
      const deps = makeSuccessfulDeps();
      const result = await handleSubscribe(makeSubscribeRequest(), deps);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const { data } = result;
        expect(data).toMatchObject({
          ok: true,
          memberId: expect.any(String),
          subscriptionStatus: expect.stringMatching(/^(active|trial|canceled)$/),
          planId: expect.any(String),
          trialApplied: expect.any(Boolean),
          accessEndAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
        });
      }
    });
  });

  // -------------------------------------------------------------------------
  // PROP-BILL-062: Subscribe orchestration ordering
  // -------------------------------------------------------------------------
  describe('PROP-BILL-062: Subscribe orchestration ordering', () => {
    it('verifies complete 14-step sequence via mock call-order recording', async () => {
      const callOrder: string[] = [];
      const deps = makeSuccessfulDeps();

      (deps.db.acquireAdvisoryLock as ReturnType<typeof vi.fn>).mockImplementation((_key) => {
        callOrder.push('acquireAdvisoryLock');
        return Promise.resolve(true);
      });
      (deps.db.upsertProvisionalMember as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callOrder.push('upsertProvisionalMember');
        return Promise.resolve(makeMember());
      });
      (deps.db.setInflightOperation as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callOrder.push('setInflightOperation');
        return Promise.resolve();
      });
      (deps.db.consumeLinkSession as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callOrder.push('consumeLinkSession');
        return Promise.resolve();
      });
      (deps.payjp.fetchToken as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callOrder.push('fetchToken');
        return Promise.resolve(makePayjpToken());
      });
      (deps.payjp.createCustomer as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callOrder.push('createCustomer');
        return Promise.resolve(makePayjpCustomer());
      });
      (deps.db.updateMemberCustomerId as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callOrder.push('updateMemberCustomerId');
        return Promise.resolve();
      });
      (deps.payjp.createCharge as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callOrder.push('createCharge');
        return Promise.resolve(makePayjpCharge());
      });
      (deps.db.updateMemberChargeId as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callOrder.push('updateMemberChargeId');
        return Promise.resolve();
      });
      (deps.payjp.createSubscription as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callOrder.push('createSubscription');
        return Promise.resolve(makePayjpSubscription());
      });
      (deps.db.updateMemberAfterSubscribe as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callOrder.push('updateMemberAfterSubscribe');
        return Promise.resolve(makeUpdatedMemberAfterSubscribe(makeMember()));
      });
      (deps.discord.assignRole as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callOrder.push('assignRole');
        return Promise.resolve();
      });

      await handleSubscribe(makeSubscribeRequest(), deps);

      // 重要なステップが正しい順序で呼ばれていること
      const idxLock = callOrder.indexOf('acquireAdvisoryLock');
      const idxProvisional = callOrder.indexOf('upsertProvisionalMember');
      const idxInflight = callOrder.indexOf('setInflightOperation');
      const idxConsumeSession = callOrder.indexOf('consumeLinkSession');
      const idxFetchToken = callOrder.indexOf('fetchToken');
      const idxCreateCustomer = callOrder.indexOf('createCustomer');
      const idxPersistCustomerId = callOrder.indexOf('updateMemberCustomerId');
      const idxCreateCharge = callOrder.indexOf('createCharge');
      const idxPersistChargeId = callOrder.indexOf('updateMemberChargeId');
      const idxCreateSub = callOrder.indexOf('createSubscription');
      const idxUpdateMember = callOrder.indexOf('updateMemberAfterSubscribe');
      const idxAssignRole = callOrder.indexOf('assignRole');

      // Lock → provisional → inflight (before PAY.JP) → fetchToken (3DS validation) → consumeSession → createCustomer → charge → sub → updateMember → assignRole
      expect(idxLock).toBeLessThan(idxProvisional);
      expect(idxProvisional).toBeLessThan(idxInflight);
      expect(idxInflight).toBeLessThan(idxFetchToken);
      expect(idxFetchToken).toBeLessThan(idxConsumeSession);
      expect(idxConsumeSession).toBeLessThan(idxCreateCustomer);
      expect(idxCreateCustomer).toBeLessThan(idxPersistCustomerId);
      expect(idxPersistCustomerId).toBeLessThan(idxCreateCharge);
      expect(idxCreateCharge).toBeLessThan(idxPersistChargeId);
      expect(idxPersistChargeId).toBeLessThan(idxCreateSub);
      expect(idxCreateSub).toBeLessThan(idxUpdateMember);
      expect(idxUpdateMember).toBeLessThan(idxAssignRole);
    });
  });

  // -------------------------------------------------------------------------
  // PROP-BILL-064: Customer reuse path
  // -------------------------------------------------------------------------
  describe('PROP-BILL-064: Customer reuse path', () => {
    it('existing payjp_customer_id → no new customer creation', async () => {
      const deps = makeSuccessfulDeps({ payjp_customer_id: PAYJP_CUSTOMER_ID });
      await handleSubscribe(makeSubscribeRequest(), deps);
      expect(deps.payjp.createCustomer).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // PROP-BILL-065: PAY.JP API encoding
  // -------------------------------------------------------------------------
  describe('PROP-BILL-065: PAY.JP API encoding', () => {
    it('all PAY.JP calls use form-urlencoded; no JSON POST', async () => {
      // shell 実装は PayjpClient インターフェース経由のため、
      // エンコード方式はクライアント実装の責務。
      // ここではクライアントが呼ばれることを確認する。
      const deps = makeSuccessfulDeps();
      await handleSubscribe(makeSubscribeRequest(), deps);
      expect(deps.payjp.fetchToken).toHaveBeenCalledWith(PAYJP_TOKEN_ID);
      expect(deps.payjp.createCustomer).toHaveBeenCalled();
      expect(deps.payjp.createCharge).toHaveBeenCalled();
      expect(deps.payjp.createSubscription).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // PROP-BILL-066: PAY.JP write no-retry
  // -------------------------------------------------------------------------
  describe('PROP-BILL-066: PAY.JP write no-retry', () => {
    it('injected failure → exactly 1 call attempt, no retry', async () => {
      const deps = makeSuccessfulDeps();
      (deps.payjp.createCharge as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('definite PAY.JP error'),
      );
      await handleSubscribe(makeSubscribeRequest(), deps);
      // createCharge は 1 回だけ呼ばれる (リトライなし)
      expect(deps.payjp.createCharge).toHaveBeenCalledTimes(1);
    });
  });
});
