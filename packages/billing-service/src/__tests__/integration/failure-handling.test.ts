/**
 * Tier 2 Integration Tests — Failure Handling (Green Phase)
 *
 * PROP-BILL-051 〜 PROP-BILL-053e
 */

import type { LinkSessionRecord, Member } from '@hayane/shared';
import { describe, expect, it, vi } from 'vitest';
import { linkSessionTokenHash } from '../../core/index.js';
import { handleCancel } from '../../shell/cancel.js';
import { handleSubscribe } from '../../shell/subscribe.js';
import type { BillingConfig, BillingDeps, DbClient, DiscordClient, PayjpClient } from '../../shell/types.js';

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
    inflight_subscribe_plan_id: null,
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
    discord_access_token_encrypted: null,
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
    planRoleMapping: { [PLAN_ID]: 'role-plan-001' },
    planInitialChargeAmounts: { [PLAN_ID]: 1000 },
    initialChargeAmount: 1000,
    initialChargeAmountCurrency: 'jpy',
    googleFormCancelBaseUrl: 'https://docs.google.com/forms/d/e/test-form/viewform',
    googleFormCancelEmailEntryId: '1111111111',
    googleFormCancelTokenEntryId: '2222222222',
    googleFormCancelSecret: 'google-shared-secret',
    googleFormCancelTokenSecret: 'google-token-secret',
    googleFormCancelTokenTtlSeconds: 900,
    accessGateSessionTtlSeconds: 86400,
  };
}

function makeSubscribeDeps(memberOverrides: Partial<Member> = {}): BillingDeps {
  const member = makeMember(memberOverrides);

  const db: DbClient = {
    findMemberByDiscordUserId: vi.fn().mockResolvedValue(member),
    findMemberById: vi.fn().mockResolvedValue(member),
    upsertProvisionalMember: vi.fn().mockResolvedValue(member),
    upsertProvisionalMemberByEmail: vi.fn().mockResolvedValue(member),
    updateMemberDiscordUserId: vi.fn().mockResolvedValue(member),
    findLinkSession: vi
      .fn()
      .mockImplementation((h: string) =>
        Promise.resolve(
          h === linkSessionTokenHash(LINK_SESSION_TOKEN) ? makeLinkSession({ link_session_token_hash: h }) : null,
        ),
      ),
    consumeLinkSession: vi.fn().mockResolvedValue(undefined),
    insertCancelFormToken: vi.fn().mockResolvedValue(undefined as never),
    findCancelFormToken: vi.fn().mockResolvedValue(null),
    consumeCancelFormToken: vi.fn().mockResolvedValue(undefined),
    insertMemberSession: vi.fn().mockResolvedValue({
      id: 'ms-1',
      member_session_token_hash: 'h',
      member_id: member.id,
      expires_at: new Date(),
      created_at: new Date(),
    }),
    findMemberSession: vi.fn().mockResolvedValue(null),
    insertAccessGateSession: vi.fn().mockResolvedValue(undefined),
    findAccessGateSessionByTokenHash: vi.fn().mockResolvedValue(false),
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
    updateMemberRoleState: vi.fn().mockResolvedValue(undefined),
    clearMemberDiscordUserId: vi.fn().mockResolvedValue(undefined),
    acquireAdvisoryLock: vi.fn().mockResolvedValue(true),
    releaseAdvisoryLock: vi.fn().mockResolvedValue(undefined),
    withTransactionLock: vi.fn().mockImplementation((_key: string, fn: (txDb: unknown) => Promise<unknown>) => fn({})),
  };

  const payjp: PayjpClient = {
    fetchToken: vi
      .fn()
      .mockResolvedValue({ id: 'tok_001', used: false, three_d_secure_status: 'verified', card: { id: 'card-001' } }),
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
    removeRole: vi.fn().mockResolvedValue(undefined),
    addMemberToGuild: vi.fn().mockResolvedValue({ joinedNew: true }),
    revokeToken: vi.fn().mockResolvedValue(undefined),
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
    payjp_plan_id: PLAN_ID,
    access_end_at: ACCESS_END_AT,
    role_state: 'granted',
    first_trial_granted_at: new Date('2025-01-01T00:00:00Z'),
    ...memberOverrides,
  });

  const db: DbClient = {
    findMemberByDiscordUserId: vi.fn().mockResolvedValue(member),
    findMemberById: vi.fn().mockResolvedValue(member),
    upsertProvisionalMember: vi.fn().mockResolvedValue(member),
    upsertProvisionalMemberByEmail: vi.fn().mockResolvedValue(member),
    updateMemberDiscordUserId: vi.fn().mockResolvedValue(member),
    findLinkSession: vi.fn().mockResolvedValue(makeLinkSession()),
    consumeLinkSession: vi.fn().mockResolvedValue(undefined),
    insertCancelFormToken: vi.fn().mockResolvedValue(undefined as never),
    findCancelFormToken: vi.fn().mockResolvedValue(null),
    consumeCancelFormToken: vi.fn().mockResolvedValue(undefined),
    insertMemberSession: vi.fn().mockResolvedValue({
      id: 'ms-1',
      member_session_token_hash: 'h',
      member_id: member.id,
      expires_at: new Date(),
      created_at: new Date(),
    }),
    findMemberSession: vi.fn().mockResolvedValue(null),
    insertAccessGateSession: vi.fn().mockResolvedValue(undefined),
    findAccessGateSessionByTokenHash: vi.fn().mockResolvedValue(false),
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
    updateMemberRoleState: vi.fn().mockResolvedValue(undefined),
    clearMemberDiscordUserId: vi.fn().mockResolvedValue(undefined),
    acquireAdvisoryLock: vi.fn().mockResolvedValue(true),
    releaseAdvisoryLock: vi.fn().mockResolvedValue(undefined),
    withTransactionLock: vi.fn().mockImplementation((_key: string, fn: (txDb: unknown) => Promise<unknown>) => fn({})),
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
    removeRole: vi.fn().mockResolvedValue(undefined),
    addMemberToGuild: vi.fn().mockResolvedValue({ joinedNew: true }),
    revokeToken: vi.fn().mockResolvedValue(undefined),
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
    email: 'test@example.com',
    payjpToken: 'tok_001',
    planId: PLAN_ID,
    privacyConsented: true,
    linkSessionToken: LINK_SESSION_TOKEN,
  };
}

