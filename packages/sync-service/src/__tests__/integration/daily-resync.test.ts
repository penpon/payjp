import type { LogEntry } from '@hayane/shared';
import { describe, expect, it, vi } from 'vitest';
import type { CliDeps } from '../../shell/cli.js';
import type { DailyResyncDeps } from '../../shell/daily-resync.js';
import { runDailyResync } from '../../shell/daily-resync.js';
import type { DbPool } from '../../shell/types.js';

function createMockCliDeps(overrides: Partial<CliDeps> = {}): CliDeps {
  const db: DbPool = {
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  };

  return {
    db,
    getPayjpSubscription: vi.fn(async () => ({ id: 'sub_1', status: 'active' })),
    listPayjpCharges: vi.fn(async () => ({ data: [], has_more: false })),
    listPayjpSubscriptions: vi.fn(async () => ({ data: [], has_more: false })),
    createPayjpCharge: vi.fn(async () => ({ id: 'chg_new' })),
    createPayjpSubscription: vi.fn(async () => ({ id: 'sub_new', status: 'active' })),
    cancelPayjpSubscription: vi.fn(async () => ({ id: 'sub_1', status: 'canceled' })),
    syncRole: vi.fn(async () => {}),
    log: vi.fn(),
    now: () => new Date('2026-04-06T12:00:00Z'),
    ...overrides,
  };
}

function createDeps(cliOverrides: Partial<CliDeps> = {}): { deps: DailyResyncDeps; log: ReturnType<typeof vi.fn> } {
  const log = vi.fn();
  return {
    deps: {
      cliDeps: createMockCliDeps(cliOverrides),
      log,
    },
    log,
  };
}

describe('runDailyResync', () => {
  it('logs success when exitCode is 0', async () => {
    const { deps, log } = createDeps();
    await runDailyResync(deps);

    expect(log).toHaveBeenCalledOnce();
    const entry: LogEntry = log.mock.calls[0][0];
    expect(entry.service).toBe('sync-service');
    expect(entry.endpoint).toBe('daily-resync');
    expect(entry.result).toBe('success');
    expect(entry.timestamp).toBeDefined();
  });

  it('logs failure when exitCode is non-zero (partial failure)', async () => {
    const db: DbPool = {
      query: vi.fn(async (text: string) => {
        if (text.includes('FROM members')) {
          return {
            rows: [
              {
                id: 'mem_1',
                discord_user_id: 'u1',
                inflight_operation_id: null,
                payjp_subscription_id: 'sub_1',
                access_end_at: null,
                subscription_status: 'active',
              },
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }),
    };

    const getPayjpSubscription = vi.fn().mockRejectedValue(new Error('PAY.JP API error'));
    const { deps, log } = createDeps({ db, getPayjpSubscription });

    await runDailyResync(deps);

    expect(log).toHaveBeenCalledOnce();
    const entry: LogEntry = log.mock.calls[0][0];
    expect(entry.result).toBe('failure');
  });

  it('logs error and rethrows when runResyncCli throws', async () => {
    const db: DbPool = {
      query: vi.fn().mockRejectedValue(new Error('DB connection failed')),
    };

    const { deps, log } = createDeps({ db });

    await expect(runDailyResync(deps)).rejects.toThrow('DB connection failed');

    expect(log).toHaveBeenCalledOnce();
    const entry: LogEntry = log.mock.calls[0][0];
    expect(entry.service).toBe('sync-service');
    expect(entry.endpoint).toBe('daily-resync');
    expect(entry.result).toBe('error');
    expect(entry.error).toBe('DB connection failed');
  });

  it('does not clear inflight_operation (--all mode skips inflight members)', async () => {
    const db: DbPool = {
      query: vi.fn(async (text: string) => {
        if (text.includes('FROM members')) {
          return {
            rows: [
              {
                id: 'mem_1',
                discord_user_id: 'u1',
                inflight_operation_id: 'op_1',
                inflight_operation_type: 'subscribe',
                payjp_subscription_id: 'sub_1',
                access_end_at: null,
                subscription_status: 'active',
              },
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }),
    };

    const { deps, log } = createDeps({ db });
    await runDailyResync(deps);

    const entry: LogEntry = log.mock.calls[0][0];
    expect(entry.result).toBe('success');

    // Verify no UPDATE cleared inflight fields
    const queryCalls = (db.query as ReturnType<typeof vi.fn>).mock.calls;
    for (const [sql] of queryCalls) {
      expect(sql).not.toContain('inflight_operation_id = NULL');
    }
  });
});
