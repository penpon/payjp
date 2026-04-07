import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkSession, SessionCheckError, startOAuth } from '../api.js';

describe('api', () => {
  const originalFetch = globalThis.fetch;
  const originalLocation = window.location;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.defineProperty(window, 'location', { value: originalLocation, writable: true });
  });

  describe('checkSession', () => {
    it('should call /v1/auth/discord/session with credentials: include', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ linked: true, discordUserId: 'u1' }), { status: 200 }),
      );

      await checkSession();

      expect(globalThis.fetch).toHaveBeenCalledWith('/v1/auth/discord/session', {
        credentials: 'include',
      });
    });

    it('should return session with discordUserId when linked', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ linked: true, discordUserId: 'u1' }), { status: 200 }),
      );

      const result = await checkSession();
      expect(result).toEqual({ linked: true, discordUserId: 'u1' });
    });

    it('should return { linked: false } when session responds with linked false', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(new Response(JSON.stringify({ linked: false }), { status: 200 }));

      const result = await checkSession();
      expect(result).toEqual({ linked: false });
    });

    it('should throw SessionCheckError on 401', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(new Response(null, { status: 401 }));

      const err = await checkSession().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SessionCheckError);
      expect((err as SessionCheckError).status).toBe(401);
    });

    it('should throw SessionCheckError on 403', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(new Response(null, { status: 403 }));

      const err = await checkSession().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SessionCheckError);
      expect((err as SessionCheckError).status).toBe(403);
    });

    it('should throw on network error', async () => {
      vi.mocked(globalThis.fetch).mockRejectedValue(new TypeError('Failed to fetch'));

      await expect(checkSession()).rejects.toThrow('Failed to fetch');
    });

    it('should throw on invalid response shape (linked true without discordUserId)', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(new Response(JSON.stringify({ linked: true }), { status: 200 }));

      await expect(checkSession()).rejects.toThrow('Invalid session response');
    });

    it('should throw on invalid response shape (linked is string)', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(new Response(JSON.stringify({ linked: 'yes' }), { status: 200 }));

      await expect(checkSession()).rejects.toThrow('Invalid session response');
    });

    it('should throw on invalid response shape (empty object)', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));

      await expect(checkSession()).rejects.toThrow('Invalid session response');
    });

    it('should throw on invalid response shape (null body)', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(new Response(JSON.stringify(null), { status: 200 }));

      await expect(checkSession()).rejects.toThrow('Invalid session response');
    });
  });

  describe('startOAuth', () => {
    it('should redirect to /v1/auth/discord/start', () => {
      const mockLocation = { href: '' } as Location;
      Object.defineProperty(window, 'location', { value: mockLocation, writable: true });

      startOAuth();

      expect(mockLocation.href).toBe('/v1/auth/discord/start');
    });
  });
});
