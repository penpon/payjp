import { createInMemoryAuthDb } from '@hayane/auth-service/test-utils';
import type { BillingConfig, BillingDeps, DbClient, DiscordClient, PayjpClient } from '@hayane/billing-service';
import type { CancelFormTokenRecord, LinkSessionRecord, Member, MemberSessionRecord } from '@hayane/shared';
import { encryptToken } from '@hayane/shared';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';

const NOW = new Date('2025-04-01T10:00:00Z');
const FRONTEND_BASE_URL = 'https://example.com';
const MEMBER_ID = 'member-uuid-001';
const DISCORD_USER_ID = 'discord-user-001';
const MEMBER_SESSION_TOKEN = 'member-session-token';
const LINK_SESSION_TOKEN = 'link-session-token';

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

function makeDeps(
  memberOverrides: Partial<Member> = {},
  opts?: { linkSession?: Partial<LinkSessionRecord>; config?: Partial<BillingConfig> },
): BillingDeps {
  const member = makeMember(memberOverrides);
  const linkSession = makeLinkSession(opts?.linkSession ?? {});
  const db: DbClient = {
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
    insertAccessGateSession: vi.fn(),
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
    generateOperationId: () => 'op-001',
  };
}

describe('GET /v1/members/me', () => {
  it('returns member including roleState', async () => {
    const deps = makeDeps({ subscription_status: 'canceled', role_state: 'revoked' });
    const app = buildApp(APP_CONFIG, deps);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/members/me',
      headers: { origin: FRONTEND_BASE_URL },
      cookies: { '__Host-member_session': MEMBER_SESSION_TOKEN },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      member: {
        memberId: MEMBER_ID,
        subscriptionStatus: 'canceled',
        planId: 'plan-001',
        accessEndAt: null,
        discordLinked: true,
        roleState: 'revoked',
      },
    });
  });

  it('treats member_session expiring exactly now as invalid and clears cookie', async () => {
    const deps = makeDeps({ subscription_status: 'active' });
    (deps.db.findMemberSession as ReturnType<typeof vi.fn>).mockResolvedValue(makeMemberSession({ expires_at: NOW }));
    const app = buildApp(APP_CONFIG, deps);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/members/me',
      headers: { origin: FRONTEND_BASE_URL },
      cookies: { '__Host-member_session': MEMBER_SESSION_TOKEN },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ member: null });
    expect(String(res.headers['set-cookie'])).toContain('__Host-member_session=');
  });

  it('returns 403 when Sec-Fetch-Site is cross-site (no Origin)', async () => {
    const deps = makeDeps({ subscription_status: 'active' });
    const app = buildApp(APP_CONFIG, deps);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/members/me',
      headers: { 'sec-fetch-site': 'cross-site' },
      cookies: { '__Host-member_session': MEMBER_SESSION_TOKEN },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'Forbidden' });
  });

  it('allows server-side / same-tab callers without Origin or Sec-Fetch-Site', async () => {
    const deps = makeDeps({ subscription_status: 'active' });
    const app = buildApp(APP_CONFIG, deps);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/members/me',
      cookies: { '__Host-member_session': MEMBER_SESSION_TOKEN },
    });

    expect(res.statusCode).toBe(200);
  });
});

