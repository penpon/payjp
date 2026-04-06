/**
 * Tier 2 Integration Tests — Cancel Flow (Green Phase)
 *
 * PROP-BILL-042 〜 PROP-BILL-050, PROP-BILL-059〜061, PROP-BILL-063
 */
import { describe, it, expect, vi } from 'vitest';
import { handleCancel } from '../../shell/cancel.js';
import type {
  BillingDeps,
  DbClient,
  PayjpClient,
  DiscordClient,
  BillingConfig,
} from '../../shell/types.js';
import type { Member, LinkSessionRecord } from '@hayane/shared';

// -------------------------------------------------------------------------
// フィクスチャ
// -------------------------------------------------------------------------

const NOW = new Date('2025-04-01T10:00:00Z');
const DISCORD_USER_ID = 'discord-user-001';
const MEMBER_ID = 'member-uuid-001';
const PLAN_ID = 'plan-allowed-001';
const PAYJP_SUBSCRIPTION_ID = 'sub_test_001';
const OPERATION_ID = 'op-cancel-001';
const LINK_SESSION_TOKEN = 'link-session-cancel-abc';

// accessEndAt: 来月 5/01 → acceptanceStart は 4/01 → NOW(4/01) は許容境界
const ACCESS_END_AT = new Date('2025-05-01T00:00:00Z');

