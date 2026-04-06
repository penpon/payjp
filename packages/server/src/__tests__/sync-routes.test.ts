import type { DbPool } from '@hayane/shared';
import type { WebhookHandlerDeps } from '@hayane/sync-service';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import type { SyncDeps } from '../routes/sync.routes.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WEBHOOK_TOKEN = 'whsec_test_token_12345';
const WEBHOOK_URL = '/v1/payjp/webhook';
const FRONTEND_BASE_URL = 'https://example.com';
const EVENT_ID = 'evnt_test_001';
const MEMBER_ID = 'member-uuid-001';
const DISCORD_USER_ID = 'discord-user-001';
const SUBSCRIPTION_ID = 'sub_test_001';
const NOW_UNIX = Math.floor(new Date('2025-04-01T10:00:00Z').getTime() / 1000);

const APP_CONFIG = {
  frontendBaseUrl: FRONTEND_BASE_URL,
  discordClientId: 'test-client-id',
  discordClientSecret: 'test-client-secret',
  discordRedirectUri: 'https://api.example.com/v1/auth/discord/callback',
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEvent(overrides: Record<string, unknown> = {}) {
  const { data: dataOverrides, ...topOverrides } = overrides;
  return {
    id: EVENT_ID,
    type: 'subscription.updated',
    livemode: true,
    created: NOW_UNIX,
    data: {
      id: SUBSCRIPTION_ID,
      object: 'subscription',
      status: 'active',
      metadata: { discord_user_id: DISCORD_USER_ID },
      plan: { id: 'plan-001' },
      current_period_end: NOW_UNIX + 30 * 86400,
      ...((dataOverrides as Record<string, unknown>) ?? {}),
    },
    ...topOverrides,
  };
}

function makeMember(overrides: Record<string, unknown> = {}) {
  return {
    id: MEMBER_ID,
    discord_user_id: DISCORD_USER_ID,
    subscription_status: 'active',
    last_payjp_event_created_at: NOW_UNIX - 100,
    payjp_subscription_id: SUBSCRIPTION_ID,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock DB
// ---------------------------------------------------------------------------

function makeMockDb(
  options: {
    findEventResult?: Record<string, unknown> | null;
    findMemberResult?: Record<string, unknown> | null;
    shouldThrow?: boolean;
  } = {},
): DbPool {
  const { findEventResult = null, findMemberResult = makeMember(), shouldThrow = false } = options;

  return {
    query: vi.fn().mockImplementation((sql: string, _params?: unknown[]) => {
      if (shouldThrow) throw new Error('DB connection failed');

      // pg_advisory_xact_lock
      if (sql.includes('pg_advisory_xact_lock')) {
        return { rows: [], rowCount: 0 };
      }
      // Duplicate check
      if (sql.includes('FROM payjp_events WHERE id')) {
        return { rows: findEventResult ? [findEventResult] : [], rowCount: findEventResult ? 1 : 0 };
      }
      // Member by discord_user_id
      if (sql.includes('FROM members WHERE discord_user_id')) {
        return { rows: findMemberResult ? [findMemberResult] : [], rowCount: findMemberResult ? 1 : 0 };
      }
      // Member by subscription_id
      if (sql.includes('FROM members WHERE payjp_subscription_id')) {
        return { rows: findMemberResult ? [findMemberResult] : [], rowCount: findMemberResult ? 1 : 0 };
      }
      // INSERT/UPDATE
      return { rows: [], rowCount: 1 };
    }),
  };
}

// ---------------------------------------------------------------------------
// Mock deps factory
// ---------------------------------------------------------------------------

function makeSyncDeps(dbOverrides: Parameters<typeof makeMockDb>[0] = {}): SyncDeps {
  const webhookDeps: WebhookHandlerDeps = {
    db: makeMockDb(dbOverrides),
    payjpWebhookToken: WEBHOOK_TOKEN,
    expectedLivemode: true,
    discordGuildId: 'guild-001',
    discordRoleId: 'role-001',
    syncRole: vi.fn().mockResolvedValue(undefined),
    log: vi.fn(),
  };
  return { webhookDeps };
}

function createApp(syncDeps?: SyncDeps) {
  return buildApp(APP_CONFIG, undefined, syncDeps ?? makeSyncDeps());
}

function webhookInject(body: Record<string, unknown>, token?: string) {
  return {
    method: 'POST' as const,
    url: WEBHOOK_URL,
    headers: {
      'content-type': 'application/json',
      ...(token !== undefined ? { 'x-payjp-webhook-token': token } : {}),
    },
    payload: body,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /v1/payjp/webhook', () => {
  it('returns 401 when token is missing', async () => {
    const app = createApp();
    const res = await app.inject(webhookInject(makeEvent()));

    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('Unauthorized');
  });

  it('returns 401 when token does not match', async () => {
    const app = createApp();
    const res = await app.inject(webhookInject(makeEvent(), 'wrong-token'));

    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('Unauthorized');
  });

  it('returns 200 with status=processed on valid event', async () => {
    const app = createApp();
    const res = await app.inject(webhookInject(makeEvent(), WEBHOOK_TOKEN));

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('processed');
  });

  it('returns 200 with status=ignored for non-allowed event type', async () => {
    const app = createApp();
    const event = makeEvent({ type: 'charge.succeeded' });
    const res = await app.inject(webhookInject(event, WEBHOOK_TOKEN));

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ignored');
  });

  it('returns 200 with status=ignored for livemode mismatch', async () => {
    const app = createApp();
    const event = makeEvent({ livemode: false });
    const res = await app.inject(webhookInject(event, WEBHOOK_TOKEN));

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ignored');
  });

  it('returns 200 with status=ignored for non-subscription data.object', async () => {
    const app = createApp();
    const event = makeEvent({ data: { object: 'charge', id: 'ch_1', status: 'active' } });
    const res = await app.inject(webhookInject(event, WEBHOOK_TOKEN));

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ignored');
  });

  it('returns 200 with status=duplicate for already-processed event', async () => {
    const deps = makeSyncDeps({
      findEventResult: {
        id: EVENT_ID,
        event_type: 'subscription.updated',
        processing_result: 'processed',
        received_at: new Date(),
      },
    });
    const app = createApp(deps);
    const res = await app.inject(webhookInject(makeEvent(), WEBHOOK_TOKEN));

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('duplicate');
  });

  it('returns 200 with status=ignored for subscription.created', async () => {
    const app = createApp();
    const event = makeEvent({ type: 'subscription.created' });
    const res = await app.inject(webhookInject(event, WEBHOOK_TOKEN));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ignored', reason: 'subscription_created' });
  });

  it('returns 200 with status=ignored for stale event', async () => {
    const deps = makeSyncDeps({
      findMemberResult: makeMember({ last_payjp_event_created_at: NOW_UNIX + 100 }),
    });
    const app = createApp(deps);
    const res = await app.inject(webhookInject(makeEvent(), WEBHOOK_TOKEN));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ignored', reason: 'stale_event' });
  });

  it('returns 200 with status=failed for unknown status', async () => {
    const deps = makeSyncDeps();
    const app = createApp(deps);
    const event = makeEvent({
      data: {
        id: SUBSCRIPTION_ID,
        object: 'subscription',
        status: 'unknown_xyz',
        metadata: { discord_user_id: DISCORD_USER_ID },
      },
    });
    const res = await app.inject(webhookInject(event, WEBHOOK_TOKEN));

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('failed');
    expect(res.json().reason).toBe('unknown_status');
  });

  it('revokes role on unknown status (safe-side)', async () => {
    const deps = makeSyncDeps();
    const app = createApp(deps);
    const event = makeEvent({
      data: {
        id: SUBSCRIPTION_ID,
        object: 'subscription',
        status: 'unknown_xyz',
        metadata: { discord_user_id: DISCORD_USER_ID },
      },
    });
    await app.inject(webhookInject(event, WEBHOOK_TOKEN));

    expect(deps.webhookDeps.syncRole).toHaveBeenCalledWith(DISCORD_USER_ID, 'revoke');
  });

  it('returns 200 with status=failed when member not found', async () => {
    const deps = makeSyncDeps({ findMemberResult: null });
    const app = createApp(deps);
    const res = await app.inject(webhookInject(makeEvent(), WEBHOOK_TOKEN));

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('failed');
    expect(res.json().reason).toBe('member_not_found');
  });

  it('returns 503 on DB error', async () => {
    const deps = makeSyncDeps({ shouldThrow: true });
    const app = createApp(deps);
    // Token validation is pure (no DB), so it passes. DB error hits at ignore-check insert.
    const event = makeEvent({ livemode: false });
    const res = await app.inject(webhookInject(event, WEBHOOK_TOKEN));

    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('Service Unavailable');
  });

  it('includes security headers', async () => {
    const app = createApp();
    const res = await app.inject(webhookInject(makeEvent(), WEBHOOK_TOKEN));

    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('syncs role on status change', async () => {
    const deps = makeSyncDeps({
      findMemberResult: makeMember({ subscription_status: 'trial' }),
    });
    const app = createApp(deps);
    const event = makeEvent({
      data: {
        id: SUBSCRIPTION_ID,
        object: 'subscription',
        status: 'active',
        metadata: { discord_user_id: DISCORD_USER_ID },
        plan: { id: 'plan-001' },
        current_period_end: NOW_UNIX + 30 * 86400,
      },
    });
    const res = await app.inject(webhookInject(event, WEBHOOK_TOKEN));

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('processed');
  });

  it('returns 200 with status=failed for missing required fields', async () => {
    const app = createApp();
    const event = {
      id: EVENT_ID,
      type: 'subscription.updated',
      livemode: true,
      created: NOW_UNIX,
      data: { object: 'subscription' },
    };
    const res = await app.inject(webhookInject(event, WEBHOOK_TOKEN));

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('failed');
    expect(res.json().reason).toBe('missing_required_fields');
  });
});
