/**
 * Regression: PAY.JP `getPayjpSubscription` error contract.
 *
 * `null` MUST mean "subscription not found on PAY.JP" only.
 * Transient errors (5xx / network / timeout) MUST surface as exceptions so
 * `reconcileMember` does not mark the row `subscription_status='deleted'` and
 * mass-revoke Discord roles during a PAY.JP outage.
 */
import type { REST } from '@discordjs/rest';
import type { CliDeps } from '@hayane/sync-service';
import { describe, expect, it, vi } from 'vitest';
import { buildCliDepsFromPayjpApi, type PayjpApiLike } from '../cli-deps-factory.js';

function makeFakePayjpApi(retrieve: (id: string) => Promise<unknown>): PayjpApiLike {
  return {
    subscriptions: {
      retrieve: vi.fn(async (id: unknown) => retrieve(id as string)),
      list: vi.fn(),
      cancel: vi.fn(),
      create: vi.fn(),
    },
    charges: { list: vi.fn(), create: vi.fn() },
    customers: {},
    plans: {},
    tokens: {},
    transfers: {},
    events: {},
  } as unknown as PayjpApiLike;
}

function buildDeps(retrieve: (id: string) => Promise<unknown>, log: CliDeps['log'] = vi.fn()): CliDeps {
  return buildCliDepsFromPayjpApi({
    db: {} as CliDeps['db'],
    payjpApi: makeFakePayjpApi(retrieve),
    discordRest: {} as REST,
    discordGuildId: 'g',
    planRoleMapping: { p: 'r' },
    planInitialChargeAmounts: { p: 1000 },
    log,
    now: () => new Date('2026-04-17T00:00:00Z'),
  });
}

describe('cli-deps-factory.getPayjpSubscription error contract', () => {
  it('returns subscription object on success', async () => {
    const deps = buildDeps(async () => ({ id: 'sub_1', status: 'active' }));
    await expect(deps.getPayjpSubscription('sub_1')).resolves.toEqual({ id: 'sub_1', status: 'active' });
  });

  it('returns null when PAY.JP responds 404 (subscription deleted upstream)', async () => {
    const log = vi.fn();
    const err = Object.assign(new Error('HTTP Error 404'), { status: 404 });
    const deps = buildDeps(async () => {
      throw err;
    }, log);
    await expect(deps.getPayjpSubscription('sub_missing')).resolves.toBeNull();
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'payjp/subscriptions.retrieve',
        result: 'success',
        http_status: 404,
      }),
    );
  });

  it('rethrows on PAY.JP 5xx (uncertain — must NOT be silently treated as deleted)', async () => {
    const err = Object.assign(new Error('HTTP Error 503'), { status: 503 });
    const deps = buildDeps(async () => {
      throw err;
    });
    await expect(deps.getPayjpSubscription('sub_1')).rejects.toBe(err);
  });

  it('rethrows on network error (no .status property)', async () => {
    const err = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const deps = buildDeps(async () => {
      throw err;
    });
    await expect(deps.getPayjpSubscription('sub_1')).rejects.toBe(err);
  });

  it('rethrows on timeout error', async () => {
    const err = Object.assign(new Error('Timeout of 30000ms exceeded'), {
      name: 'TimeoutError',
      code: 'ETIMEDOUT',
    });
    const deps = buildDeps(async () => {
      throw err;
    });
    await expect(deps.getPayjpSubscription('sub_1')).rejects.toBe(err);
  });
});
