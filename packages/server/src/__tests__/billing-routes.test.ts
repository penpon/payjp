import { createInMemoryAuthDb } from '@hayane/auth-service/test-utils';
import type { BillingConfig, BillingDeps, DbClient, DiscordClient, PayjpClient } from '@hayane/billing-service';
import type { LinkSessionRecord, Member } from '@hayane/shared';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NOW = new Date('2025-04-01T10:00:00Z');
const FRONTEND_BASE_URL = 'https://example.com';
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

const APP_CONFIG = {
  frontendBaseUrl: FRONTEND_BASE_URL,
  discordClientId: 'test-client-id',
  discordClientSecret: 'test-client-secret',
  discordRedirectUri: 'https://api.example.com/v1/auth/discord/callback',
  db: createInMemoryAuthDb(),
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
    privacy_consented_at: null,
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
    frontendBaseUrl: FRONTEND_BASE_URL,
    allowedPlanIds: [PLAN_ID],
    discordGuildId: 'guild-001',
    discordPaidRoleId: 'role-001',
    initialChargeAmount: 1000,
    initialChargeAmountCurrency: 'jpy',
  };
}

function makeUpdatedMemberAfterSubscribe(member: Member): Member {
  const periodEndMs = makePayjpSubscription().current_period_end * 1000;
  return {
    ...member,
    payjp_customer_id: PAYJP_CUSTOMER_ID,
    payjp_subscription_id: PAYJP_SUBSCRIPTION_ID,
    payjp_initial_charge_id: PAYJP_CHARGE_ID,
    payjp_plan_id: PLAN_ID,
    subscription_status: 'trial',
    first_trial_granted_at: NOW,
    access_end_at: new Date(periodEndMs),
    next_billing_at: new Date(periodEndMs),
    role_state: 'granted',
    // updateMemberAfterSubscribe の SQL は inflight 列を触らないため、setInflightOperation の値がそのまま残る
    inflight_operation_id: OPERATION_ID,
    inflight_operation_type: 'subscribe',
    inflight_operation_started_at: NOW,
    privacy_consented_at: NOW,
  };
}

// ---------------------------------------------------------------------------
// Mock deps factory
// ---------------------------------------------------------------------------

