import { createInMemoryAuthDb } from '@hayane/auth-service/test-utils';
import type { BillingConfig, BillingDeps, DbClient, DiscordClient, PayjpClient } from '@hayane/billing-service';
import { linkSessionTokenHash } from '@hayane/billing-service';
import type { Member } from '@hayane/shared';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import type { SyncDeps } from '../routes/sync.routes.js';

const NOW = new Date('2025-04-01T10:00:00Z');
const FRONTEND_BASE_URL = 'https://example.com';
const LINK_SESSION_TOKEN = 'link-session-token-rl';
const PLAN_ID = 'plan-rl-001';

const APP_CONFIG = {
  frontendBaseUrl: FRONTEND_BASE_URL,
  discordClientId: 'test-client-id',
  discordClientSecret: 'test-client-secret',
  discordRedirectUri: 'https://api.example.com/v1/auth/discord/callback',
  db: createInMemoryAuthDb(),
};

function makeMember(overrides: Partial<Member> = {}): Member {
  return {
    id: 'member-rl-001',
    discord_user_id: 'discord-rl-001',
    email: 'rl@example.com',
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

function makeMockDeps(): BillingDeps {
  const member = makeMember();
  const db: DbClient = {
    findMemberByDiscordUserId: vi.fn().mockResolvedValue(member),
    findMemberById: vi.fn().mockResolvedValue(member),
    upsertProvisionalMember: vi.fn().mockResolvedValue(member),
    upsertProvisionalMemberByEmail: vi.fn().mockResolvedValue(member),
    updateMemberDiscordUserId: vi.fn().mockResolvedValue(member),
    findLinkSession: vi.fn().mockImplementation((h: string) =>
      Promise.resolve(
        h === linkSessionTokenHash(LINK_SESSION_TOKEN)
          ? {
              id: 'ls-1',
              link_session_token_hash: h,
              discord_user_id: 'discord-rl-001',
              discord_access_token_encrypted: null,
              expires_at: new Date(NOW.getTime() + 3600_000),
              used_at: null,
              created_at: NOW,
            }
          : null,
      ),
    ),
    consumeLinkSession: vi.fn().mockResolvedValue(undefined),
    insertCancelFormToken: vi.fn().mockResolvedValue(undefined),
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
    updateMemberAfterSubscribe: vi.fn().mockResolvedValue(member),
    updateMemberAfterCancel: vi.fn().mockResolvedValue(undefined as never),
    updateMemberRoleState: vi.fn().mockResolvedValue(undefined),
    clearMemberDiscordUserId: vi.fn().mockResolvedValue(undefined),
    acquireAdvisoryLock: vi.fn().mockResolvedValue(true),
    releaseAdvisoryLock: vi.fn().mockResolvedValue(undefined),
    withTransactionLock: vi.fn().mockImplementation((_key: string, fn: (txDb: unknown) => Promise<unknown>) => fn({})),
  };

  const payjp: PayjpClient = {
    fetchToken: vi.fn().mockResolvedValue({
      id: 'tok_rl',
      used: false,
      three_d_secure_status: 'verified',
      card: { id: 'card-rl' },
    }),
    createCustomer: vi.fn().mockResolvedValue({ id: 'cus_rl', metadata: {} }),
    createCharge: vi.fn().mockResolvedValue({ id: 'ch_rl', amount: 1000, paid: true, metadata: {} }),
    createSubscription: vi.fn().mockResolvedValue({
      id: 'sub_rl',
      status: 'trial',
      current_period_end: Math.floor(NOW.getTime() / 1000) + 30 * 86400,
      trial_end: Math.floor(NOW.getTime() / 1000) + 30 * 86400,
      plan: { id: PLAN_ID, interval: 'month' },
      metadata: {},
    }),
    cancelSubscription: vi.fn().mockResolvedValue(undefined as never),
    fetchCustomer: vi.fn().mockResolvedValue({ id: 'cus_rl', metadata: {} }),
    fetchCharge: vi.fn().mockResolvedValue({ id: 'ch_rl', amount: 1000, paid: true, metadata: {} }),
    fetchSubscription: vi.fn().mockResolvedValue({
      id: 'sub_rl',
      status: 'trial',
      current_period_end: Math.floor(NOW.getTime() / 1000) + 30 * 86400,
      trial_end: Math.floor(NOW.getTime() / 1000) + 30 * 86400,
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

  const config: BillingConfig = {
    frontendBaseUrl: FRONTEND_BASE_URL,
    allowedPlanIds: [PLAN_ID],
    discordGuildId: 'guild-rl',
    planRoleMapping: { [PLAN_ID]: 'role-rl' },
    planInitialChargeAmounts: { [PLAN_ID]: 1000 },
    initialChargeAmount: 1000,
    initialChargeAmountCurrency: 'jpy',
    googleFormCancelBaseUrl: 'https://docs.google.com/forms/d/e/rl/viewform',
    googleFormCancelEmailEntryId: '111',
    googleFormCancelTokenEntryId: '222',
    googleFormCancelSecret: 'rl-secret',
    googleFormCancelTokenSecret: 'rl-token-secret',
    googleFormCancelTokenTtlSeconds: 900,
    accessGateSessionTtlSeconds: 86400,
  };

  return { db, payjp, discord, config, clock: () => NOW, generateOperationId: () => 'op-rl-001' };
}

function makeSyncDeps(): SyncDeps {
  return {
    webhookDeps: {
      payjpWebhookToken: 'test-webhook-token',
      db: {} as never,
      syncRole: vi.fn().mockResolvedValue(undefined),
      expectedLivemode: true,
      discordGuildId: 'guild-rl',
      planRoleMapping: { [PLAN_ID]: 'role-rl' },
      log: vi.fn(),
    },
  };
}

describe('rate limit enforcement', () => {
  it('uses X-Forwarded-For for per-client keys when trustProxy is on (distinct clients are not pooled)', async () => {
    const deps = makeMockDeps();
    const syncDeps = makeSyncDeps();
    const app = buildApp(APP_CONFIG, deps, syncDeps);
    const url = '/v1/subscriptions/status';
    const max = 15;

    const headersBase: Record<string, string> = {
      origin: FRONTEND_BASE_URL,
      'content-type': 'application/json',
    };
    const cookies: Record<string, string> = { '__Host-link_session': LINK_SESSION_TOKEN };

    // Exhaust client A's budget
    for (let i = 0; i < max; i++) {
      const res = await app.inject({
        method: 'GET',
        url,
        headers: { ...headersBase, 'x-forwarded-for': '203.0.113.10' },
        cookies,
      });
      expect(res.statusCode).not.toBe(429);
    }
    const aExceeded = await app.inject({
      method: 'GET',
      url,
      headers: { ...headersBase, 'x-forwarded-for': '203.0.113.10' },
      cookies,
    });
    expect(aExceeded.statusCode).toBe(429);

    // Client B should still be allowed (not sharing the proxy-only bucket)
    const bFirst = await app.inject({
      method: 'GET',
      url,
      headers: { ...headersBase, 'x-forwarded-for': '203.0.113.20' },
      cookies,
    });
    expect(bFirst.statusCode).not.toBe(429);
  });

  const RATE_LIMIT_CASES: { method: 'GET' | 'POST'; url: string; max: number }[] = [
    { method: 'POST', url: '/v1/subscriptions', max: 5 },
    { method: 'POST', url: '/v1/subscriptions/cancel', max: 5 },
    { method: 'POST', url: '/v1/subscriptions/cancel/google-form-link', max: 5 },
    { method: 'POST', url: '/v1/subscriptions/cancel/google-submit', max: 10 },
    { method: 'GET', url: '/v1/subscriptions/status', max: 15 },
    { method: 'GET', url: '/v1/members/me', max: 15 },
    { method: 'POST', url: '/v1/members/link-discord', max: 5 },
    { method: 'GET', url: '/v1/auth/discord/start', max: 10 },
    { method: 'GET', url: '/v1/auth/discord/callback', max: 10 },
    { method: 'GET', url: '/v1/auth/discord/session', max: 15 },
    { method: 'POST', url: '/v1/access-gate/verify', max: 5 },
    { method: 'POST', url: '/v1/payjp/webhook', max: 100 },
  ];

  it.each(RATE_LIMIT_CASES)('$method $url → 429 after $max requests', async ({ method, url, max }) => {
    const deps = makeMockDeps();
    const syncDeps = makeSyncDeps();
    const app = buildApp(APP_CONFIG, deps, syncDeps);

    const headers: Record<string, string> = {
      origin: FRONTEND_BASE_URL,
      'content-type': 'application/json',
    };
    const cookies: Record<string, string> = { '__Host-link_session': LINK_SESSION_TOKEN };

    const statusCodes: number[] = [];
    for (let i = 0; i < max + 1; i++) {
      const res = await app.inject({
        method,
        url,
        headers,
        cookies,
        payload: method === 'POST' ? {} : undefined,
      });
      statusCodes.push(res.statusCode);
    }

    const lastCode = statusCodes[max];
    expect(lastCode).toBe(429);
  });
});
