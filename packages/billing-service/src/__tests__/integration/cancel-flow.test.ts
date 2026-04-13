/**
 * Tier 2 Integration Tests — Cancel Flow (Green Phase)
 *
 * PROP-BILL-042 〜 PROP-BILL-050, PROP-BILL-059〜061, PROP-BILL-063
 */

import type { CancelFormTokenRecord, LinkSessionRecord, Member } from '@hayane/shared';
import { describe, expect, it, vi } from 'vitest';
import { handleCancel } from '../../shell/cancel.js';
import type { BillingConfig, BillingDeps, DbClient, DiscordClient, PayjpClient } from '../../shell/types.js';

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
    inflight_subscribe_plan_id: null,
    privacy_consented_at: null,
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
    discord_access_token_encrypted: null,
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
    planRoleMapping: { [PLAN_ID]: 'role-001' },
    planInitialChargeAmounts: { [PLAN_ID]: 1000 },
    initialChargeAmount: 1000,
    initialChargeAmountCurrency: 'jpy',
    googleFormCancelBaseUrl: 'https://docs.google.com/forms/d/e/test-form/viewform',
    googleFormCancelEmailEntryId: '1111111111',
    googleFormCancelTokenEntryId: '2222222222',
    googleFormCancelSecret: 'google-shared-secret',
    googleFormCancelTokenSecret: 'google-token-secret',
    googleFormCancelTokenTtlSeconds: 900,
    cancelNoticeCycles: 1,
    accessGateSessionTtlSeconds: 86400,
  };
}

function makeUpdatedMemberAfterCancel(member: Member): Member {
  return {
    ...member,
    cancel_requested_at: NOW,
    subscription_status: 'canceled',
    access_end_at: ACCESS_END_AT,
    next_billing_at: ACCESS_END_AT,
    inflight_operation_id: null,
    inflight_operation_type: null,
    inflight_operation_started_at: null,
    role_state: 'granted',
  };
}

function makeCancelFormToken(overrides: Partial<CancelFormTokenRecord> = {}): CancelFormTokenRecord {
  return {
    id: '00000000-0000-0000-0000-000000000555',
    member_id: MEMBER_ID,
    email: 'test@example.com',
    expires_at: new Date(NOW.getTime() + 3600 * 1000),
    used_at: null,
    created_at: NOW,
    ...overrides,
  };
}

function makeSuccessfulDeps(memberOverrides: Partial<Member> = {}): BillingDeps {
  const member = makeMember(memberOverrides);
  const updatedMember = makeUpdatedMemberAfterCancel(member);

  const db: DbClient = {
    findMemberByDiscordUserId: vi.fn().mockResolvedValue(member),
    findMemberById: vi.fn().mockResolvedValue(member),
    upsertProvisionalMember: vi.fn().mockResolvedValue(member),
    upsertProvisionalMemberByEmail: vi.fn().mockResolvedValue(member),
    updateMemberDiscordUserId: vi.fn().mockResolvedValue(member),
    findLinkSession: vi.fn().mockResolvedValue(makeLinkSession()),
    consumeLinkSession: vi.fn().mockResolvedValue(undefined),
    insertCancelFormToken: vi.fn().mockResolvedValue(makeCancelFormToken()),
    findCancelFormToken: vi.fn().mockResolvedValue(makeCancelFormToken()),
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
    updateMemberAfterCancel: vi.fn().mockResolvedValue(updatedMember),
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
    cancelSubscription: vi.fn().mockResolvedValue(makePayjpCanceledSubscription()),
    fetchCustomer: vi.fn().mockResolvedValue(undefined as never),
    fetchCharge: vi.fn().mockResolvedValue(undefined as never),
    fetchSubscription: vi.fn().mockResolvedValue(makePayjpCanceledSubscription()),
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

function makeCancelRequest(overrides: Record<string, string> = {}) {
  return {
    origin: 'https://frontend.example.com',
    linkSessionToken: LINK_SESSION_TOKEN,
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
      (deps.db.findLinkSession as ReturnType<typeof vi.fn>).mockResolvedValue(makeLinkSession({ used_at: NOW }));
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
      expect(deps.discord.removeRole).toHaveBeenCalledWith('guild-001', DISCORD_USER_ID, 'role-001');
      expect(deps.db.updateMemberRoleState).toHaveBeenCalledWith(MEMBER_ID, 'revoked');
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
    it('PAY.JP cancel API called, cancel_requested_at set, access_end_at updated, inflight cleared, Discord role revoked', async () => {
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
      expect(deps.discord.removeRole).toHaveBeenCalledWith('guild-001', DISCORD_USER_ID, 'role-001');
      expect(deps.db.updateMemberRoleState).toHaveBeenCalledWith(MEMBER_ID, 'revoked');
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

      await Promise.all([handleCancel(makeCancelRequest(), deps1), handleCancel(makeCancelRequest(), deps2)]);

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
    it('503 + existing operationId; link session not consumed (retry same token)', async () => {
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
      (deps.discord.removeRole as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callOrder.push('removeRole');
        return Promise.resolve();
      });
      (deps.db.updateMemberRoleState as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callOrder.push('updateMemberRoleState');
        return Promise.resolve();
      });

      await handleCancel(makeCancelRequest(), deps);

      const idxLock = callOrder.indexOf('acquireAdvisoryLock');
      const idxFindMember = callOrder.indexOf('findMemberByDiscordUserId');
      const idxFindSession = callOrder.indexOf('findLinkSession');
      const idxConsumeSession = callOrder.indexOf('consumeLinkSession');
      const idxInflight = callOrder.indexOf('setInflightOperation');
      const idxCancel = callOrder.indexOf('cancelSubscription');
      const idxUpdateMember = callOrder.indexOf('updateMemberAfterCancel');
      const idxRemoveRole = callOrder.indexOf('removeRole');
      const idxUpdateRoleState = callOrder.indexOf('updateMemberRoleState');

      // findSession → findMember(initial) → Lock → findMember(locked) → setInflight
      //   → cancelSubscription → updateMember → removeRole → updateRoleState → consumeSession
      expect(idxFindSession).toBeLessThan(idxLock);
      expect(idxFindMember).toBeLessThan(idxLock);
      expect(idxLock).toBeLessThan(idxInflight);
      expect(idxInflight).toBeLessThan(idxCancel);
      expect(idxCancel).toBeLessThan(idxUpdateMember);
      expect(idxUpdateMember).toBeLessThan(idxRemoveRole);
      expect(idxRemoveRole).toBeLessThan(idxUpdateRoleState);
      expect(idxUpdateRoleState).toBeLessThan(idxConsumeSession);
    });
  });
});
