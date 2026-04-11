import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CancelError, createCancelFormLink } from '../api.js';

describe('createCancelFormLink', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('should POST to /v1/subscriptions/cancel/google-form-link with credentials and empty body', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          formUrl: 'https://docs.google.com/forms/d/e/test-form/viewform?usp=pp_url',
          expiresAt: '2026-05-07T00:00:00Z',
        }),
        { status: 200 },
      ),
    );

    const result = await createCancelFormLink();

    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/v1/subscriptions/cancel/google-form-link',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.formUrl).toContain('docs.google.com/forms');
    expect(result.expiresAt).toBe('2026-05-07T00:00:00Z');
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

    const err = await createCancelFormLink().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CancelError);
    expect((err as CancelError).status).toBe(503);
    expect((err as CancelError).operationId).toBe('op-cancel-123');
  });

  it('should throw CancelError on 401 with session error', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({ ok: false, errorCode: 'INVALID_MEMBER_SESSION', message: 'Member session not found' }),
        { status: 401 },
      ),
    );

    const err = await createCancelFormLink().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CancelError);
    expect((err as CancelError).errorCode).toBe('INVALID_MEMBER_SESSION');
  });

  it('should throw on invalid response shape', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response(JSON.stringify({ unexpected: true }), { status: 200 }));

    await expect(createCancelFormLink()).rejects.toThrow('Invalid cancel form link response');
  });
});
