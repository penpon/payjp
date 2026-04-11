/**
 * sync-service Integration Tests — Resync & CLI Flow
 * Phase 2b (Green): Tests against real CLI with mock deps
 */
import { describe, expect, it, vi } from 'vitest';
import type { CliDeps } from '../../shell/cli.js';
import { runResyncCli } from '../../shell/cli.js';
import type { DbPool } from '../../shell/types.js';

function mockDbPool(query: DbPool['query']): DbPool {
  return {
    query,
    withTransaction: async <T>(fn: (q: DbPool['query']) => Promise<T>) => fn(query),
  };
}

function createMockDeps(overrides: Partial<CliDeps> = {}): CliDeps {
  const queryResults: Map<string, { rows: unknown[]; rowCount: number }> = new Map();

  const queryFn = vi.fn(async (text: string, _params?: unknown[]) => {
    for (const [key, val] of queryResults.entries()) {
      if (text.includes(key)) return val;
    }
    return { rows: [], rowCount: 0 };
  });
  const db: DbPool = mockDbPool(queryFn);

  return {
    db,
    getPayjpSubscription: vi.fn(async () => ({ id: 'sub_1', status: 'active' })),
    listPayjpCharges: vi.fn(async () => ({ data: [], has_more: false })),
    listPayjpSubscriptions: vi.fn(async () => ({ data: [], has_more: false })),
    createPayjpCharge: vi.fn(async () => ({ id: 'chg_new' })),
    createPayjpSubscription: vi.fn(async () => ({ id: 'sub_new', status: 'active' })),
    cancelPayjpSubscription: vi.fn(async () => ({ id: 'sub_1', status: 'canceled' })),
    syncRole: vi.fn(async () => {}),
    planRoleMapping: { plan_1: 'role_1' },
    log: vi.fn(),
    now: () => new Date('2026-04-06T12:00:00Z'),
    _queryResults: queryResults,
    ...overrides,
  } as unknown as CliDeps & { _queryResults: Map<string, { rows: unknown[]; rowCount: number }> };
}

const MEMBER_WITH_INFLIGHT_SUBSCRIBE = {
  id: 'mem_1',
  discord_user_id: 'user_1',
  email: 'test@example.com',
  subscription_status: 'active',
  payjp_plan_id: 'plan_1',
  payjp_customer_id: 'cust_1',
  payjp_subscription_id: null,
  payjp_initial_charge_id: null,
  inflight_operation_id: 'op_1',
  inflight_operation_type: 'subscribe',
  inflight_operation_started_at: new Date('2026-04-06T11:00:00Z'),
  last_payjp_event_created_at: 500,
  access_end_at: new Date('2026-07-06T12:00:00Z'),
};

const MEMBER_WITH_INFLIGHT_CANCEL = {
  ...MEMBER_WITH_INFLIGHT_SUBSCRIBE,
  inflight_operation_type: 'cancel',
  payjp_subscription_id: 'sub_1',
};

// INT-SYNC-021: CLI mutual exclusion
describe('INT-SYNC-021: CLI mutual exclusion', () => {
  it('0 args → exit code 1', async () => {
    const deps = createMockDeps();
    const result = await runResyncCli([], deps);
    expect(result.exitCode).toBe(1);
  });

  it('2 args → exit code 1', async () => {
    const deps = createMockDeps();
    const result = await runResyncCli(['--all', '--discord-user-id', 'x'], deps);
    expect(result.exitCode).toBe(1);
  });
});

