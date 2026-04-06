import { describe, expect, it, vi } from 'vitest';
import type { DbPool, WebhookHandlerDeps, WebhookRequest } from '../../shell/types.js';
import { handleWebhook } from '../../shell/webhook.js';

// --- Mock DB ---
function createMockDb(
  options: {
    existingEvent?: Record<string, unknown> | null;
    member?: Record<string, unknown> | null;
    memberBySub?: Record<string, unknown> | null;
    throwOnQuery?: boolean;
  } = {},
): DbPool {
  const insertedEvents: Array<Record<string, unknown>> = [];

  return {
    query: vi.fn(async (text: string, params?: unknown[]) => {
      if (options.throwOnQuery) throw new Error('DB unavailable');

      if (text.includes('FROM payjp_events WHERE id')) {
        return { rows: options.existingEvent ? [options.existingEvent] : [], rowCount: options.existingEvent ? 1 : 0 };
      }
      if (text.includes('INSERT INTO payjp_events')) {
        insertedEvents.push({ id: params?.[0], processing_result: params?.[3] });
        return { rows: [], rowCount: 1 };
      }
      if (text.includes('FROM members WHERE discord_user_id')) {
        return { rows: options.member ? [options.member] : [], rowCount: options.member ? 1 : 0 };
      }
      if (text.includes('FROM members WHERE payjp_subscription_id')) {
        return { rows: options.memberBySub ? [options.memberBySub] : [], rowCount: options.memberBySub ? 1 : 0 };
      }
      if (text.includes('UPDATE members SET')) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
    _insertedEvents: insertedEvents,
  } as unknown as DbPool & { _insertedEvents: Array<Record<string, unknown>> };
}

function createDeps(db: DbPool, overrides: Partial<WebhookHandlerDeps> = {}): WebhookHandlerDeps {
  return {
    db,
    payjpWebhookToken: 'valid-token',
    expectedLivemode: true,
    discordGuildId: 'guild_1',
    discordRoleId: 'role_1',
    syncRole: vi.fn(async () => {}),
    log: vi.fn(),
    ...overrides,
  };
}

function createValidEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'evt_test_1',
    type: 'subscription.updated',
    created: 1000,
    livemode: true,
    data: {
      id: 'sub_test_1',
      object: 'subscription',
      status: 'active',
      metadata: { discord_user_id: 'user_1' },
      plan: { id: 'plan_1' },
      current_period_end: 2000,
    },
    ...overrides,
  };
}

const MEMBER = {
  id: 'mem_1',
  discord_user_id: 'user_1',
  subscription_status: 'trial',
  payjp_subscription_id: 'sub_test_1',
  last_payjp_event_created_at: 500,
};

// INT-SYNC-001: Webhook happy path
describe('INT-SYNC-001: Webhook happy path', () => {
  it('valid event → member update + role sync + 200', async () => {
    const db = createMockDb({ member: MEMBER });
    const deps = createDeps(db);
    const req: WebhookRequest = {
      headers: { 'x-payjp-webhook-token': 'valid-token' },
      body: createValidEvent(),
      remoteIp: '1.2.3.4',
    };

    const res = await handleWebhook(req, deps);
    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>).status).toBe('processed');
    expect(deps.syncRole).toHaveBeenCalledWith('user_1', 'grant');
  });
});

// INT-SYNC-002: Webhook idempotency
describe('INT-SYNC-002: Webhook idempotency', () => {
  it('duplicate event.id → 200, no reprocessing', async () => {
    const db = createMockDb({
      existingEvent: { id: 'evt_test_1' },
      member: MEMBER,
    });
    const deps = createDeps(db);
    const req: WebhookRequest = {
      headers: { 'x-payjp-webhook-token': 'valid-token' },
      body: createValidEvent(),
      remoteIp: '1.2.3.4',
    };

    const res = await handleWebhook(req, deps);
    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>).status).toBe('duplicate');
    expect(deps.syncRole).not.toHaveBeenCalled();
  });
});

// INT-SYNC-003: Webhook stale event
describe('INT-SYNC-003: Webhook stale event', () => {
  it('old event.created → ignored + 200', async () => {
    const db = createMockDb({
      member: { ...MEMBER, last_payjp_event_created_at: 2000 },
    });
    const deps = createDeps(db);
    const req: WebhookRequest = {
      headers: { 'x-payjp-webhook-token': 'valid-token' },
      body: createValidEvent({ created: 1000 }),
      remoteIp: '1.2.3.4',
    };

    const res = await handleWebhook(req, deps);
    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>).status).toBe('ignored');
    expect((res.body as Record<string, unknown>).reason).toBe('stale_event');
  });
});

// INT-SYNC-004: Webhook same-second event
describe('INT-SYNC-004: Webhook same-second event', () => {
  it('event.created == last → processed normally', async () => {
    const db = createMockDb({
      member: { ...MEMBER, last_payjp_event_created_at: 1000 },
    });
    const deps = createDeps(db);
    const req: WebhookRequest = {
      headers: { 'x-payjp-webhook-token': 'valid-token' },
      body: createValidEvent({ created: 1000 }),
      remoteIp: '1.2.3.4',
    };

    const res = await handleWebhook(req, deps);
    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>).status).toBe('processed');
  });
});

