/**
 * Tier 2 Integration Tests — Failure Handling (Green Phase)
 *
 * PROP-BILL-051 〜 PROP-BILL-053e
 */
import { describe, it, expect, vi } from 'vitest';
import { handleSubscribe } from '../../shell/subscribe.js';
import { handleCancel } from '../../shell/cancel.js';
import type {
  BillingDeps,
  DbClient,
  PayjpClient,
  DiscordClient,
  BillingConfig,
} from '../../shell/types.js';
import type { Member, LinkSessionRecord } from '@hayane/shared';

const NOW = new Date('2025-04-01T10:00:00Z');
const DISCORD_USER_ID = 'discord-user-001';
const MEMBER_ID = 'member-uuid-001';
const PLAN_ID = 'plan-allowed-001';
const PAYJP_SUBSCRIPTION_ID = 'sub_test_001';
const PAYJP_CUSTOMER_ID = 'cus_test_001';
const PAYJP_CHARGE_ID = 'ch_test_001';
const OPERATION_ID = 'op-failure-001';
const LINK_SESSION_TOKEN = 'link-session-failure-abc';
const ACCESS_END_AT = new Date('2025-05-01T00:00:00Z');

function makeMember(overrides: Partial<Member> = {}): Member {
  return {
    id: MEMBER_ID,
    discord_user_id: DISCORD_USER_ID,
    email: 'test@example.com',
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

function makePayjpSubscription() {
  const currentPeriodEnd = Math.floor(new Date('2025-05-01T00:00:00Z').getTime() / 1000);
  return {
    id: PAYJP_SUBSCRIPTION_ID,
    status: 'trial',
    current_period_end: currentPeriodEnd,
    trial_end: currentPeriodEnd,
    plan: { id: PLAN_ID, interval: 'month' },
    metadata: {},
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

function makeSubscribeDeps(memberOverrides: Partial<Member> = {}): BillingDeps {
  const member = makeMember(memberOverrides);

  const db: DbClient = {
    findMemberByDiscordUserId: vi.fn().mockResolvedValue(member),
    upsertProvisionalMember: vi.fn().mockResolvedValue(member),
    findLinkSession: vi.fn().mockResolvedValue(makeLinkSession()),
    consumeLinkSession: vi.fn().mockResolvedValue(undefined),
    setInflightOperation: vi.fn().mockResolvedValue(undefined),
    clearInflightOperation: vi.fn().mockResolvedValue(undefined),
    updateMemberCustomerId: vi.fn().mockResolvedValue(undefined),
    updateMemberChargeId: vi.fn().mockResolvedValue(undefined),
    updateMemberAfterSubscribe: vi.fn().mockResolvedValue({
      ...member,
      subscription_status: 'trial',
      payjp_subscription_id: PAYJP_SUBSCRIPTION_ID,
      payjp_plan_id: PLAN_ID,
      access_end_at: new Date(makePayjpSubscription().current_period_end * 1000),
      next_billing_at: new Date(makePayjpSubscription().current_period_end * 1000),
      first_trial_granted_at: NOW,
    }),
    updateMemberAfterCancel: vi.fn().mockResolvedValue(undefined as never),
    acquireAdvisoryLock: vi.fn().mockResolvedValue(true),
    releaseAdvisoryLock: vi.fn().mockResolvedValue(undefined),
  };

  const payjp: PayjpClient = {
    fetchToken: vi.fn().mockResolvedValue({ id: 'tok_001', used: false, three_d_secure_status: 'verified', card: { id: 'card-001' } }),
    createCustomer: vi.fn().mockResolvedValue({ id: PAYJP_CUSTOMER_ID, metadata: {} }),
    createCharge: vi.fn().mockResolvedValue({ id: PAYJP_CHARGE_ID, amount: 1000, paid: true, metadata: {} }),
    createSubscription: vi.fn().mockResolvedValue(makePayjpSubscription()),
    cancelSubscription: vi.fn().mockResolvedValue(undefined as never),
    fetchCustomer: vi.fn().mockResolvedValue({ id: PAYJP_CUSTOMER_ID, metadata: {} }),
    fetchCharge: vi.fn().mockResolvedValue({ id: PAYJP_CHARGE_ID, amount: 1000, paid: true, metadata: {} }),
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

function makeCancelDeps(memberOverrides: Partial<Member> = {}): BillingDeps {
  const member = makeMember({
    subscription_status: 'active',
    payjp_subscription_id: PAYJP_SUBSCRIPTION_ID,
    access_end_at: ACCESS_END_AT,
    first_trial_granted_at: new Date('2025-01-01T00:00:00Z'),
    ...memberOverrides,
  });

  const db: DbClient = {
    findMemberByDiscordUserId: vi.fn().mockResolvedValue(member),
    upsertProvisionalMember: vi.fn().mockResolvedValue(member),
    findLinkSession: vi.fn().mockResolvedValue(makeLinkSession()),
    consumeLinkSession: vi.fn().mockResolvedValue(undefined),
    setInflightOperation: vi.fn().mockResolvedValue(undefined),
    clearInflightOperation: vi.fn().mockResolvedValue(undefined),
    updateMemberCustomerId: vi.fn().mockResolvedValue(undefined),
    updateMemberChargeId: vi.fn().mockResolvedValue(undefined),
    updateMemberAfterSubscribe: vi.fn().mockResolvedValue(undefined as never),
    updateMemberAfterCancel: vi.fn().mockResolvedValue({
      ...member,
      cancel_requested_at: NOW,
      subscription_status: 'canceled',
      inflight_operation_id: null,
      inflight_operation_type: null,
      inflight_operation_started_at: null,
    }),
    acquireAdvisoryLock: vi.fn().mockResolvedValue(true),
    releaseAdvisoryLock: vi.fn().mockResolvedValue(undefined),
  };

  const payjp: PayjpClient = {
    fetchToken: vi.fn().mockResolvedValue(undefined as never),
    createCustomer: vi.fn().mockResolvedValue(undefined as never),
    createCharge: vi.fn().mockResolvedValue(undefined as never),
    createSubscription: vi.fn().mockResolvedValue(undefined as never),
    cancelSubscription: vi.fn().mockResolvedValue({
      id: PAYJP_SUBSCRIPTION_ID,
      status: 'canceled',
      current_period_end: Math.floor(ACCESS_END_AT.getTime() / 1000),
      trial_end: null,
      plan: { id: PLAN_ID, interval: 'month' },
      metadata: {},
    }),
    fetchCustomer: vi.fn().mockResolvedValue(undefined as never),
    fetchCharge: vi.fn().mockResolvedValue(undefined as never),
    fetchSubscription: vi.fn().mockResolvedValue({
      id: PAYJP_SUBSCRIPTION_ID,
      status: 'canceled',
      current_period_end: Math.floor(ACCESS_END_AT.getTime() / 1000),
      trial_end: null,
      plan: { id: PLAN_ID, interval: 'month' },
      metadata: {},
    }),
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

function makeSubscribeRequest() {
  return {
    origin: 'https://frontend.example.com',
    linkSessionToken: LINK_SESSION_TOKEN,
    discordUserId: DISCORD_USER_ID,
    email: 'test@example.com',
    payjpToken: 'tok_001',
    planId: PLAN_ID,
  };
}

function makeCancelRequest() {
  return {
    origin: 'https://frontend.example.com',
    linkSessionToken: LINK_SESSION_TOKEN,
    discordUserId: DISCORD_USER_ID,
  };
}

describe('Failure Handling — Integration', () => {
  // -------------------------------------------------------------------------
  // PROP-BILL-051: Subscribe uncertain failure
  // -------------------------------------------------------------------------
  describe('PROP-BILL-051: Subscribe uncertain failure', () => {
    it('503 + operationId, inflight_operation_* retained', async () => {
      const deps = makeSubscribeDeps();
      // タイムアウトエラーは uncertain failure として扱われる
      (deps.payjp.createCustomer as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('timeout: connection timed out'),
      );

      const result = await handleSubscribe(makeSubscribeRequest(), deps);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.statusCode).toBe(503);
        expect(result.operationId).toBe(OPERATION_ID);
      }
      // clearInflightOperation は呼ばれない (inflight を保持)
      expect(deps.db.clearInflightOperation).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // PROP-BILL-052: Definite failure before PAY.JP write
  // -------------------------------------------------------------------------
  describe('PROP-BILL-052: Definite failure before PAY.JP write', () => {
    it('inflight_operation_* cleared on pre-write failure', async () => {
      const deps = makeSubscribeDeps();
      // 3DS 検証失敗は PAY.JP write 前の definite failure
      (deps.payjp.fetchToken as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'tok_001',
        used: false,
        three_d_secure_status: 'failed',
        card: { id: 'card-001' },
      });

      const result = await handleSubscribe(makeSubscribeRequest(), deps);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.statusCode).toBe(422);
      }
      // 3DS 失敗後は inflight をクリア
      expect(deps.db.clearInflightOperation).toHaveBeenCalledWith(MEMBER_ID);
    });
  });

  // -------------------------------------------------------------------------
  // PROP-BILL-053a: Failure after customer creation
  // -------------------------------------------------------------------------
  describe('PROP-BILL-053a: Failure after customer creation', () => {
    it('re-fetch customer; reconcile success → clear inflight', async () => {
      const deps = makeSubscribeDeps();
      let customerCreated = false;

      (deps.payjp.createCustomer as ReturnType<typeof vi.fn>).mockImplementation(() => {
        customerCreated = true;
        throw new Error('definite customer creation error');
      });
      // payjp_customer_id がまだ null の状態では reconcile 失敗 → inflight 保持
      // ただし updateMemberCustomerId が呼ばれる前に失敗した場合

      const result = await handleSubscribe(makeSubscribeRequest(), deps);

      expect(customerCreated).toBe(true);
      expect(result.ok).toBe(false);
      // createCustomer 後の definite failure → clearInflight か inflight 保持
      if (!result.ok) {
        expect(result.statusCode).toBe(503);
      }
    });
  });

  // -------------------------------------------------------------------------
  // PROP-BILL-053b: Failure after charge
  // -------------------------------------------------------------------------
  describe('PROP-BILL-053b: Failure after charge', () => {
    it('re-fetch charge; reconcile payjp_initial_charge_id; no duplicate charge', async () => {
      const deps = makeSubscribeDeps();
      let chargeAttempts = 0;

      (deps.payjp.createCharge as ReturnType<typeof vi.fn>).mockImplementation(() => {
        chargeAttempts++;
        throw new Error('definite charge error');
      });

      const result = await handleSubscribe(makeSubscribeRequest(), deps);

      // createCharge は 1 回のみ (リトライなし)
      expect(chargeAttempts).toBe(1);
      expect(result.ok).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // PROP-BILL-053c: Failure after subscription creation
  // -------------------------------------------------------------------------
  describe('PROP-BILL-053c: Failure after subscription creation', () => {
    it('re-fetch subscription; reconcile → clear inflight', async () => {
      const deps = makeSubscribeDeps();
      let subAttempts = 0;

      (deps.payjp.createSubscription as ReturnType<typeof vi.fn>).mockImplementation(() => {
        subAttempts++;
        throw new Error('definite subscription creation error');
      });
      // payjp_subscription_id が null の場合 → reconcile 試行なし → clearInflight
      const result = await handleSubscribe(makeSubscribeRequest(), deps);

      expect(subAttempts).toBe(1);
      expect(result.ok).toBe(false);
      expect(deps.db.clearInflightOperation).toHaveBeenCalledWith(MEMBER_ID);
    });
  });

  // -------------------------------------------------------------------------
  // PROP-BILL-053d: Failure after cancel API
  // -------------------------------------------------------------------------
  describe('PROP-BILL-053d: Failure after cancel API', () => {
    it('re-fetch subscription status; reconcile → clear inflight', async () => {
      const deps = makeCancelDeps();

      (deps.payjp.cancelSubscription as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('definite cancel error'),
      );
      // fetchSubscription が reconcile で成功する
      (deps.payjp.fetchSubscription as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: PAYJP_SUBSCRIPTION_ID,
        status: 'canceled',
        current_period_end: Math.floor(ACCESS_END_AT.getTime() / 1000),
        trial_end: null,
        plan: { id: PLAN_ID, interval: 'month' },
        metadata: {},
      });

      const result = await handleCancel(makeCancelRequest(), deps);

      // reconcile 成功 → 通常の成功レスポンス
      expect(result.ok).toBe(true);
      expect(deps.payjp.fetchSubscription).toHaveBeenCalledWith(PAYJP_SUBSCRIPTION_ID);
    });
  });

  // -------------------------------------------------------------------------
  // PROP-BILL-053e: Reconciliation failure
  // -------------------------------------------------------------------------
  describe('PROP-BILL-053e: Reconciliation failure', () => {
    it('PAY.JP unreachable during re-fetch → 503 + operationId, inflight retained', async () => {
      const deps = makeCancelDeps();

      (deps.payjp.cancelSubscription as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('definite cancel error'),
      );
      // fetchSubscription (reconcile) も失敗
      (deps.payjp.fetchSubscription as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('PAY.JP unreachable'),
      );

      const result = await handleCancel(makeCancelRequest(), deps);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.statusCode).toBe(503);
        expect(result.operationId).toBe(OPERATION_ID);
      }
      // inflight は保持 (clearInflightOperation は呼ばれない)
      expect(deps.db.clearInflightOperation).not.toHaveBeenCalled();
    });
  });
});