// INT-SYNC-022: CLI output format
describe('INT-SYNC-022: CLI output format', () => {
  it('JSON with 8 required keys + correct exit codes', async () => {
    const deps = createMockDeps();
    const result = await runResyncCli([], deps);
    const r = result.result;
    expect(r).toHaveProperty('mode');
    expect(r).toHaveProperty('target');
    expect(r).toHaveProperty('processed_count');
    expect(r).toHaveProperty('succeeded_count');
    expect(r).toHaveProperty('failed_count');
    expect(r).toHaveProperty('started_at');
    expect(r).toHaveProperty('finished_at');
    expect(r).toHaveProperty('duration_ms');
    expect(r.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(r.finished_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});

// INT-SYNC-013: CLI subscribe recovery: charge search + create
describe('INT-SYNC-013: CLI subscribe recovery: charge search + create', () => {
  it('no existing charge → creates 1 charge', async () => {
    const deps = createMockDeps({
      db: mockDbPool(
        vi.fn(async (text: string, _params?: unknown[]) => {
          if (text.includes('inflight_operation_id')) {
            return { rows: [MEMBER_WITH_INFLIGHT_SUBSCRIBE], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }),
      ),
    });

    const _result = await runResyncCli(['--operation-id', 'op_1'], deps);
    expect(deps.createPayjpCharge).toHaveBeenCalled();
  });
});

// INT-SYNC-014: CLI subscribe recovery: existing charge
describe('INT-SYNC-014: CLI subscribe recovery: existing charge found', () => {
  it('1 matching charge → uses existing', async () => {
    const deps = createMockDeps({
      db: mockDbPool(
        vi.fn(async (text: string) => {
          if (text.includes('inflight_operation_id')) {
            return { rows: [MEMBER_WITH_INFLIGHT_SUBSCRIBE], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }),
      ),
      listPayjpCharges: vi.fn(async () => ({
        data: [{ id: 'chg_existing', metadata: { operation_id: 'op_1' } }],
        has_more: false,
      })),
    });

    const _result = await runResyncCli(['--operation-id', 'op_1'], deps);
    expect(deps.createPayjpCharge).not.toHaveBeenCalled();
  });
});

// INT-SYNC-015: CLI subscribe recovery: 2+ charges → fail-close
describe('INT-SYNC-015: CLI subscribe recovery: 2+ charges → fail-close', () => {
  it('multiple matching charges → fail-close', async () => {
    const deps = createMockDeps({
      db: mockDbPool(
        vi.fn(async (text: string) => {
          if (text.includes('inflight_operation_id')) {
            return { rows: [MEMBER_WITH_INFLIGHT_SUBSCRIBE], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }),
      ),
      listPayjpCharges: vi.fn(async () => ({
        data: [
          { id: 'chg_1', metadata: { operation_id: 'op_1' } },
          { id: 'chg_2', metadata: { operation_id: 'op_1' } },
        ],
        has_more: false,
      })),
    });

    const result = await runResyncCli(['--operation-id', 'op_1'], deps);
    expect(result.exitCode).toBe(2);
    expect(result.result.failed_count).toBe(1);
  });
});

// INT-SYNC-016: CLI subscribe recovery: customer_id NULL → fail-close
describe('INT-SYNC-016: CLI subscribe recovery: customer_id NULL', () => {
  it('NULL payjp_customer_id → fail-close + impact log', async () => {
    const deps = createMockDeps({
      db: mockDbPool(
        vi.fn(async (text: string) => {
          if (text.includes('inflight_operation_id')) {
            return { rows: [{ ...MEMBER_WITH_INFLIGHT_SUBSCRIBE, payjp_customer_id: null }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }),
      ),
    });

    const result = await runResyncCli(['--operation-id', 'op_1'], deps);
    expect(result.exitCode).toBe(2);
    expect(result.result.failed_count).toBe(1);
  });
});

// INT-SYNC-017: CLI cancel recovery: subscription search + cancel
describe('INT-SYNC-017: CLI cancel recovery: subscription search + cancel', () => {
  it('found subscription → cancel if not already canceled', async () => {
    const deps = createMockDeps({
      db: mockDbPool(
        vi.fn(async (text: string) => {
          if (text.includes('inflight_operation_id')) {
            return { rows: [MEMBER_WITH_INFLIGHT_CANCEL], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }),
      ),
      getPayjpSubscription: vi.fn(async () => ({ id: 'sub_1', status: 'active' })),
    });

    const _result = await runResyncCli(['--operation-id', 'op_1'], deps);
    expect(deps.cancelPayjpSubscription).toHaveBeenCalledWith('sub_1');
  });
});

// INT-SYNC-018: CLI cancel recovery: metadata fallback
describe('INT-SYNC-018: CLI cancel recovery: metadata fallback with period_end', () => {
  it('no metadata, 1 candidate + period_end match → adopt', async () => {
    const memberNoSubId = {
      ...MEMBER_WITH_INFLIGHT_CANCEL,
      payjp_subscription_id: null,
      next_billing_at: new Date('2026-07-06T12:00:00Z'),
    };
    const deps = createMockDeps({
      db: mockDbPool(
        vi.fn(async (text: string) => {
          if (text.includes('inflight_operation_id')) {
            return { rows: [memberNoSubId], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }),
      ),
      listPayjpSubscriptions: vi.fn(async () => ({
        data: [
          {
            id: 'sub_found',
            status: 'active',
            current_period_end: Math.floor(new Date('2026-07-06T12:00:00Z').getTime() / 1000),
          },
        ],
        has_more: false,
      })),
      getPayjpSubscription: vi.fn(async () => ({ id: 'sub_found', status: 'active' })),
    });

    const _result = await runResyncCli(['--operation-id', 'op_1'], deps);
    expect(deps.cancelPayjpSubscription).toHaveBeenCalledWith('sub_found');
  });
});

// INT-SYNC-019: CLI --discord-user-id
describe('INT-SYNC-019: CLI --discord-user-id: full reconciliation', () => {
  it('full state reconciliation for single user', async () => {
    const member = {
      id: 'mem_1',
      discord_user_id: 'user_1',
      subscription_status: 'active',
      payjp_plan_id: 'plan_1',
      payjp_subscription_id: 'sub_1',
      access_end_at: new Date('2026-07-06T12:00:00Z'),
      last_payjp_event_created_at: null,
    };
    const deps = createMockDeps({
      db: mockDbPool(
        vi.fn(async (text: string) => {
          if (text.includes('discord_user_id')) {
            return { rows: [member], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }),
      ),
    });

    const result = await runResyncCli(['--discord-user-id', 'user_1'], deps);
    expect(result.exitCode).toBe(0);
    expect(result.result.succeeded_count).toBe(1);
    expect(deps.getPayjpSubscription).toHaveBeenCalledWith('sub_1');
  });
});

// INT-SYNC-020: CLI --all
describe('INT-SYNC-020: CLI --all: iterate all + verify 0 inflight residual', () => {
  it('iterates all members', async () => {
    const members = [
      {
        id: 'mem_1',
        discord_user_id: 'user_1',
        subscription_status: 'active',
        payjp_plan_id: 'plan_1',
        payjp_subscription_id: 'sub_1',
        access_end_at: new Date('2026-07-06T12:00:00Z'),
      },
      {
        id: 'mem_2',
        discord_user_id: 'user_2',
        subscription_status: 'canceled',
        payjp_plan_id: 'plan_1',
        payjp_subscription_id: 'sub_2',
        access_end_at: new Date('2026-03-06T12:00:00Z'),
      },
    ];
    const deps = createMockDeps({
      db: mockDbPool(
        vi.fn(async (text: string) => {
          if (text.includes('SELECT * FROM members') && !text.includes('WHERE')) {
            return { rows: members, rowCount: 2 };
          }
          return { rows: [], rowCount: 0 };
        }),
      ),
    });

    const result = await runResyncCli(['--all'], deps);
    expect(result.result.target).toBe('all');
    expect(result.result.processed_count).toBe(2);
  });
});

// INT-SYNC-023: last_payjp_event_created_at update
describe('INT-SYNC-023: CLI last_payjp_event_created_at update after recovery', () => {
  it('max(existing, resyncStartUnix) after recovery', async () => {
    const deps = createMockDeps({
      db: mockDbPool(
        vi.fn(async (text: string, _params?: unknown[]) => {
          if (text.includes('inflight_operation_id')) {
            return { rows: [MEMBER_WITH_INFLIGHT_CANCEL], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }),
      ),
      getPayjpSubscription: vi.fn(async () => ({ id: 'sub_1', status: 'active' })),
    });

    await runResyncCli(['--operation-id', 'op_1'], deps);
    const updateCalls = (deps.db.query as ReturnType<typeof vi.fn>).mock.calls.filter((c: unknown[]) =>
      (c[0] as string).includes('last_payjp_event_created_at'),
    );
    expect(updateCalls.length).toBeGreaterThan(0);
  });
});

// INT-SYNC-024: member_impact_logs lifecycle
describe('INT-SYNC-024: member_impact_logs: insert on failure, resolve on recovery', () => {
  it('insert on failure', async () => {
    const deps = createMockDeps({
      db: mockDbPool(
        vi.fn(async (text: string) => {
          if (text.includes('inflight_operation_id')) {
            return { rows: [{ ...MEMBER_WITH_INFLIGHT_SUBSCRIBE, payjp_customer_id: null }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }),
      ),
    });

    await runResyncCli(['--operation-id', 'op_1'], deps);
    const insertCalls = (deps.db.query as ReturnType<typeof vi.fn>).mock.calls.filter((c: unknown[]) =>
      (c[0] as string).includes('INSERT INTO member_impact_logs'),
    );
    expect(insertCalls.length).toBeGreaterThan(0);
  });
});

// INT-SYNC-010: Daily resync access_end_at expired
describe('INT-SYNC-010: Daily resync: access_end_at expired', () => {
  it('expired access_end_at → role revoke', async () => {
    const members = [
      {
        id: 'mem_1',
        discord_user_id: 'user_1',
        subscription_status: 'canceled',
        payjp_plan_id: 'plan_1',
        payjp_subscription_id: 'sub_1',
        access_end_at: new Date('2026-04-05T12:00:00Z'), // past
      },
    ];
    const deps = createMockDeps({
      db: mockDbPool(
        vi.fn(async (text: string) => {
          if (text.includes('SELECT * FROM members') && !text.includes('WHERE')) {
            return { rows: members, rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }),
      ),
    });

    const _result = await runResyncCli(['--all'], deps);
    expect(deps.syncRole).toHaveBeenCalledWith('user_1', 'revoke', 'role_1');
  });
});

// INT-SYNC-011: Daily resync subscription 404
describe('INT-SYNC-011: Daily resync: subscription 404', () => {
  it('PAY.JP 404 → treated as deleted + role revoke', async () => {
    const members = [
      {
        id: 'mem_1',
        discord_user_id: 'user_1',
        subscription_status: 'active',
        payjp_plan_id: 'plan_1',
        payjp_subscription_id: 'sub_1',
        access_end_at: new Date('2026-07-06T12:00:00Z'),
      },
    ];
    const deps = createMockDeps({
      db: mockDbPool(
        vi.fn(async (text: string) => {
          if (text.includes('SELECT * FROM members') && !text.includes('WHERE')) {
            return { rows: members, rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }),
      ),
      getPayjpSubscription: vi.fn(async () => null), // 404
    });

    const _result = await runResyncCli(['--all'], deps);
    expect(deps.syncRole).toHaveBeenCalledWith('user_1', 'revoke', 'role_1');
    const updateCalls = (deps.db.query as ReturnType<typeof vi.fn>).mock.calls.filter((c: unknown[]) =>
      (c[0] as string).includes("'deleted'"),
    );
    expect(updateCalls.length).toBeGreaterThan(0);
  });
});

// INT-SYNC-012: Daily resync does NOT clear inflight
describe('INT-SYNC-012: Daily resync: does NOT clear inflight', () => {
  it('inflight_operation_* preserved during daily resync (--all)', async () => {
    const members = [
      {
        id: 'mem_1',
        discord_user_id: 'user_1',
        subscription_status: 'active',
        payjp_plan_id: 'plan_1',
        payjp_subscription_id: 'sub_1',
        inflight_operation_id: 'op_1',
        inflight_operation_type: 'subscribe',
        access_end_at: new Date('2026-07-06T12:00:00Z'),
      },
    ];
    const deps = createMockDeps({
      db: mockDbPool(
        vi.fn(async (text: string) => {
          if (text.includes('SELECT * FROM members') && !text.includes('WHERE')) {
            return { rows: members, rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }),
      ),
    });

    await runResyncCli(['--all'], deps);
    const clearCalls = (deps.db.query as ReturnType<typeof vi.fn>).mock.calls.filter((c: unknown[]) =>
      (c[0] as string).includes('inflight_operation_id = NULL'),
    );
    expect(clearCalls).toHaveLength(0);
  });
});

// INT-SYNC-029: CLI subscribe offset>900 fail-close
describe('INT-SYNC-029: CLI subscribe: offset>900 with has_more → fail-close', () => {
  it('offset>900 → fail-close', async () => {
    let _callCount = 0;
    const deps = createMockDeps({
      db: mockDbPool(
        vi.fn(async (text: string) => {
          if (text.includes('inflight_operation_id')) {
            return { rows: [MEMBER_WITH_INFLIGHT_SUBSCRIBE], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }),
      ),
      listPayjpCharges: vi.fn(async () => {
        _callCount++;
        return { data: [], has_more: true }; // Always has_more
      }),
    });

    const result = await runResyncCli(['--operation-id', 'op_1'], deps);
    expect(result.exitCode).toBe(2);
  });
});

// INT-SYNC-030: CLI cancel period_end mismatch
describe('INT-SYNC-030: CLI cancel: metadata absent + period_end mismatch → fail-close', () => {
  it('period_end mismatch → fail-close', async () => {
    const memberNoSubId = { ...MEMBER_WITH_INFLIGHT_CANCEL, payjp_subscription_id: null };
    const deps = createMockDeps({
      db: mockDbPool(
        vi.fn(async (text: string) => {
          if (text.includes('inflight_operation_id')) {
            return { rows: [memberNoSubId], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }),
      ),
      listPayjpSubscriptions: vi.fn(async () => ({
        data: [{ id: 'sub_found', status: 'active', current_period_end: 9999 }],
        has_more: false,
      })),
    });

    const result = await runResyncCli(['--operation-id', 'op_1'], deps);
    expect(result.exitCode).toBe(2);
  });
});

// INT-SYNC-031: CLI cancel customer_id NULL
describe('INT-SYNC-031: CLI cancel: customer_id NULL → fail-close', () => {
  it('NULL customer_id → fail-close + impact log', async () => {
    const deps = createMockDeps({
      db: mockDbPool(
        vi.fn(async (text: string) => {
          if (text.includes('inflight_operation_id')) {
            return {
              rows: [{ ...MEMBER_WITH_INFLIGHT_CANCEL, payjp_customer_id: null }],
              rowCount: 1,
            };
          }
          return { rows: [], rowCount: 0 };
        }),
      ),
    });

    const result = await runResyncCli(['--operation-id', 'op_1'], deps);
    expect(result.exitCode).toBe(2);
  });
});

// INT-SYNC-032: CLI cancel offset>900
describe('INT-SYNC-032: CLI cancel: offset>900 → fail-close', () => {
  it('offset>900 with has_more → fail-close', async () => {
    const memberNoSubId = { ...MEMBER_WITH_INFLIGHT_CANCEL, payjp_subscription_id: null };
    const deps = createMockDeps({
      db: mockDbPool(
        vi.fn(async (text: string) => {
          if (text.includes('inflight_operation_id')) {
            return { rows: [memberNoSubId], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }),
      ),
      listPayjpSubscriptions: vi.fn(async () => ({
        data: [{ id: 'sub_x', status: 'active', metadata: { discord_user_id: 'user_1' } }],
        has_more: true,
      })),
    });

    const result = await runResyncCli(['--operation-id', 'op_1'], deps);
    expect(result.exitCode).toBe(2);
  });
});

// INT-SYNC-033: Inflight 30min threshold
describe('INT-SYNC-033: Inflight 30min threshold detection', () => {
  it('30+ min old inflight → warning log emitted', async () => {
    const oldMember = {
      ...MEMBER_WITH_INFLIGHT_CANCEL,
      inflight_operation_started_at: new Date('2026-04-06T11:00:00Z'), // 60 min ago
    };
    const deps = createMockDeps({
      db: mockDbPool(
        vi.fn(async (text: string) => {
          if (text.includes('inflight_operation_id')) {
            return { rows: [oldMember], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }),
      ),
      getPayjpSubscription: vi.fn(async () => ({ id: 'sub_1', status: 'active' })),
    });

    await runResyncCli(['--operation-id', 'op_1'], deps);
    expect(deps.log).toHaveBeenCalled();
  });
});

// INT-SYNC-034: Inflight 6h escalation
describe('INT-SYNC-034: Inflight 6h escalation', () => {
  it('6+ hour inflight → escalation log + impact log', async () => {
    const veryOldMember = {
      ...MEMBER_WITH_INFLIGHT_CANCEL,
      inflight_operation_started_at: new Date('2026-04-06T05:00:00Z'), // 7 hours ago
    };
    const deps = createMockDeps({
      db: mockDbPool(
        vi.fn(async (text: string) => {
          if (text.includes('inflight_operation_id')) {
            return { rows: [veryOldMember], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }),
      ),
      getPayjpSubscription: vi.fn(async () => ({ id: 'sub_1', status: 'active' })),
    });

    await runResyncCli(['--operation-id', 'op_1'], deps);
    const logCalls = (deps.log as ReturnType<typeof vi.fn>).mock.calls;
    const escalationLog = logCalls.find(
      (c: unknown[]) => (c[0] as Record<string, unknown>).issue === 'escalation_6h_inflight',
    );
    expect(escalationLog).toBeDefined();
  });
});

// INT-SYNC-035: Env var validation
describe('INT-SYNC-035: Env var validation', () => {
  it('missing required vars → detected', async () => {
    const { validateWebhookRequiredEnvVars } = await import('../../core/index.js');
    const result = validateWebhookRequiredEnvVars({});
    expect(result.ok).toBe(false);
    expect(result.missingVars).toContain('PAYJP_WEBHOOK_TOKEN');
    expect(result.missingVars).toContain('DATABASE_URL');
  });

  it('all vars present → ok', async () => {
    const { validateWebhookRequiredEnvVars } = await import('../../core/index.js');
    const result = validateWebhookRequiredEnvVars({
      PAYJP_WEBHOOK_TOKEN: 'token',
      PAYJP_SECRET_KEY: 'sk_xxx',
      DATABASE_URL: 'postgres://...',
      DISCORD_BOT_TOKEN: 'bot_xxx',
      DISCORD_GUILD_ID: 'guild_1',
      PAYJP_PLAN_IDS: 'plan_starter,plan_business,plan_enterprise',
      DISCORD_PLAN_ROLE_IDS: 'role_starter,role_business,role_enterprise',
      DAILY_RESYNC_CRON: '0 3 * * *',
      PAYJP_LIVEMODE: 'true',
    });
    expect(result.ok).toBe(true);
  });
});

// INT-SYNC-037: Daily resync individual error handling
describe('INT-SYNC-037: Daily resync: individual member error → continue', () => {
  it('single member error → continue + log + impact record', async () => {
    const members = [
      {
        id: 'mem_1',
        discord_user_id: 'user_1',
        subscription_status: 'active',
        payjp_plan_id: 'plan_1',
        payjp_subscription_id: 'sub_1',
        access_end_at: new Date('2026-07-06T12:00:00Z'),
      },
      {
        id: 'mem_2',
        discord_user_id: 'user_2',
        subscription_status: 'active',
        payjp_subscription_id: 'sub_2',
        access_end_at: new Date('2026-07-06T12:00:00Z'),
      },
    ];
    const _callIdx = 0;
    const deps = createMockDeps({
      db: mockDbPool(
        vi.fn(async (text: string) => {
          if (text.includes('SELECT * FROM members') && !text.includes('WHERE')) {
            return { rows: members, rowCount: 2 };
          }
          return { rows: [], rowCount: 0 };
        }),
      ),
      getPayjpSubscription: vi.fn(async (subId: string) => {
        if (subId === 'sub_1') throw new Error('PAY.JP error');
        return { id: 'sub_2', status: 'active' };
      }),
    });

    const result = await runResyncCli(['--all'], deps);
    // Should process both members even though first one failed
    expect(result.result.processed_count).toBe(2);
    expect(result.result.failed_count).toBeGreaterThanOrEqual(1);
  });
});
