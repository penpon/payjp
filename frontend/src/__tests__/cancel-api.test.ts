import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CancelError, cancelSubscription } from '../api.js';

describe('cancelSubscription', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('should POST to /v1/subscriptions/cancel with credentials and empty body', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          memberId: 'uuid-456',
          cancelEffectiveAt: '2026-05-07T00:00:00Z',
          roleRemovalAt: '2026-05-07T00:00:00Z',
        }),
        { status: 200 },
      ),
    );

    const result = await cancelSubscription();

    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/v1/subscriptions/cancel',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.cancelEffectiveAt).toBe('2026-05-07T00:00:00Z');
    expect(result.roleRemovalAt).toBe('2026-05-07T00:00:00Z');
  });

  it('should throw CancelError on 409 BEFORE_ACCEPTANCE_BOUNDARY', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: false,
          errorCode: 'BEFORE_ACCEPTANCE_BOUNDARY',
          message: 'Too early to cancel',
        }),
        { status: 409 },
      ),
    );

    const err = await cancelSubscription().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CancelError);
    expect((err as CancelError).status).toBe(409);
    expect((err as CancelError).errorCode).toBe('BEFORE_ACCEPTANCE_BOUNDARY');
    expect((err as CancelError).operationId).toBeUndefined();
  });

  it('should throw CancelError on 503 with operationId', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: false,
          errorCode: 'INFLIGHT_OPERATION',
          message: 'Another operation is in progress',
          operationId: 'op-cancel-123',
        }),
        { status: 503 },
      ),
    );

    const err = await cancelSubscription().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CancelError);
    expect((err as CancelError).status).toBe(503);
    expect((err as CancelError).operationId).toBe('op-cancel-123');
  });

  it('should throw CancelError on 401 with session error', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({ ok: false, errorCode: 'INVALID_LINK_SESSION', message: 'Link session not found' }),
        { status: 401 },
      ),
    );

    const err = await cancelSubscription().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CancelError);
    expect((err as CancelError).errorCode).toBe('INVALID_LINK_SESSION');
  });

  it('should throw on invalid response shape', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response(JSON.stringify({ unexpected: true }), { status: 200 }));

    await expect(cancelSubscription()).rejects.toThrow('Invalid cancel response');
  });
});