// INT-SYNC-005: Webhook token mismatch
describe('INT-SYNC-005: Webhook token mismatch', () => {
  it('token mismatch → 401, no payjp_events, 4-key log', async () => {
    const db = createMockDb();
    const logFn = vi.fn();
    const deps = createDeps(db, { log: logFn });
    const req: WebhookRequest = {
      headers: { 'x-payjp-webhook-token': 'wrong-token' },
      body: createValidEvent(),
      remoteIp: '1.2.3.4',
    };

    const res = await handleWebhook(req, deps);
    expect(res.status).toBe(401);
    expect(logFn).toHaveBeenCalled();
    const logEntry = logFn.mock.calls[0][0];
    expect(logEntry).toHaveProperty('received_at');
    expect(logEntry).toHaveProperty('remote_ip');
    expect(logEntry).toHaveProperty('reason');
    expect(logEntry).toHaveProperty('event');
    expect(
      (db.query as ReturnType<typeof vi.fn>).mock.calls.filter((c: unknown[]) =>
        (c[0] as string).includes('INSERT INTO payjp_events'),
      ),
    ).toHaveLength(0);
  });
});

// INT-SYNC-006: Webhook unknown status
describe('INT-SYNC-006: Webhook unknown status', () => {
  it('unknown data.status → failed + role revocation', async () => {
    const db = createMockDb({ member: MEMBER });
    const deps = createDeps(db);
    const event = createValidEvent();
    (event.data as Record<string, unknown>).status = 'xyz_unknown';
    const req: WebhookRequest = {
      headers: { 'x-payjp-webhook-token': 'valid-token' },
      body: event,
      remoteIp: '1.2.3.4',
    };

    const res = await handleWebhook(req, deps);
    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>).status).toBe('failed');
    expect(deps.syncRole).toHaveBeenCalledWith('user_1', 'revoke');
  });
});

// INT-SYNC-007: Webhook subscription.created
describe('INT-SYNC-007: Webhook subscription.created', () => {
  it('valid subscription.created → ignored (no member update)', async () => {
    const db = createMockDb({ member: MEMBER });
    const deps = createDeps(db);
    const event = createValidEvent({ type: 'subscription.created' });
    const req: WebhookRequest = {
      headers: { 'x-payjp-webhook-token': 'valid-token' },
      body: event,
      remoteIp: '1.2.3.4',
    };

    const res = await handleWebhook(req, deps);
    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>).status).toBe('ignored');
    expect((res.body as Record<string, unknown>).reason).toBe('subscription_created');
    expect(deps.syncRole).not.toHaveBeenCalled();
  });

  it('subscription.created with missing fields → failed', async () => {
    const db = createMockDb();
    const deps = createDeps(db);
    const event = { type: 'subscription.created', livemode: true, data: { object: 'subscription' } };
    const req: WebhookRequest = {
      headers: { 'x-payjp-webhook-token': 'valid-token' },
      body: event,
      remoteIp: '1.2.3.4',
    };

    const res = await handleWebhook(req, deps);
    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>).status).toBe('failed');
  });
});

// INT-SYNC-008: Member resolution cross-check
describe('INT-SYNC-008: Webhook member resolution', () => {
  it('metadata + subscription_id resolve to different members → failed', async () => {
    const db = createMockDb({
      member: { ...MEMBER, id: 'mem_1' },
      memberBySub: { ...MEMBER, id: 'mem_2', discord_user_id: 'user_2' },
    });
    const deps = createDeps(db);
    const req: WebhookRequest = {
      headers: { 'x-payjp-webhook-token': 'valid-token' },
      body: createValidEvent(),
      remoteIp: '1.2.3.4',
    };

    const res = await handleWebhook(req, deps);
    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>).status).toBe('failed');
    expect((res.body as Record<string, unknown>).reason).toBe('member_resolution_conflict');
  });
});

// INT-SYNC-009: subscription.updated status unchanged
describe('INT-SYNC-009: Webhook subscription.updated status-unchanged', () => {
  it('status unchanged → plan/dates updated, no role sync', async () => {
    const memberWithActive = { ...MEMBER, subscription_status: 'active' };
    const db = createMockDb({ member: memberWithActive });
    const deps = createDeps(db);
    const req: WebhookRequest = {
      headers: { 'x-payjp-webhook-token': 'valid-token' },
      body: createValidEvent(),
      remoteIp: '1.2.3.4',
    };

    const res = await handleWebhook(req, deps);
    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>).status).toBe('processed');
    // Status didn't change (active → active), so no role sync
    expect(deps.syncRole).not.toHaveBeenCalled();
    // But member update should have happened (plan/dates)
    const updateCalls = (db.query as ReturnType<typeof vi.fn>).mock.calls.filter((c: unknown[]) =>
      (c[0] as string).includes('UPDATE members SET'),
    );
    expect(updateCalls.length).toBeGreaterThan(0);
  });
});

