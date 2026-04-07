import { clearStores } from '@hayane/auth-service/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';

const TEST_CONFIG = {
  frontendBaseUrl: 'https://example.com',
  discordClientId: 'test-client-id',
  discordClientSecret: 'test-client-secret',
  discordRedirectUri: 'https://api.example.com/v1/auth/discord/callback',
};

function createApp() {
  return buildApp(TEST_CONFIG);
}

describe('GET /health', () => {
  it('returns 200 with status ok', async () => {
    const app = createApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('includes security headers', async () => {
    const app = createApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });
});

describe('GET /v1/auth/discord/start', () => {
  beforeEach(() => {
    clearStores();
  });

  it('returns 302 with Location to Discord and Set-Cookie', async () => {
    const app = createApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/auth/discord/start',
    });

    expect(res.statusCode).toBe(302);

    // Location should point to Discord OAuth
    const location = res.headers.location as string;
    expect(location).toContain('https://discord.com/oauth2/authorize');
    expect(location).toContain('client_id=test-client-id');
    expect(location).toContain('scope=identify');

    // Set-Cookie should have __Host-oauth_session
    const setCookie = res.headers['set-cookie'] as string;
    expect(setCookie).toContain('__Host-oauth_session=');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain('Max-Age=600');
  });

  it('includes security headers', async () => {
    const app = createApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/auth/discord/start',
    });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });
});

describe('GET /v1/auth/discord/callback', () => {
  beforeEach(() => {
    clearStores();
  });

  it('returns 401 without required params', async () => {
    const app = createApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/auth/discord/callback',
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 with invalid state', async () => {
    const app = createApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/auth/discord/callback?code=test-code&state=invalid-state',
      cookies: { '__Host-oauth_session': 'invalid-session' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('completes full OAuth flow: start -> callback -> session', async () => {
    const app = createApp();
    const mockFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'mock_token' }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: '123456789012345678' }) } as Response);

    try {
      // Step 1: Start OAuth
      const startRes = await app.inject({
        method: 'GET',
        url: '/v1/auth/discord/start',
      });
      expect(startRes.statusCode).toBe(302);

      // Extract session cookie value from Set-Cookie header
      const setCookieHeader = startRes.headers['set-cookie'] as string;
      const sessionMatch = setCookieHeader.match(/__Host-oauth_session=([^;]+)/);
      expect(sessionMatch).not.toBeNull();
      const oauthSessionToken = sessionMatch![1];

      // Extract state from Location URL
      const location = startRes.headers.location as string;
      const locationUrl = new URL(location);
      const stateToken = locationUrl.searchParams.get('state');
      expect(stateToken).not.toBeNull();

      // Step 2: Callback with code + state + cookie
      const callbackRes = await app.inject({
        method: 'GET',
        url: `/v1/auth/discord/callback?code=mock-code&state=${stateToken}`,
        cookies: { '__Host-oauth_session': oauthSessionToken },
      });
      expect(callbackRes.statusCode).toBe(302);

      // Should redirect to frontend
      expect(callbackRes.headers.location).toBe('https://example.com');

      // Should set __Host-link_session cookie
      const linkCookieHeader = callbackRes.headers['set-cookie'] as string;
      expect(linkCookieHeader).toContain('__Host-link_session=');
      expect(linkCookieHeader).toContain('Secure');
      expect(linkCookieHeader).toContain('HttpOnly');
      expect(linkCookieHeader).toContain('SameSite=Lax');
      expect(linkCookieHeader).toContain('Path=/');
      expect(linkCookieHeader).toContain('Max-Age=900');

      // Extract link session token
      const linkMatch = linkCookieHeader.match(/__Host-link_session=([^;]+)/);
      expect(linkMatch).not.toBeNull();
      const linkSessionToken = linkMatch![1];

      // Step 3: Session check with link session cookie
      const sessionRes = await app.inject({
        method: 'GET',
        url: '/v1/auth/discord/session',
        cookies: { '__Host-link_session': linkSessionToken },
        headers: { origin: 'https://example.com' },
      });
      expect(sessionRes.statusCode).toBe(200);
      expect(sessionRes.json()).toEqual({ linked: true, discordUserId: '123456789012345678' });
    } finally {
      mockFetch.mockRestore();
    }
  });

  it('includes security headers on callback', async () => {
    const app = createApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/auth/discord/callback?code=x&state=y',
      cookies: { '__Host-oauth_session': 'z' },
    });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });
});

describe('GET /v1/auth/discord/session', () => {
  beforeEach(() => {
    clearStores();
  });

  it('returns 401 without link session cookie', async () => {
    const app = createApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/auth/discord/session',
      headers: { origin: 'https://example.com' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 with wrong origin', async () => {
    const app = createApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/auth/discord/session',
      headers: { origin: 'https://evil.com' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns CORS headers with valid origin', async () => {
    const app = createApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/auth/discord/session',
      headers: { origin: 'https://example.com' },
    });
    // @fastify/cors sets CORS headers for valid origin
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['access-control-allow-origin']).toBe('https://example.com');
  });

  it('includes security headers', async () => {
    const app = createApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/auth/discord/session',
    });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });
});

describe('CORS', () => {
  it('responds to preflight with correct headers', async () => {
    const app = createApp();
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/v1/auth/discord/session',
      headers: {
        origin: 'https://example.com',
        'access-control-request-method': 'GET',
      },
    });
    expect(res.headers['access-control-allow-origin']).toBe('https://example.com');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('rejects preflight from unauthorized origin', async () => {
    const app = createApp();
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/v1/auth/discord/session',
      headers: {
        origin: 'https://evil.com',
        'access-control-request-method': 'GET',
      },
    });
    // @fastify/cors should not set allow-origin for unauthorized origins
    expect(res.headers['access-control-allow-origin']).not.toBe('https://evil.com');
  });
});

describe('Global error handler', () => {
  it('strips UUIDs from error messages on 4xx', async () => {
    const app = createApp();
    // Register a test route that throws with UUID
    app.get('/test-error', async () => {
      const err = new Error('Member not found: 550e8400-e29b-41d4-a716-446655440000');
      (err as Error & { statusCode: number }).statusCode = 404;
      throw err;
    });

    const res = await app.inject({ method: 'GET', url: '/test-error' });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error).not.toContain('550e8400-e29b-41d4-a716-446655440000');
    expect(body.error).toContain('[REDACTED]');
  });

  it('returns generic message on 5xx', async () => {
    const app = createApp();
    app.get('/test-500', async () => {
      throw new Error('DB connection failed for user 550e8400-e29b-41d4-a716-446655440000');
    });

    const res = await app.inject({ method: 'GET', url: '/test-500' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'Internal Server Error' });
  });
});

describe('Unknown routes', () => {
  it('returns 404 for unknown paths', async () => {
    const app = createApp();
    const res = await app.inject({ method: 'GET', url: '/unknown' });
    expect(res.statusCode).toBe(404);
  });
});