function makeCancelRequest() {
  return {
    origin: 'https://frontend.example.com',
    linkSessionToken: LINK_SESSION_TOKEN,
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

    it('fetchToken uncertain failure returns 503 PAYJP_UNCERTAIN and retains inflight', async () => {
      const deps = makeSubscribeDeps();
      (deps.payjp.fetchToken as ReturnType<typeof vi.fn>).mockRejectedValue(new TypeError('fetch failed'));

      const result = await handleSubscribe(makeSubscribeRequest(), deps);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.statusCode).toBe(503);
        expect(result.errorCode).toBe('PAYJP_UNCERTAIN');
        expect(result.operationId).toBe(OPERATION_ID);
      }
      expect(deps.db.clearInflightOperation).not.toHaveBeenCalled();
    });

    it('returns 503 without operationId when setInflightOperation fails (no persisted inflight row)', async () => {
      const deps = makeSubscribeDeps();
      (deps.db.setInflightOperation as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db write timeout'));

      const result = await handleSubscribe(makeSubscribeRequest(), deps);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.statusCode).toBe(503);
        expect(result.errorCode).toBe('DB_UPDATE_FAILED');
        expect(result.operationId).toBeUndefined();
      }
    });
  });

  // -------------------------------------------------------------------------
  // PROP-BILL-052: Definite failure before PAY.JP write
  // -------------------------------------------------------------------------
  describe('PROP-BILL-052: Definite failure before PAY.JP write', () => {
    it('inflight cleared on pre-write (READ-only) failure; operationId still returned', async () => {
      const deps = makeSubscribeDeps();
      // 3DS 検証失敗は PAY.JP write 前の READ-only failure — inflight をクリアする
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
        // READ-only failure — PAY.JP write は発生していないため inflight をクリアする
        expect(deps.db.clearInflightOperation).toHaveBeenCalledOnce();
        expect(result.operationId).toBe(OPERATION_ID);
      }
    });
  });

  // -------------------------------------------------------------------------
  // PROP-BILL-053a: Failure after customer creation
  // -------------------------------------------------------------------------
  describe('PROP-BILL-053a: Failure after customer creation', () => {
    it('definite failure with no existing customer → retain inflight for CLI', async () => {
      const deps = makeSubscribeDeps();
      let customerCreated = false;

      // HTTP 4xx → definite failure → reconcile path (but no existing customer_id → fail)
      const definiteError = Object.assign(new Error('definite customer creation error'), { status: 402 });
      (deps.payjp.createCustomer as ReturnType<typeof vi.fn>).mockImplementation(() => {
        customerCreated = true;
        throw definiteError;
      });

      const result = await handleSubscribe(makeSubscribeRequest(), deps);

      expect(customerCreated).toBe(true);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.statusCode).toBe(422);
        expect(result.operationId).toBe(OPERATION_ID);
        // F-02: 4xx確定失敗 + 既存顧客なし → inflightをクリアして422を返す
        expect(deps.db.clearInflightOperation).toHaveBeenCalledTimes(1);
      }
    });

    it('definite failure: still returns PAYJP_ERROR + operationId when clearInflightOperation throws', async () => {
      const deps = makeSubscribeDeps();
      const definiteError = Object.assign(new Error('definite customer creation error'), { status: 402 });
      (deps.payjp.createCustomer as ReturnType<typeof vi.fn>).mockRejectedValue(definiteError);
      (deps.db.clearInflightOperation as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB timeout'));

      const result = await handleSubscribe(makeSubscribeRequest(), deps);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errorCode).toBe('PAYJP_ERROR');
        expect(result.operationId).toBe(OPERATION_ID);
      }
      expect(deps.db.clearInflightOperation).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // PROP-BILL-053b: Failure after charge
  // -------------------------------------------------------------------------
  describe('PROP-BILL-053b: Failure after charge', () => {
    it('definite failure with no existing charge_id → clear inflight, no duplicate charge (F-02)', async () => {
      const deps = makeSubscribeDeps();
      let chargeAttempts = 0;

      // HTTP 4xx → definite failure
      const definiteError = Object.assign(new Error('definite charge error'), { status: 402 });
      (deps.payjp.createCharge as ReturnType<typeof vi.fn>).mockImplementation(() => {
        chargeAttempts++;
        throw definiteError;
      });

      const result = await handleSubscribe(makeSubscribeRequest(), deps);

      // createCharge は 1 回のみ (リトライなし)
      expect(chargeAttempts).toBe(1);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.operationId).toBe(OPERATION_ID);
        // F-02: 4xx確定失敗 + 既存charge_idなし → inflightをクリアして422を返す
        expect(result.statusCode).toBe(422);
        expect(deps.db.clearInflightOperation).toHaveBeenCalledTimes(1);
      }
    });

    it('definite createCharge failure + existing unpaid charge → 422 and clear inflight', async () => {
      const deps = makeSubscribeDeps({ payjp_initial_charge_id: 'ch_existing_unpaid' });
      const definiteError = Object.assign(new Error('definite charge error'), { status: 402 });
      (deps.payjp.createCharge as ReturnType<typeof vi.fn>).mockRejectedValue(definiteError);
      (deps.payjp.fetchCharge as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'ch_existing_unpaid',
        amount: 1000,
        paid: false,
        metadata: {},
      });

      const result = await handleSubscribe(makeSubscribeRequest(), deps);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.statusCode).toBe(422);
        expect(result.errorCode).toBe('PAYJP_ERROR');
        expect(result.message).toBe('Stored charge was not paid');
        expect(result.operationId).toBe(OPERATION_ID);
      }
      expect(deps.db.clearInflightOperation).toHaveBeenCalledTimes(1);
    });

    it('definite createCharge failure + existing paid charge → continues subscription flow', async () => {
      const deps = makeSubscribeDeps({ payjp_initial_charge_id: 'ch_existing_paid' });
      const definiteError = Object.assign(new Error('definite charge error'), { status: 402 });
      (deps.payjp.createCharge as ReturnType<typeof vi.fn>).mockRejectedValue(definiteError);
      (deps.payjp.fetchCharge as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'ch_existing_paid',
        amount: 1000,
        paid: true,
        metadata: {},
      });

      const result = await handleSubscribe(makeSubscribeRequest(), deps);

      expect(result.ok).toBe(true);
      expect(deps.payjp.createSubscription).toHaveBeenCalledTimes(1);
      expect(deps.db.clearInflightOperation).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // PROP-BILL-053c: Failure after subscription creation
  // -------------------------------------------------------------------------
  describe('PROP-BILL-053c: Failure after subscription creation', () => {
    it('definite failure with no existing subscription → retain inflight for CLI', async () => {
      const deps = makeSubscribeDeps();
      let subAttempts = 0;

      (deps.payjp.createSubscription as ReturnType<typeof vi.fn>).mockImplementation(() => {
        subAttempts++;
        throw new Error('definite subscription creation error');
      });
      // payjp_subscription_id が null の場合 → reconcile 試行なし → inflight 保持
      const result = await handleSubscribe(makeSubscribeRequest(), deps);

      expect(subAttempts).toBe(1);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.statusCode).toBe(503);
        expect(result.operationId).toBe(OPERATION_ID);
        // inflight は自動解除しない
        expect(deps.db.clearInflightOperation).not.toHaveBeenCalled();
      }
    });
  });

  // -------------------------------------------------------------------------
  // PROP-BILL-053d: Failure after cancel API
  // -------------------------------------------------------------------------
  describe('PROP-BILL-053d: Failure after cancel API', () => {
    it('returns 503 without operationId when setInflightOperation fails (no persisted inflight row)', async () => {
      const deps = makeCancelDeps();
      (deps.db.setInflightOperation as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db write timeout'));

      const result = await handleCancel(makeCancelRequest(), deps);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.statusCode).toBe(503);
        expect(result.errorCode).toBe('DB_UPDATE_FAILED');
        expect(result.operationId).toBeUndefined();
      }
      expect(deps.payjp.cancelSubscription).not.toHaveBeenCalled();
    });

    it('re-fetch subscription status; reconcile with canceled status → success', async () => {
      const deps = makeCancelDeps();

      // HTTP 4xx → definite failure (not uncertain) → triggers reconcile path
      const definiteError = Object.assign(new Error('definite cancel error'), { status: 400 });
      (deps.payjp.cancelSubscription as ReturnType<typeof vi.fn>).mockRejectedValue(definiteError);
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

    it('TypeError from fetch-style network failure → 503 + operationId, inflight retained', async () => {
      const deps = makeCancelDeps();
      (deps.payjp.cancelSubscription as ReturnType<typeof vi.fn>).mockRejectedValue(new TypeError('fetch failed'));

      const result = await handleCancel(makeCancelRequest(), deps);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.statusCode).toBe(503);
        expect(result.errorCode).toBe('PAYJP_UNCERTAIN');
        expect(result.operationId).toBe(OPERATION_ID);
      }
      expect(deps.db.clearInflightOperation).not.toHaveBeenCalled();
    });

    it('PAYJP_CANCEL_FAILED still returns operationId when clearInflightOperation throws', async () => {
      const deps = makeCancelDeps();
      const definiteError = Object.assign(new Error('definite cancel error'), { status: 400 });
      (deps.payjp.cancelSubscription as ReturnType<typeof vi.fn>).mockRejectedValue(definiteError);
      (deps.payjp.fetchSubscription as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: PAYJP_SUBSCRIPTION_ID,
        status: 'active',
        current_period_end: Math.floor(ACCESS_END_AT.getTime() / 1000),
        trial_end: null,
        plan: { id: PLAN_ID, interval: 'month' },
        metadata: {},
      });
      (deps.db.clearInflightOperation as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB timeout'));

      const result = await handleCancel(makeCancelRequest(), deps);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.statusCode).toBe(422);
        expect(result.errorCode).toBe('PAYJP_CANCEL_FAILED');
        expect(result.operationId).toBe(OPERATION_ID);
      }
      expect(deps.db.clearInflightOperation).toHaveBeenCalledTimes(1);
    });

    it('Discord role revoke failure after cancel → 503, role_state=unknown, link session retained', async () => {
      const deps = makeCancelDeps();
      (deps.discord.removeRole as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Discord 403 Forbidden'));

      const result = await handleCancel(makeCancelRequest(), deps);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.statusCode).toBe(503);
        expect(result.errorCode).toBe('DISCORD_ROLE_REVOKE_FAILED');
        // PAY.JP cancel + DB update succeeded (inflight cleared); include operationId for recovery correlation.
        expect(result.operationId).toBe(OPERATION_ID);
      }
      expect(deps.db.updateMemberRoleState).toHaveBeenCalledWith(MEMBER_ID, 'unknown');
      // §8 item 3: link_session is consumed before PAY.JP write, regardless of outcome
      expect(deps.db.consumeLinkSession).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // PROP-BILL-053e: Reconciliation failure
  // -------------------------------------------------------------------------
  describe('PROP-BILL-053e: Reconciliation failure', () => {
    it('PAY.JP unreachable during re-fetch → 503 + operationId, inflight retained', async () => {
      const deps = makeCancelDeps();

      // HTTP 4xx → definite failure → reconcile path
      const definiteError = Object.assign(new Error('definite cancel error'), { status: 400 });
      (deps.payjp.cancelSubscription as ReturnType<typeof vi.fn>).mockRejectedValue(definiteError);
      // fetchSubscription (reconcile) も失敗
      (deps.payjp.fetchSubscription as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('PAY.JP unreachable'));

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