describe('POST /v1/members/link-discord', () => {
  it('returns 403 when Sec-Fetch-Site is cross-site', async () => {
    const deps = makeDeps({ subscription_status: 'active' });
    const app = buildApp(APP_CONFIG, deps);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/members/link-discord',
      headers: { origin: FRONTEND_BASE_URL, 'sec-fetch-site': 'cross-site' },
      cookies: {
        '__Host-member_session': MEMBER_SESSION_TOKEN,
        '__Host-link_session': LINK_SESSION_TOKEN,
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ ok: false, errorCode: 'FORBIDDEN_ORIGIN' });
  });

  it('returns INVALID_MEMBER_SESSION when member_session expires exactly now', async () => {
    const deps = makeDeps({ subscription_status: 'active' });
    (deps.db.findMemberSession as ReturnType<typeof vi.fn>).mockResolvedValue(makeMemberSession({ expires_at: NOW }));
    const app = buildApp(APP_CONFIG, deps);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/members/link-discord',
      headers: { origin: FRONTEND_BASE_URL },
      cookies: {
        '__Host-member_session': MEMBER_SESSION_TOKEN,
        '__Host-link_session': LINK_SESSION_TOKEN,
      },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ ok: false, errorCode: 'INVALID_MEMBER_SESSION' });
  });

  it('returns INVALID_LINK_SESSION when link_session expires exactly now', async () => {
    const deps = makeDeps(
      { subscription_status: 'active' },
      {
        linkSession: { expires_at: NOW },
      },
    );
    const app = buildApp(APP_CONFIG, deps);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/members/link-discord',
      headers: { origin: FRONTEND_BASE_URL },
      cookies: {
        '__Host-member_session': MEMBER_SESSION_TOKEN,
        '__Host-link_session': LINK_SESSION_TOKEN,
      },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ ok: false, errorCode: 'INVALID_LINK_SESSION' });
  });

  it('keeps idempotent short-circuit when already granted', async () => {
    const deps = makeDeps({ role_state: 'granted', subscription_status: 'active' });
    const app = buildApp(APP_CONFIG, deps);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/members/link-discord',
      headers: { origin: FRONTEND_BASE_URL },
      cookies: {
        '__Host-member_session': MEMBER_SESSION_TOKEN,
        '__Host-link_session': LINK_SESSION_TOKEN,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, discordUserId: DISCORD_USER_ID, roleGranted: true });
    expect(deps.db.consumeLinkSession).toHaveBeenCalledTimes(1);
    expect(deps.db.acquireAdvisoryLock).toHaveBeenCalledTimes(1);
    expect(deps.db.acquireAdvisoryLock).toHaveBeenCalledWith(`member-link:${MEMBER_ID}`);
    expect(deps.discord.checkMembership).not.toHaveBeenCalled();
    expect(deps.discord.assignRole).not.toHaveBeenCalled();
    expect(deps.discord.revokeToken).not.toHaveBeenCalled();
  });

  it('idempotent path revokes Discord access token when link session stores encrypted token', async () => {
    const keyHex = 'a'.repeat(64);
    const plainAccess = 'oauth-access-token-for-revoke-test';
    const encrypted = encryptToken(plainAccess, keyHex);
    const deps = makeDeps(
      { role_state: 'granted', subscription_status: 'active' },
      {
        config: { discordTokenEncryptionKey: keyHex },
        linkSession: { discord_access_token_encrypted: encrypted },
      },
    );
    const app = buildApp(APP_CONFIG, deps);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/members/link-discord',
      headers: { origin: FRONTEND_BASE_URL },
      cookies: {
        '__Host-member_session': MEMBER_SESSION_TOKEN,
        '__Host-link_session': LINK_SESSION_TOKEN,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(deps.discord.revokeToken).toHaveBeenCalledWith(plainAccess);
    expect(deps.discord.checkMembership).not.toHaveBeenCalled();
  });

  it('retries role grant on re-link when role_state is unknown', async () => {
    const deps = makeDeps({ role_state: 'unknown', subscription_status: 'active' });
    const app = buildApp(APP_CONFIG, deps);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/members/link-discord',
      headers: { origin: FRONTEND_BASE_URL },
      cookies: {
        '__Host-member_session': MEMBER_SESSION_TOKEN,
        '__Host-link_session': LINK_SESSION_TOKEN,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, discordUserId: DISCORD_USER_ID, roleGranted: true });
    expect(deps.db.acquireAdvisoryLock).toHaveBeenNthCalledWith(1, `member-link:${MEMBER_ID}`);
    expect(deps.db.acquireAdvisoryLock).toHaveBeenNthCalledWith(2, DISCORD_USER_ID);
    expect(deps.discord.checkMembership).toHaveBeenCalledWith('guild-001', DISCORD_USER_ID, 'role-001');
    expect(deps.discord.assignRole).toHaveBeenCalledWith('guild-001', DISCORD_USER_ID, 'role-001');
    expect(deps.db.updateMemberRoleState).toHaveBeenCalledWith(MEMBER_ID, 'granted');
  });

  it('rejects linking when subscription is not active', async () => {
    const deps = makeDeps({ subscription_status: 'deleted' });
    const app = buildApp(APP_CONFIG, deps);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/members/link-discord',
      headers: { origin: FRONTEND_BASE_URL },
      cookies: {
        '__Host-member_session': MEMBER_SESSION_TOKEN,
        '__Host-link_session': LINK_SESSION_TOKEN,
      },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ ok: false, errorCode: 'NO_SUBSCRIPTION' });
    expect(deps.db.updateMemberDiscordUserId).not.toHaveBeenCalled();
    expect(deps.discord.checkMembership).not.toHaveBeenCalled();
  });

  it('rejects linking when subscription is canceled even if access_end_at is in the future', async () => {
    const deps = makeDeps({
      subscription_status: 'canceled',
      access_end_at: new Date('2099-01-01'),
      role_state: 'revoked',
    });
    const app = buildApp(APP_CONFIG, deps);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/members/link-discord',
      headers: { origin: FRONTEND_BASE_URL },
      cookies: {
        '__Host-member_session': MEMBER_SESSION_TOKEN,
        '__Host-link_session': LINK_SESSION_TOKEN,
      },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ ok: false, errorCode: 'NO_SUBSCRIPTION' });
    expect(deps.discord.assignRole).not.toHaveBeenCalled();
  });

  it('returns DISCORD_ALREADY_USED when another active member holds the same Discord ID', async () => {
    const deps = makeDeps({ discord_user_id: null, subscription_status: 'active' });
    const otherMember = makeMember({
      id: 'other-member-001',
      subscription_status: 'active',
      access_end_at: new Date('2099-01-01'),
    });
    (deps.db.findMemberByDiscordUserId as ReturnType<typeof vi.fn>).mockResolvedValue(otherMember);
    const app = buildApp(APP_CONFIG, deps);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/members/link-discord',
      headers: { origin: FRONTEND_BASE_URL },
      cookies: {
        '__Host-member_session': MEMBER_SESSION_TOKEN,
        '__Host-link_session': LINK_SESSION_TOKEN,
      },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ ok: false, errorCode: 'DISCORD_ALREADY_USED' });
    expect(deps.db.clearMemberDiscordUserId).not.toHaveBeenCalled();
    expect(deps.db.updateMemberDiscordUserId).not.toHaveBeenCalled();
  });

  it('clears canceled member Discord link and allows transfer even when access_end_at is in the future', async () => {
    const deps = makeDeps({ discord_user_id: null, subscription_status: 'active' });
    const inactiveMember = makeMember({
      id: 'other-member-001',
      subscription_status: 'canceled',
      access_end_at: new Date('2099-01-01'), // canceled but still within access period
    });
    (deps.db.findMemberByDiscordUserId as ReturnType<typeof vi.fn>).mockResolvedValueOnce(inactiveMember);
    const app = buildApp(APP_CONFIG, deps);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/members/link-discord',
      headers: { origin: FRONTEND_BASE_URL },
      cookies: {
        '__Host-member_session': MEMBER_SESSION_TOKEN,
        '__Host-link_session': LINK_SESSION_TOKEN,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(deps.db.clearMemberDiscordUserId).toHaveBeenCalledWith('other-member-001');
    expect(deps.db.updateMemberDiscordUserId).toHaveBeenCalledWith(MEMBER_ID, DISCORD_USER_ID);
  });
});

