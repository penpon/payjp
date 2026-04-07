import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSubscription, fetchSubscriptionStatus, SubscribeError, SubscriptionStatusError } from '../api.js';

describe('billing api', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('createSubscription', () => {
    it('should POST to /v1/subscriptions with credentials', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: true,
            memberId: 'uuid-123',
            subscriptionStatus: 'trial',
            planId: 'plan_starter',
            trialApplied: true,
            accessEndAt: '2026-07-07T00:00:00Z',
          }),
          { status: 200 },
        ),
      );

      const result = await createSubscription({
        planId: 'plan_starter',
        email: 'test@example.com',
        payjpToken: 'tok_test',
        privacyConsented: true,
      });

      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/v1/subscriptions',
        expect.objectContaining({
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            planId: 'plan_starter',
            email: 'test@example.com',
            payjpToken: 'tok_test',
            privacyConsented: true,
          }),
        }),
      );
      expect(result.ok).toBe(true);
      expect(result.planId).toBe('plan_starter');
    });

    it('should throw SubscribeError on 401 with errorCode', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ ok: false, errorCode: 'INVALID_LINK_SESSION', message: 'Invalid session' }), {
          status: 401,
        }),
      );

      const err = await createSubscription({
        planId: 'p',
        email: 'e',
        payjpToken: 't',
        privacyConsented: true,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SubscribeError);
      expect((err as SubscribeError).status).toBe(401);
      expect((err as SubscribeError).errorCode).toBe('INVALID_LINK_SESSION');
    });

    it('should throw SubscribeError on 503 with operationId', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: false,
            errorCode: 'INFLIGHT_OPERATION',
            message: 'Operation in progress',
            operationId: 'op-123',
          }),
          { status: 503 },
        ),
      );

      const err = await createSubscription({
        planId: 'p',
        email: 'e',
        payjpToken: 't',
        privacyConsented: true,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SubscribeError);
      expect((err as SubscribeError).operationId).toBe('op-123');
    });

    it('should throw SubscribeError on 422 (3DS required)', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: false,
            errorCode: 'THREE_D_SECURE_REQUIRED',
            message: '3DS not verified',
            operationId: 'op-456',
          }),
          { status: 422 },
        ),
      );

      const err = await createSubscription({
        planId: 'p',
        email: 'e',
        payjpToken: 't',
        privacyConsented: true,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SubscribeError);
      expect((err as SubscribeError).errorCode).toBe('THREE_D_SECURE_REQUIRED');
    });

    it('should throw on invalid response shape', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ unexpected: true }), { status: 200 }),
      );

      await expect(
        createSubscription({ planId: 'p', email: 'e', payjpToken: 't', privacyConsented: true }),
      ).rejects.toThrow('Invalid subscribe response');
    });
  });

  describe('fetchSubscriptionStatus', () => {
    it('should return subscription when found', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            subscription: { status: 'active', planId: 'plan_business', accessEndAt: '2026-05-01T00:00:00Z' },
          }),
          { status: 200 },
        ),
      );

      const result = await fetchSubscriptionStatus();
      expect(result).toEqual({ status: 'active', planId: 'plan_business', accessEndAt: '2026-05-01T00:00:00Z' });
    });

    it('should return null when no subscription', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ subscription: null }), { status: 200 }),
      );

      const result = await fetchSubscriptionStatus();
      expect(result).toBeNull();
    });

    it('should accept subscription with null planId and accessEndAt', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            subscription: { status: 'active', planId: null, accessEndAt: null },
          }),
          { status: 200 },
        ),
      );

      const result = await fetchSubscriptionStatus();
      expect(result).toEqual({ status: 'active', planId: null, accessEndAt: null });
    });

    it('should throw on subscription missing planId or accessEndAt', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ subscription: { status: 'active' } }), { status: 200 }),
      );

      await expect(fetchSubscriptionStatus()).rejects.toThrow('Invalid subscription status response');
    });

    it('should throw SubscriptionStatusError on server error', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(new Response(null, { status: 500 }));

      const err = await fetchSubscriptionStatus().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SubscriptionStatusError);
      expect((err as SubscriptionStatusError).status).toBe(500);
    });

    it('should throw SubscriptionStatusError on 503', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: false,
            errorCode: 'STATUS_UNAVAILABLE',
            message: 'Could not load subscription status',
          }),
          { status: 503 },
        ),
      );

      const err = await fetchSubscriptionStatus().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SubscriptionStatusError);
      expect((err as SubscriptionStatusError).status).toBe(503);
    });
  });
});