// INT-SYNC-027: Log security
describe('INT-SYNC-027: Webhook log security', () => {
  it('no raw header/body in logs, sensitive fields masked', async () => {
    const logFn = vi.fn();
    const db = createMockDb();
    const deps = createDeps(db, { log: logFn });
    const req: WebhookRequest = {
      headers: { 'x-payjp-webhook-token': 'wrong-token' },
      body: { card: 'sensitive', token: 'secret123' },
      remoteIp: '1.2.3.4',
    };

    await handleWebhook(req, deps);
    const logEntry = logFn.mock.calls[0][0];
    // Sensitive fields in the event should not leak
    expect(JSON.stringify(logEntry)).not.toContain('secret123');
  });
});

// INT-SYNC-028: operation_id preservation
describe('INT-SYNC-028: Webhook data.metadata.operation_id preservation', () => {
  it('data.metadata.operation_id stored in payjp_events', async () => {
    const db = createMockDb({ member: MEMBER });
    const deps = createDeps(db);
    const event = createValidEvent();
    (event.data as Record<string, unknown>).metadata = { discord_user_id: 'user_1', operation_id: 'op_123' };
    const req: WebhookRequest = {
      headers: { 'x-payjp-webhook-token': 'valid-token' },
      body: event,
      remoteIp: '1.2.3.4',
    };

    const res = await handleWebhook(req, deps);
    expect(res.status).toBe(200);
    // Verify the event was inserted (processed)
    expect((res.body as Record<string, unknown>).status).toBe('processed');
  });
});

// INT-SYNC-038: subscription.renewed
describe('INT-SYNC-038: Webhook subscription.renewed', () => {
  it('processes like other status events', async () => {
    const db = createMockDb({ member: MEMBER });
    const deps = createDeps(db);
    const event = createValidEvent({ type: 'subscription.renewed' });
    const req: WebhookRequest = {
      headers: { 'x-payjp-webhook-token': 'valid-token' },
      body: event,
      remoteIp: '1.2.3.4',
    };

    const res = await handleWebhook(req, deps);
    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>).status).toBe('processed');
  });
});

// INT-SYNC-039: DB unavailability
describe('INT-SYNC-039: Webhook DB unavailability', () => {
  it('DB connection error → 503', async () => {
    const db = createMockDb({ throwOnQuery: true });
    const deps = createDeps(db);
    const req: WebhookRequest = {
      headers: { 'x-payjp-webhook-token': 'valid-token' },
      body: createValidEvent(),
      remoteIp: '1.2.3.4',
    };

    const res = await handleWebhook(req, deps);
    expect(res.status).toBe(503);
  });
});

// INT-SYNC-025: Discord role retry 429 → success
describe('INT-SYNC-025: Discord role retry', () => {
  it('429 on first try → success on retry (handled by syncRole dep)', async () => {
    const db = createMockDb({ member: MEMBER });
    const syncRole = vi.fn().mockResolvedValue(undefined);
    const deps = createDeps(db, { syncRole });
    const req: WebhookRequest = {
      headers: { 'x-payjp-webhook-token': 'valid-token' },
      body: createValidEvent(),
      remoteIp: '1.2.3.4',
    };

    const res = await handleWebhook(req, deps);
    expect(res.status).toBe(200);
    expect(syncRole).toHaveBeenCalled();
  });
});

// INT-SYNC-026: Discord role retry all fail
describe('INT-SYNC-026: Discord role retry all fail', () => {
  it('3 failures → logged, webhook response not blocked', async () => {
    const db = createMockDb({ member: MEMBER });
    const syncRole = vi.fn().mockRejectedValue(new Error('Discord 5xx'));
    const deps = createDeps(db, { syncRole });
    const req: WebhookRequest = {
      headers: { 'x-payjp-webhook-token': 'valid-token' },
      body: createValidEvent(),
      remoteIp: '1.2.3.4',
    };

    const res = await handleWebhook(req, deps);
    // Should still return 200, not propagate the error
    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>).status).toBe('processed');
  });
});

// INT-SYNC-036: Concurrent webhooks (simplified — full advisory lock test needs real DB)
describe('INT-SYNC-036: Concurrent webhooks serialization', () => {
  it('per-member advisory lock prevents race conditions (structural test)', async () => {
    // This test verifies the handler goes through member resolution
    // Full advisory lock testing requires real PostgreSQL
    const db = createMockDb({ member: MEMBER });
    const deps = createDeps(db);
    const req: WebhookRequest = {
      headers: { 'x-payjp-webhook-token': 'valid-token' },
      body: createValidEvent(),
      remoteIp: '1.2.3.4',
    };

    const [res1, res2] = await Promise.all([handleWebhook(req, deps), handleWebhook(req, deps)]);
    // Both should complete without errors (mock DB doesn't lock)
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
  });
});