function makeMockDeps(memberOverrides: Partial<Member> = {}): BillingDeps {
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
    updateMemberRoleState: vi.fn().mockResolvedValue(undefined),
    acquireAdvisoryLock: vi.fn().mockResolvedValue(true),
    releaseAdvisoryLock: vi.fn().mockResolvedValue(undefined),
    withTransactionLock: vi.fn().mockImplementation((_key: string, fn: (txDb: unknown) => Promise<unknown>) => fn({})),
  };

  const payjp: PayjpClient = {
    fetchToken: vi.fn().mockResolvedValue({
      id: PAYJP_TOKEN_ID,
      used: false,
      three_d_secure_status: 'verified',
      card: { id: 'card-001' },
    }),
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

function createApp(deps?: BillingDeps) {
  return buildApp(APP_CONFIG, deps ?? makeMockDeps());
}

function subscribePayload() {
  return {
    email: EMAIL,
    payjpToken: PAYJP_TOKEN_ID,
    planId: PLAN_ID,
    privacyConsented: true,
  };
}

function cancelPayload() {
  return {};
}

/** Common inject options for billing endpoints */
function injectOpts(
  url: string,
  payload: Record<string, unknown>,
  overrides: { origin?: string; withCookie?: boolean } = {},
) {
  const { origin = FRONTEND_BASE_URL, withCookie = true } = overrides;
  return {
    method: 'POST' as const,
    url,
    headers: { origin, 'content-type': 'application/json' },
    ...(withCookie && { cookies: { '__Host-link_session': LINK_SESSION_TOKEN } }),
    payload,
  };
}

// ---------------------------------------------------------------------------
// POST /v1/subscriptions
// ---------------------------------------------------------------------------

describe('POST /v1/subscriptions', () => {
  const SUBSCRIBE_URL = '/v1/subscriptions';

  it('returns 200 with SubscriptionResponse on success', async () => {
    const app = createApp();
    const res = await app.inject(injectOpts(SUBSCRIBE_URL, subscribePayload()));

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.memberId).toBe(MEMBER_ID);
    expect(body.subscriptionStatus).toBe('trial');
    expect(body.planId).toBe(PLAN_ID);
  });

  it('returns 403 for invalid origin', async () => {
    const app = createApp();
    const res = await app.inject(injectOpts(SUBSCRIBE_URL, subscribePayload(), { origin: 'https://evil.com' }));

    expect(res.statusCode).toBe(403);
    expect(res.json().errorCode).toBe('FORBIDDEN_ORIGIN');
  });

  it('returns 401 without link_session cookie', async () => {
    const deps = makeMockDeps();
    (deps.db.findLinkSession as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const app = createApp(deps);

    const res = await app.inject(injectOpts(SUBSCRIBE_URL, subscribePayload(), { withCookie: false }));

    expect(res.statusCode).toBe(401);
    expect(res.json().errorCode).toBe('INVALID_LINK_SESSION');
  });

  it('returns 422 for invalid planId', async () => {
    const app = createApp();
    const res = await app.inject(injectOpts(SUBSCRIBE_URL, { ...subscribePayload(), planId: 'invalid-plan' }));

    expect(res.statusCode).toBe(422);
    expect(res.json().errorCode).toBe('INVALID_PLAN_ID');
  });

  it('returns 422 when privacyConsented is false (CONSENT_REQUIRED)', async () => {
    const app = createApp();
    const res = await app.inject(injectOpts(SUBSCRIBE_URL, { ...subscribePayload(), privacyConsented: false }));

    expect(res.statusCode).toBe(422);
    expect(res.json().errorCode).toBe('CONSENT_REQUIRED');
  });

  it('returns 422 for non-verified 3DS token', async () => {
    const deps = makeMockDeps();
    (deps.payjp.fetchToken as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: PAYJP_TOKEN_ID,
      used: false,
      three_d_secure_status: 'attempted',
      card: { id: 'card-001' },
    });
    const app = createApp(deps);

    const res = await app.inject(injectOpts(SUBSCRIBE_URL, subscribePayload()));

    expect(res.statusCode).toBe(422);
    expect(res.json().errorCode).toBe('THREE_D_SECURE_REQUIRED');
  });

  it('returns 503 with operationId on inflight operation', async () => {
    const deps = makeMockDeps({ inflight_operation_id: 'existing-op-id' });
    const app = createApp(deps);

    const res = await app.inject(injectOpts(SUBSCRIBE_URL, subscribePayload()));

    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.errorCode).toBe('INFLIGHT_OPERATION');
    expect(body.operationId).toBe('existing-op-id');
  });

  it('does not clear __Host-link_session cookie on success (cookie expires naturally)', async () => {
    const app = createApp();
    const res = await app.inject(injectOpts(SUBSCRIBE_URL, subscribePayload()));

    expect(res.statusCode).toBe(200);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('does not clear __Host-link_session cookie on subscribe error', async () => {
    const app = createApp();
    const res = await app.inject(injectOpts(SUBSCRIBE_URL, subscribePayload(), { origin: 'https://evil.com' }));

    expect(res.statusCode).toBe(403);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('includes security headers', async () => {
    const app = createApp();
    const res = await app.inject(injectOpts(SUBSCRIBE_URL, subscribePayload()));

    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('returns 503 with operationId when PAY.JP createCustomer throws', async () => {
    const deps = makeMockDeps();
    const err = new Error('timeout');
    (err as NodeJS.ErrnoException).code = 'ETIMEDOUT';
    (deps.payjp.createCustomer as ReturnType<typeof vi.fn>).mockRejectedValue(err);
    const app = createApp(deps);

    const res = await app.inject(injectOpts(SUBSCRIBE_URL, subscribePayload()));

    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.errorCode).toBe('PAYJP_UNCERTAIN');
    expect(body.operationId).toBe(OPERATION_ID);
  });

  it('returns 409 when Discord membership check fails', async () => {
    const deps = makeMockDeps();
    (deps.discord.checkMembership as ReturnType<typeof vi.fn>).mockResolvedValue({
      isMember: false,
      canAssignRole: true,
    });
    const app = createApp(deps);

    const res = await app.inject(injectOpts(SUBSCRIBE_URL, subscribePayload()));

    expect(res.statusCode).toBe(409);
    expect(res.json().errorCode).toBe('DISCORD_NOT_MEMBER');
  });

  it('returns 200 with existing subscription when already active', async () => {
    const deps = makeMockDeps({
      subscription_status: 'active',
      access_end_at: new Date('2025-06-01T00:00:00Z'),
      payjp_subscription_id: PAYJP_SUBSCRIPTION_ID,
      payjp_plan_id: PLAN_ID,
    });
    const app = createApp(deps);

    const res = await app.inject(injectOpts(SUBSCRIBE_URL, subscribePayload()));

    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/subscriptions/status
// ---------------------------------------------------------------------------

describe('GET /v1/subscriptions/status', () => {
  const STATUS_URL = '/v1/subscriptions/status';

  it('allows request when origin header is omitted (same-origin browser GET)', async () => {
    const app = createApp();
    const res = await app.inject({ method: 'GET', url: STATUS_URL });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ subscription: null });
  });

  it('returns 200 subscription null when no link_session cookie', async () => {
    const app = createApp();
    const res = await app.inject({
      method: 'GET',
      url: STATUS_URL,
      headers: { origin: FRONTEND_BASE_URL },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ subscription: null });
  });

  it('returns 503 when database lookup throws', async () => {
    const deps = makeMockDeps();
    (deps.db.findLinkSession as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db down'));
    const app = createApp(deps);

    const res = await app.inject({
      method: 'GET',
      url: STATUS_URL,
      headers: { origin: FRONTEND_BASE_URL },
      cookies: { '__Host-link_session': LINK_SESSION_TOKEN },
    });

    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.errorCode).toBe('STATUS_UNAVAILABLE');
  });

  it('returns 200 subscription null when link session is expired without loading member', async () => {
    const deps = makeMockDeps({
      subscription_status: 'active',
      payjp_plan_id: PLAN_ID,
      access_end_at: new Date('2025-06-01T00:00:00Z'),
      payjp_subscription_id: PAYJP_SUBSCRIPTION_ID,
      payjp_customer_id: PAYJP_CUSTOMER_ID,
    });
    (deps.db.findLinkSession as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeLinkSession({ expires_at: new Date('2025-01-01T00:00:00Z') }),
    );
    const app = createApp(deps);

    const res = await app.inject({
      method: 'GET',
      url: STATUS_URL,
      headers: { origin: FRONTEND_BASE_URL },
      cookies: { '__Host-link_session': LINK_SESSION_TOKEN },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ subscription: null });
    expect(deps.db.findMemberByDiscordUserId).not.toHaveBeenCalled();
  });

  it('returns 200 with subscription when link session is consumed but member has active subscription', async () => {
    const deps = makeMockDeps({
      subscription_status: 'active',
      payjp_plan_id: PLAN_ID,
      access_end_at: new Date('2025-06-01T00:00:00Z'),
      payjp_subscription_id: PAYJP_SUBSCRIPTION_ID,
      payjp_customer_id: PAYJP_CUSTOMER_ID,
    });
    (deps.db.findLinkSession as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeLinkSession({ used_at: new Date('2025-03-15T00:00:00Z') }),
    );
    const app = createApp(deps);

    const res = await app.inject({
      method: 'GET',
      url: STATUS_URL,
      headers: { origin: FRONTEND_BASE_URL },
      cookies: { '__Host-link_session': LINK_SESSION_TOKEN },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { subscription: { status: string; planId: string; accessEndAt: string } };
    expect(body.subscription).toMatchObject({
      status: 'active',
      planId: PLAN_ID,
    });
    expect(body.subscription.accessEndAt).toMatch(/2025-06-01/);
    expect(deps.db.findMemberByDiscordUserId).toHaveBeenCalledWith(DISCORD_USER_ID);
  });

  it('returns 200 subscription null when link session is consumed and member has no subscription', async () => {
    const deps = makeMockDeps({
      subscription_status: null,
      payjp_plan_id: null,
    });
    (deps.db.findLinkSession as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeLinkSession({ used_at: new Date('2025-03-15T00:00:00Z') }),
    );
    const app = createApp(deps);

    const res = await app.inject({
      method: 'GET',
      url: STATUS_URL,
      headers: { origin: FRONTEND_BASE_URL },
      cookies: { '__Host-link_session': LINK_SESSION_TOKEN },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ subscription: null });
    expect(deps.db.findMemberByDiscordUserId).toHaveBeenCalledWith(DISCORD_USER_ID);
  });

  it('returns 200 with subscription when link session is valid', async () => {
    const deps = makeMockDeps({
      subscription_status: 'active',
      payjp_plan_id: PLAN_ID,
      access_end_at: new Date('2025-06-01T00:00:00Z'),
      payjp_subscription_id: PAYJP_SUBSCRIPTION_ID,
      payjp_customer_id: PAYJP_CUSTOMER_ID,
    });
    const app = createApp(deps);

    const res = await app.inject({
      method: 'GET',
      url: STATUS_URL,
      headers: { origin: FRONTEND_BASE_URL },
      cookies: { '__Host-link_session': LINK_SESSION_TOKEN },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { subscription: { status: string; planId: string; accessEndAt: string } };
    expect(body.subscription).toMatchObject({
      status: 'active',
      planId: PLAN_ID,
    });
    expect(body.subscription.accessEndAt).toMatch(/2025-06-01/);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/subscriptions/cancel
// ---------------------------------------------------------------------------

describe('POST /v1/subscriptions/cancel', () => {
  const CANCEL_URL = '/v1/subscriptions/cancel';

  function makeCancelDeps() {
    const accessEndAt = new Date('2025-05-01T00:00:00Z');
    const cancelSub = makePayjpSubscription({ status: 'canceled' });
    const member = makeMember({
      subscription_status: 'active',
      access_end_at: accessEndAt,
      payjp_subscription_id: PAYJP_SUBSCRIPTION_ID,
      payjp_customer_id: PAYJP_CUSTOMER_ID,
    });
    const updatedMember = {
      ...member,
      cancel_requested_at: NOW,
      subscription_status: 'canceled' as const,
      inflight_operation_id: null,
      inflight_operation_type: null,
      inflight_operation_started_at: null,
    };

    const deps = makeMockDeps();
    (deps.db.findMemberByDiscordUserId as ReturnType<typeof vi.fn>).mockResolvedValue(member);
    (deps.db.findLinkSession as ReturnType<typeof vi.fn>).mockResolvedValue(makeLinkSession());
    (deps.db.updateMemberAfterCancel as ReturnType<typeof vi.fn>).mockResolvedValue(updatedMember);
    (deps.payjp.cancelSubscription as ReturnType<typeof vi.fn>).mockResolvedValue(cancelSub);
    return deps;
  }

  it('returns 200 with CancelResponse on success', async () => {
    const app = createApp(makeCancelDeps());
    const res = await app.inject(injectOpts(CANCEL_URL, cancelPayload()));

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.memberId).toBe(MEMBER_ID);
  });

  it('returns 403 for invalid origin', async () => {
    const app = createApp(makeCancelDeps());
    const res = await app.inject(injectOpts(CANCEL_URL, cancelPayload(), { origin: 'https://evil.com' }));

    expect(res.statusCode).toBe(403);
    expect(res.json().errorCode).toBe('FORBIDDEN_ORIGIN');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('returns 409 when no active subscription', async () => {
    const deps = makeCancelDeps();
    (deps.db.findMemberByDiscordUserId as ReturnType<typeof vi.fn>).mockResolvedValue(makeMember());
    const app = createApp(deps);

    const res = await app.inject(injectOpts(CANCEL_URL, cancelPayload()));

    expect(res.statusCode).toBe(409);
    expect(res.json().errorCode).toBe('NO_SUBSCRIPTION');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('returns 200 idempotently when already canceled', async () => {
    const deps = makeCancelDeps();
    const member = makeMember({
      subscription_status: 'canceled',
      access_end_at: new Date('2025-05-01T00:00:00Z'),
      payjp_subscription_id: PAYJP_SUBSCRIPTION_ID,
      payjp_customer_id: PAYJP_CUSTOMER_ID,
      cancel_requested_at: new Date('2025-03-30T00:00:00Z'),
    });
    (deps.db.findMemberByDiscordUserId as ReturnType<typeof vi.fn>).mockResolvedValue(member);
    const app = createApp(deps);

    const res = await app.inject(injectOpts(CANCEL_URL, cancelPayload()));

    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it('does not clear __Host-link_session cookie on cancel success (cookie expires naturally)', async () => {
    const app = createApp(makeCancelDeps());
    const res = await app.inject(injectOpts(CANCEL_URL, cancelPayload()));

    expect(res.statusCode).toBe(200);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('includes security headers', async () => {
    const app = createApp(makeCancelDeps());
    const res = await app.inject(injectOpts(CANCEL_URL, cancelPayload()));

    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('returns 503 with operationId on inflight operation', async () => {
    const deps = makeCancelDeps();
    const member = makeMember({
      subscription_status: 'active',
      access_end_at: new Date('2025-05-01T00:00:00Z'),
      payjp_subscription_id: PAYJP_SUBSCRIPTION_ID,
      payjp_customer_id: PAYJP_CUSTOMER_ID,
      inflight_operation_id: 'existing-cancel-op',
    });
    (deps.db.findMemberByDiscordUserId as ReturnType<typeof vi.fn>).mockResolvedValue(member);
    const app = createApp(deps);

    const res = await app.inject(injectOpts(CANCEL_URL, cancelPayload()));

    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.errorCode).toBe('INFLIGHT_OPERATION');
    expect(body.operationId).toBe('existing-cancel-op');
  });

  it('returns 503 with operationId when PAY.JP cancel throws', async () => {
    const deps = makeCancelDeps();
    const err = new Error('timeout');
    (err as NodeJS.ErrnoException).code = 'ETIMEDOUT';
    (deps.payjp.cancelSubscription as ReturnType<typeof vi.fn>).mockRejectedValue(err);
    (deps.payjp.fetchSubscription as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('also timeout'));
    const app = createApp(deps);

    const res = await app.inject(injectOpts(CANCEL_URL, cancelPayload()));

    expect(res.statusCode).toBe(503);
    expect(res.json().operationId).toBe(OPERATION_ID);
  });

  it('returns 401 when link session is expired', async () => {
    const deps = makeCancelDeps();
    (deps.db.findLinkSession as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeLinkSession({ expires_at: new Date('2025-01-01T00:00:00Z') }),
    );
    const app = createApp(deps);

    const res = await app.inject(injectOpts(CANCEL_URL, cancelPayload()));

    expect(res.statusCode).toBe(401);
    expect(res.json().errorCode).toBe('EXPIRED_LINK_SESSION');
  });
});