function makeMember(overrides: Partial<Member> = {}): Member {
  return {
    id: MEMBER_ID,
    discord_user_id: DISCORD_USER_ID,
    email: 'test@example.com',
    payjp_customer_id: 'cus_001',
    payjp_subscription_id: PAYJP_SUBSCRIPTION_ID,
    payjp_initial_charge_id: 'ch_001',
    payjp_plan_id: PLAN_ID,
    subscription_status: 'active',
    first_trial_granted_at: new Date('2025-01-01T00:00:00Z'),
    initial_charge_paid_at: new Date('2025-01-01T00:00:00Z'),
    cancel_requested_at: null,
    inflight_operation_id: null,
    inflight_operation_type: null,
    inflight_operation_started_at: null,
    access_end_at: ACCESS_END_AT,
    next_billing_at: ACCESS_END_AT,
    role_state: 'granted',
    last_synced_at: NOW,
    last_payjp_event_created_at: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function makeLinkSession(overrides: Partial<LinkSessionRecord> = {}): LinkSessionRecord {
  return {
    id: 'link-session-cancel-id-001',
    link_session_token_hash: 'dummy-hash',
    discord_user_id: DISCORD_USER_ID,
    expires_at: new Date(NOW.getTime() + 3600 * 1000),
    used_at: null,
    created_at: NOW,
    ...overrides,
  };
}

function makePayjpCanceledSubscription() {
  return {
    id: PAYJP_SUBSCRIPTION_ID,
    status: 'canceled',
    current_period_end: Math.floor(ACCESS_END_AT.getTime() / 1000),
    trial_end: null,
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

function makeUpdatedMemberAfterCancel(member: Member): Member {
  return {
    ...member,
    cancel_requested_at: NOW,
    subscription_status: 'canceled',
    access_end_at: ACCESS_END_AT,
    inflight_operation_id: null,
    inflight_operation_type: null,
    inflight_operation_started_at: null,
  };
}

function makeSuccessfulDeps(memberOverrides: Partial<Member> = {}): BillingDeps {
  const member = makeMember(memberOverrides);
  const updatedMember = makeUpdatedMemberAfterCancel(member);

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
    updateMemberAfterCancel: vi.fn().mockResolvedValue(updatedMember),
    acquireAdvisoryLock: vi.fn().mockResolvedValue(true),
    releaseAdvisoryLock: vi.fn().mockResolvedValue(undefined),
  };

  const payjp: PayjpClient = {
    fetchToken: vi.fn().mockResolvedValue(undefined as never),
    createCustomer: vi.fn().mockResolvedValue(undefined as never),
    createCharge: vi.fn().mockResolvedValue(undefined as never),
    createSubscription: vi.fn().mockResolvedValue(undefined as never),
    cancelSubscription: vi.fn().mockResolvedValue(makePayjpCanceledSubscription()),
    fetchCustomer: vi.fn().mockResolvedValue(undefined as never),
    fetchCharge: vi.fn().mockResolvedValue(undefined as never),
    fetchSubscription: vi.fn().mockResolvedValue(makePayjpCanceledSubscription()),
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

function makeCancelRequest(overrides: Record<string, string> = {}) {
  return {
    origin: 'https://frontend.example.com',
    linkSessionToken: LINK_SESSION_TOKEN,
    discordUserId: DISCORD_USER_ID,
    ...overrides,
  };
}

// -------------------------------------------------------------------------
// テスト
// -------------------------------------------------------------------------

describe('POST /v1/subscriptions/cancel — Integration', () => {
  // -------------------------------------------------------------------------
  // PROP-BILL-059: Origin validation (cancel)
  // -------------------------------------------------------------------------
  describe('PROP-BILL-059: Cancel Origin validation', () => {
    it('rejects with 403 when Origin is absent', async () => {
      const deps = makeSuccessfulDeps();
      const result = await handleCancel(makeCancelRequest({ origin: '' }), deps);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.statusCode).toBe(403);
      }
    });

    it('rejects with 403 when Origin is null', async () => {
      const deps = makeSuccessfulDeps();
      const result = await handleCancel(makeCancelRequest({ origin: 'null' }), deps);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.statusCode).toBe(403);
      }
    });

    it('rejects with 403 when Origin is mismatched', async () => {
      const deps = makeSuccessfulDeps();
      const result = await handleCancel(makeCancelRequest({ origin: 'https://evil.com' }), deps);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.statusCode).toBe(403);
      }
    });
  });

  // -------------------------------------------------------------------------
  // PROP-BILL-042: No existing subscription
  // -------------------------------------------------------------------------
  describe('PROP-BILL-042: No existing subscription', () => {
    it('returns 409 for no existing subscription', async () => {
      const deps = makeSuccessfulDeps({ subscription_status: null });
      const result = await handleCancel(makeCancelRequest(), deps);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.statusCode).toBe(409);
        expect(result.errorCode).toBe('NO_SUBSCRIPTION');
      }
    });

    it('returns 409 for paused status', async () => {
      const deps = makeSuccessfulDeps({ subscription_status: 'paused' });
      const result = await handleCancel(makeCancelRequest(), deps);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.statusCode).toBe(409);
      }
    });

    it('returns 409 for deleted status', async () => {
      const deps = makeSuccessfulDeps({ subscription_status: 'deleted' });
      const result = await handleCancel(makeCancelRequest(), deps);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.statusCode).toBe(409);
      }
    });
  });

  // -------------------------------------------------------------------------
  // PROP-BILL-043: access_end_at required
  // -------------------------------------------------------------------------
  describe('PROP-BILL-043: access_end_at required', () => {
    it('returns 409 when access_end_at IS NULL', async () => {
      const deps = makeSuccessfulDeps({
        subscription_status: 'active',
        access_end_at: null,
      });
      const result = await handleCancel(makeCancelRequest(), deps);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.statusCode).toBe(409);
        expect(result.errorCode).toBe('ACCESS_END_AT_NULL');
      }
    });
  });

  // -------------------------------------------------------------------------
  // PROP-BILL-044: payjp_subscription_id required
  // -------------------------------------------------------------------------
  describe('PROP-BILL-044: payjp_subscription_id required', () => {
    it('returns 409 when payjp_subscription_id IS NULL', async () => {
      const deps = makeSuccessfulDeps({ payjp_subscription_id: null });
      const result = await handleCancel(makeCancelRequest(), deps);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.statusCode).toBe(409);
        expect(result.errorCode).toBe('NO_PAYJP_SUBSCRIPTION');
      }
    });
  });

  // -------------------------------------------------------------------------
  // PROP-BILL-045: Cancel acceptance boundary
  // -------------------------------------------------------------------------
  describe('PROP-BILL-045: Cancel acceptance boundary', () => {
    it('returns 409 when now_jst < acceptance_start', async () => {
      // access_end_at = 5/1 → acceptanceStart = 4/1 00:00 JST = 3/31 15:00 UTC
      // now = 3/25 UTC (JST でも 3/26 → 受付開始前)
      const earlyNow = new Date('2025-03-25T00:00:00Z');
      const deps = makeSuccessfulDeps();
      deps.clock = () => earlyNow;
      const result = await handleCancel(makeCancelRequest(), deps);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.statusCode).toBe(409);
        expect(result.errorCode).toBe('BEFORE_ACCEPTANCE_BOUNDARY');
      }
    });

    it('proceeds when now_jst == acceptance_start (inclusive)', async () => {
      // access_end_at = 5/1 00:00 UTC → acceptanceStart UTC = 3/31 15:00:00 UTC (JST 4/1 00:00)
      // now を acceptanceStart ちょうどに設定
      const acceptanceStartUtc = new Date('2025-03-31T15:00:00Z');
      const deps = makeSuccessfulDeps();
      deps.clock = () => acceptanceStartUtc;
      const result = await handleCancel(makeCancelRequest(), deps);
      expect(result.ok).toBe(true);
    });

    it('proceeds when now_jst > acceptance_start', async () => {
      // NOW = 4/1 10:00 UTC (JST 4/1 19:00) → 受付開始後
      const deps = makeSuccessfulDeps();
      const result = await handleCancel(makeCancelRequest(), deps);
      expect(result.ok).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // PROP-BILL-046: Cancel link session consumption
  // -------------------------------------------------------------------------
  describe('PROP-BILL-046: Cancel link session consumption', () => {
    it('consumed after pre-cancel validations; re-send → 401', async () => {
      const deps = makeSuccessfulDeps();
      let consumed = false;
      (deps.db.consumeLinkSession as ReturnType<typeof vi.fn>).mockImplementation(() => {
        consumed = true;
        return Promise.resolve();
      });

      await handleCancel(makeCancelRequest(), deps);
      expect(consumed).toBe(true);

      // 2回目: consumed セッションを返す
      (deps.db.findLinkSession as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeLinkSession({ used_at: NOW }),
      );
      const result2 = await handleCancel(makeCancelRequest(), deps);
      expect(result2.ok).toBe(false);
      if (!result2.ok) {
        expect(result2.statusCode).toBe(401);
      }
    });
  });

  // -------------------------------------------------------------------------
  // PROP-BILL-047: Cancel idempotency
  // -------------------------------------------------------------------------
  describe('PROP-BILL-047: Cancel idempotency', () => {
    it('cancel_requested_at already set → 200, PAY.JP cancel calls = 0', async () => {
      const canceledMember = makeMember({
        cancel_requested_at: new Date('2025-03-31T00:00:00Z'),
        subscription_status: 'canceled',
      });
      const deps = makeSuccessfulDeps();
      (deps.db.findMemberByDiscordUserId as ReturnType<typeof vi.fn>).mockResolvedValue(canceledMember);
      const result = await handleCancel(makeCancelRequest(), deps);
      expect(result.ok).toBe(true);
      expect(deps.payjp.cancelSubscription).not.toHaveBeenCalled();
      // REQ-BILL-022: link session is consumed even on idempotent path
      expect(deps.db.consumeLinkSession).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // PROP-BILL-048: Cancel operationId persistence
  // -------------------------------------------------------------------------
  describe('PROP-BILL-048: Cancel operationId persistence', () => {
    it('operationId persisted before PAY.JP cancel call', async () => {
      const callOrder: string[] = [];
      const deps = makeSuccessfulDeps();
      (deps.db.setInflightOperation as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callOrder.push('setInflightOperation');
        return Promise.resolve();
      });
      (deps.payjp.cancelSubscription as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callOrder.push('cancelSubscription');
        return Promise.resolve(makePayjpCanceledSubscription());
      });

      await handleCancel(makeCancelRequest(), deps);

      const inflightIdx = callOrder.indexOf('setInflightOperation');
      const cancelIdx = callOrder.indexOf('cancelSubscription');
      expect(inflightIdx).toBeGreaterThanOrEqual(0);
      expect(cancelIdx).toBeGreaterThanOrEqual(0);
      expect(inflightIdx).toBeLessThan(cancelIdx);
    });
  });

  // -------------------------------------------------------------------------
  // PROP-BILL-049: Cancel success
  // -------------------------------------------------------------------------
  describe('PROP-BILL-049: Cancel success', () => {
    it('PAY.JP cancel API called, cancel_requested_at set, access_end_at updated, inflight cleared, no Discord calls', async () => {
      const deps = makeSuccessfulDeps();
      const result = await handleCancel(makeCancelRequest(), deps);

      expect(result.ok).toBe(true);
      expect(deps.payjp.cancelSubscription).toHaveBeenCalledWith(PAYJP_SUBSCRIPTION_ID);
      expect(deps.db.updateMemberAfterCancel).toHaveBeenCalledWith(
        MEMBER_ID,
        expect.objectContaining({
          cancel_requested_at: expect.any(Date),
          subscription_status: 'canceled',
          inflight_operation_id: null,
        }),
      );
      expect(deps.discord.assignRole).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // PROP-BILL-050: Cancel response schema
  // -------------------------------------------------------------------------
  describe('PROP-BILL-050: Cancel response schema', () => {
    it('matches exact schema with RFC 3339 UTC dates', async () => {
      const deps = makeSuccessfulDeps();
      const result = await handleCancel(makeCancelRequest(), deps);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const { data } = result;
        expect(data).toMatchObject({
          ok: true,
          memberId: expect.any(String),
          cancelEffectiveAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
          roleRemovalAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
        });
      }
    });
  });

  // -------------------------------------------------------------------------
  // PROP-BILL-060: Concurrent cancel
  // -------------------------------------------------------------------------
  describe('PROP-BILL-060: Concurrent cancel', () => {
    it('PAY.JP cancel API called at most once', async () => {
      const deps1 = makeSuccessfulDeps();
      const deps2 = makeSuccessfulDeps();
      (deps2.db.acquireAdvisoryLock as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      await Promise.all([
        handleCancel(makeCancelRequest(), deps1),
        handleCancel(makeCancelRequest(), deps2),
      ]);

      // deps1 のみ cancelSubscription が呼ばれる
      const calls1 = (deps1.payjp.cancelSubscription as ReturnType<typeof vi.fn>).mock.calls.length;
      const calls2 = (deps2.payjp.cancelSubscription as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(calls1 + calls2).toBeLessThanOrEqual(1);
    });
  });

  // -------------------------------------------------------------------------
  // PROP-BILL-061: Cancel inflight guard
  // -------------------------------------------------------------------------
  describe('PROP-BILL-061: Cancel inflight guard', () => {
    it('503 + existing operationId, link session NOT consumed', async () => {
      const existingOpId = 'existing-cancel-op-456';
      const deps = makeSuccessfulDeps({
        inflight_operation_id: existingOpId,
        inflight_operation_type: 'cancel',
      });
      const result = await handleCancel(makeCancelRequest(), deps);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.statusCode).toBe(503);
        expect(result.operationId).toBe(existingOpId);
      }
      expect(deps.db.consumeLinkSession).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // PROP-BILL-063: Cancel orchestration ordering
  // -------------------------------------------------------------------------
  describe('PROP-BILL-063: Cancel orchestration ordering', () => {
    it('verifies complete cancel step sequence via mock call-order recording', async () => {
      const callOrder: string[] = [];
      const deps = makeSuccessfulDeps();

      (deps.db.acquireAdvisoryLock as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callOrder.push('acquireAdvisoryLock');
        return Promise.resolve(true);
      });
      (deps.db.findMemberByDiscordUserId as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callOrder.push('findMemberByDiscordUserId');
        return Promise.resolve(makeMember());
      });
      (deps.db.findLinkSession as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callOrder.push('findLinkSession');
        return Promise.resolve(makeLinkSession());
      });
      (deps.db.consumeLinkSession as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callOrder.push('consumeLinkSession');
        return Promise.resolve();
      });
      (deps.db.setInflightOperation as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callOrder.push('setInflightOperation');
        return Promise.resolve();
      });
      (deps.payjp.cancelSubscription as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callOrder.push('cancelSubscription');
        return Promise.resolve(makePayjpCanceledSubscription());
      });
      (deps.db.updateMemberAfterCancel as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callOrder.push('updateMemberAfterCancel');
        return Promise.resolve(makeUpdatedMemberAfterCancel(makeMember()));
      });

      await handleCancel(makeCancelRequest(), deps);

      const idxLock = callOrder.indexOf('acquireAdvisoryLock');
      const idxFindMember = callOrder.indexOf('findMemberByDiscordUserId');
      const idxFindSession = callOrder.indexOf('findLinkSession');
      const idxConsumeSession = callOrder.indexOf('consumeLinkSession');
      const idxInflight = callOrder.indexOf('setInflightOperation');
      const idxCancel = callOrder.indexOf('cancelSubscription');
      const idxUpdateMember = callOrder.indexOf('updateMemberAfterCancel');

      // findSession (early validation, step 1b) → Lock → findMember → consumeSession → setInflight → cancelSubscription → updateMember
      expect(idxFindSession).toBeLessThan(idxLock);
      expect(idxLock).toBeLessThan(idxFindMember);
      expect(idxFindMember).toBeLessThan(idxConsumeSession);
      expect(idxConsumeSession).toBeLessThan(idxInflight);
      expect(idxInflight).toBeLessThan(idxCancel);
      expect(idxCancel).toBeLessThan(idxUpdateMember);
    });
  });
});
