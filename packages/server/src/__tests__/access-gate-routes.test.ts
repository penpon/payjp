import { createInMemoryAuthDb } from '@hayane/auth-service/test-utils';
import type { BillingConfig, BillingDeps, DbClient, DiscordClient, PayjpClient } from '@hayane/billing-service';
import { accessGateSessionTokenHash } from '@hayane/billing-service';
import type { CancelFormTokenRecord, LinkSessionRecord, Member, MemberSessionRecord } from '@hayane/shared';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';

const NOW = new Date('2025-04-01T10:00:00Z');
const FRONTEND_BASE_URL = 'https://example.com';
const MEMBER_ID = 'member-uuid-001';
const DISCORD_USER_ID = 'discord-user-001';
const GATE_CODE = 'operator-shared-code';

const APP_CONFIG = {
  frontendBaseUrl: FRONTEND_BASE_URL,
  discordClientId: 'test-client-id',
  discordClientSecret: 'test-client-secret',
  discordRedirectUri: 'https://api.example.com/v1/auth/discord/callback',
  db: createInMemoryAuthDb(),
};

function makeMember(overrides: Partial<Member> = {}): Member {
  return {
    id: MEMBER_ID,
    discord_user_id: DISCORD_USER_ID,
    email: 'test@example.com',
    payjp_customer_id: null,
    payjp_subscription_id: null,
    payjp_initial_charge_id: null,
    payjp_plan_id: 'plan-001',
    subscription_status: null,
    first_trial_granted_at: null,
    initial_charge_paid_at: null,
    cancel_requested_at: null,
    inflight_operation_id: null,
    inflight_operation_type: null,
    inflight_operation_started_at: null,
    inflight_subscribe_plan_id: null,
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

function makeMemberSession(overrides: Partial<MemberSessionRecord> = {}): MemberSessionRecord {
  return {
    id: 'member-session-id',
    member_session_token_hash: 'member-hash',
    member_id: MEMBER_ID,
    expires_at: new Date(NOW.getTime() + 60_000),
    created_at: NOW,
    ...overrides,
  };
}

function makeLinkSession(overrides: Partial<LinkSessionRecord> = {}): LinkSessionRecord {
  return {
    id: 'link-session-id',
    link_session_token_hash: 'link-hash',
    discord_user_id: DISCORD_USER_ID,
    discord_access_token_encrypted: null,
    expires_at: new Date(NOW.getTime() + 60_000),
    used_at: null,
    created_at: NOW,
    ...overrides,
  };
}

function makeCancelFormToken(overrides: Partial<CancelFormTokenRecord> = {}): CancelFormTokenRecord {
  return {
    id: '00000000-0000-0000-0000-000000000777',
    member_id: MEMBER_ID,
    email: 'test@example.com',
    expires_at: new Date(NOW.getTime() + 60_000),
    used_at: null,
    created_at: NOW,
    ...overrides,
  };
}

function makeConfig(): BillingConfig {
  return {
    frontendBaseUrl: FRONTEND_BASE_URL,
    allowedPlanIds: ['plan-001'],
    discordGuildId: 'guild-001',
    planRoleMapping: { 'plan-001': 'role-001' },
    planInitialChargeAmounts: { 'plan-001': 1000 },
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

function makeDeps(opts?: { config?: Partial<BillingConfig>; db?: Partial<DbClient> }): BillingDeps {
  const member = makeMember();
  const linkSession = makeLinkSession();
  const baseDb: DbClient = {
    findMemberByDiscordUserId: vi.fn().mockResolvedValue(member),
    findMemberById: vi.fn().mockImplementation(async (id: string) => (id === MEMBER_ID ? member : null)),
    upsertProvisionalMember: vi.fn(),
    upsertProvisionalMemberByEmail: vi.fn(),
    updateMemberDiscordUserId: vi.fn().mockResolvedValue(member),
    findLinkSession: vi.fn().mockResolvedValue(linkSession),
    consumeLinkSession: vi.fn().mockResolvedValue(undefined),
    insertCancelFormToken: vi.fn().mockResolvedValue(makeCancelFormToken()),
    findCancelFormToken: vi.fn().mockResolvedValue(makeCancelFormToken()),
    consumeCancelFormToken: vi.fn().mockResolvedValue(undefined),
    insertMemberSession: vi.fn(),
    findMemberSession: vi.fn().mockResolvedValue(makeMemberSession()),
    insertAccessGateSession: vi.fn().mockResolvedValue(undefined),
    findAccessGateSessionByTokenHash: vi.fn().mockResolvedValue(false),
    setInflightOperation: vi.fn(),
    clearInflightOperation: vi.fn(),
    updateMemberCustomerId: vi.fn(),
    updateMemberChargeId: vi.fn(),
    updateMemberAfterSubscribe: vi.fn(),
    updateMemberAfterCancel: vi.fn(),
    updateMemberRoleState: vi.fn().mockResolvedValue(undefined),
    clearMemberDiscordUserId: vi.fn().mockResolvedValue(undefined),
    acquireAdvisoryLock: vi.fn().mockResolvedValue(true),
    releaseAdvisoryLock: vi.fn().mockResolvedValue(undefined),
    withTransactionLock: vi.fn(),
  };
  const db = { ...baseDb, ...opts?.db } as DbClient;

  const payjp: PayjpClient = {
    fetchToken: vi.fn(),
    createCustomer: vi.fn(),
    createCharge: vi.fn(),
    createSubscription: vi.fn(),
    cancelSubscription: vi.fn(),
    fetchCustomer: vi.fn(),
    fetchCharge: vi.fn(),
    fetchSubscription: vi.fn(),
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
    config: { ...makeConfig(), ...opts?.config },
    clock: () => NOW,
    generateOperationId: () => 'op-gate-001',
  };
}

describe('GET /v1/access-gate/session', () => {
  it('returns gateEnforced false when SUBSCRIBE_GATE_CODE is not configured', async () => {
    const deps = makeDeps();
    const app = buildApp(APP_CONFIG, deps);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/access-gate/session',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ gateEnforced: false, unlocked: true });
  });

  it('returns unlocked false when enforced and cookie missing', async () => {
    const deps = makeDeps({ config: { subscribeGateCode: GATE_CODE } });
    const app = buildApp(APP_CONFIG, deps);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/access-gate/session',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ gateEnforced: true, unlocked: false });
  });

  it('returns unlocked true when enforced and access gate session is valid', async () => {
    const raw = 'raw-access-gate-token';
    const deps = makeDeps({
      config: { subscribeGateCode: GATE_CODE },
      db: {
        findAccessGateSessionByTokenHash: vi
          .fn()
          .mockImplementation((h: string) => Promise.resolve(h === accessGateSessionTokenHash(raw))),
      },
    });
    const app = buildApp(APP_CONFIG, deps);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/access-gate/session',
      cookies: { '__Host-access_gate': raw },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ gateEnforced: true, unlocked: true });
  });
});

describe('POST /v1/access-gate/verify', () => {
  it('returns 404 when gate code is not configured', async () => {
    const deps = makeDeps();
    const app = buildApp(APP_CONFIG, deps);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/access-gate/verify',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ passcode: 'anything' }),
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 403 on wrong passcode', async () => {
    const deps = makeDeps({ config: { subscribeGateCode: GATE_CODE } });
    const app = buildApp(APP_CONFIG, deps);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/access-gate/verify',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ passcode: 'wrong-code' }),
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { errorCode?: string }).errorCode).toBe('INVALID_GATE_PASSCODE');
  });

  it('returns 403 on cross-origin request', async () => {
    const deps = makeDeps({ config: { subscribeGateCode: GATE_CODE } });
    const app = buildApp(APP_CONFIG, deps);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/access-gate/verify',
      headers: { 'content-type': 'application/json', origin: 'https://evil.com' },
      body: JSON.stringify({ passcode: GATE_CODE }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 403 when Sec-Fetch-Site is cross-site', async () => {
    const deps = makeDeps({ config: { subscribeGateCode: GATE_CODE } });
    const app = buildApp(APP_CONFIG, deps);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/access-gate/verify',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
      body: JSON.stringify({ passcode: GATE_CODE }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('accepts passcode with surrounding whitespace after trim', async () => {
    const deps = makeDeps({ config: { subscribeGateCode: GATE_CODE } });
    const app = buildApp(APP_CONFIG, deps);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/access-gate/verify',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ passcode: `  ${GATE_CODE}  ` }),
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns 200, sets cookie, and inserts access gate session on success', async () => {
    const insertAccessGateSession = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      config: { subscribeGateCode: GATE_CODE },
      db: { insertAccessGateSession },
    });
    const app = buildApp(APP_CONFIG, deps);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/access-gate/verify',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ passcode: GATE_CODE }),
    });
    expect(res.statusCode).toBe(200);
    expect(insertAccessGateSession).toHaveBeenCalledTimes(1);
    const setCookie = res.headers['set-cookie'] as string;
    expect(String(setCookie)).toContain('__Host-access_gate=');
  });

  it('returns 503 + DB_ERROR when access gate session insert fails', async () => {
    const deps = makeDeps({
      config: { subscribeGateCode: GATE_CODE },
      db: { insertAccessGateSession: vi.fn().mockRejectedValue(new Error('db unavailable')) },
    });
    const app = buildApp(APP_CONFIG, deps);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/access-gate/verify',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ passcode: GATE_CODE }),
    });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { errorCode?: string }).errorCode).toBe('DB_ERROR');
  });
});

describe('GET /v1/invites/accept (legacy)', () => {
  it('redirects to frontend root with gate=renewed', async () => {
    const deps = makeDeps();
    const app = buildApp(APP_CONFIG, deps);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/invites/accept?token=ignored',
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://example.com/?gate=renewed');
  });
});