// ---------------------------------------------------------------------------
// Discord role assignment retry behavior
// ---------------------------------------------------------------------------

describe('POST /v1/members/link-discord — role assignment retries', () => {
  it('retries assignRole on failure and succeeds on third attempt', async () => {
    const deps = makeDeps({
      discord_user_id: null,
      subscription_status: 'active',
      payjp_plan_id: 'plan-001',
    });
    (deps.discord.assignRole as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('Discord 429'))
      .mockRejectedValueOnce(new Error('Discord 500'))
      .mockResolvedValueOnce(undefined);

    const app = buildApp(APP_CONFIG, deps);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/members/link-discord',
      headers: { origin: FRONTEND_BASE_URL },
      cookies: {
        '__Host-member_session': MEMBER_SESSION_TOKEN,
        '__Host-link_session': LINK_SESSION_TOKEN,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().roleGranted).toBe(true);
    expect(deps.discord.assignRole).toHaveBeenCalledTimes(3);
  }, 10_000);

  it('returns roleGranted=false after all 3 retry attempts fail', async () => {
    const deps = makeDeps({
      discord_user_id: null,
      subscription_status: 'active',
      payjp_plan_id: 'plan-001',
    });
    (deps.discord.assignRole as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('Discord 429'))
      .mockRejectedValueOnce(new Error('Discord 500'))
      .mockRejectedValueOnce(new Error('Discord 503'));

    const app = buildApp(APP_CONFIG, deps);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/members/link-discord',
      headers: { origin: FRONTEND_BASE_URL },
      cookies: {
        '__Host-member_session': MEMBER_SESSION_TOKEN,
        '__Host-link_session': LINK_SESSION_TOKEN,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().roleGranted).toBe(false);
    expect(deps.discord.assignRole).toHaveBeenCalledTimes(3);
  }, 10_000);
});
