import Fastify from 'fastify';
import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../cf-access-jwt.js', () => ({
  createCfAccessRemoteJwks: vi.fn(() => ({})),
  verifyCfAccessJwt: vi.fn(),
}));

import { verifyCfAccessJwt } from '../cf-access-jwt.js';
import { registerAdminRoutes } from '../routes.js';

async function makeApp(mockQuery: ReturnType<typeof vi.fn>) {
  const app = Fastify();
  await registerAdminRoutes(app, { pool: { query: mockQuery } as unknown as Pool });
  return app;
}

describe('admin routes — Cloudflare Access JWT', () => {
  const originalTeam = process.env.CLOUDFLARE_ACCESS_TEAM_DOMAIN;
  const originalAud = process.env.CLOUDFLARE_ACCESS_AUDIENCE;
  const originalAdminKey = process.env.ADMIN_API_KEY;

  beforeEach(() => {
    process.env.CLOUDFLARE_ACCESS_TEAM_DOMAIN = 'team.cloudflareaccess.com';
    process.env.CLOUDFLARE_ACCESS_AUDIENCE = 'audience-tag-123';
    delete process.env.ADMIN_API_KEY;
    vi.mocked(verifyCfAccessJwt).mockReset();
  });

  afterEach(() => {
    if (originalTeam === undefined) delete process.env.CLOUDFLARE_ACCESS_TEAM_DOMAIN;
    else process.env.CLOUDFLARE_ACCESS_TEAM_DOMAIN = originalTeam;
    if (originalAud === undefined) delete process.env.CLOUDFLARE_ACCESS_AUDIENCE;
    else process.env.CLOUDFLARE_ACCESS_AUDIENCE = originalAud;
    if (originalAdminKey === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = originalAdminKey;
  });

  it('401 when Cf-Access-Jwt-Assertion is missing', async () => {
    const app = await makeApp(vi.fn());
    const res = await app.inject({ method: 'GET', url: '/admin/overview' });
    expect(res.statusCode).toBe(401);
    expect(verifyCfAccessJwt).not.toHaveBeenCalled();
  });

  it('401 when only legacy email header is set (no JWT)', async () => {
    const app = await makeApp(vi.fn());
    const res = await app.inject({
      method: 'GET',
      url: '/admin/overview',
      headers: { 'cf-access-authenticated-user-email': 'attacker@evil.com' },
    });
    expect(res.statusCode).toBe(401);
    expect(verifyCfAccessJwt).not.toHaveBeenCalled();
  });

  it('200 when JWT verifies and email is used for audit', async () => {
    vi.mocked(verifyCfAccessJwt).mockResolvedValue({ ok: true, email: 'real@example.com' });
    const mockQuery = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ c: '0' }] })
      .mockResolvedValueOnce({ rows: [{ c: '0' }] });
    const app = await makeApp(mockQuery);
    const res = await app.inject({
      method: 'GET',
      url: '/admin/overview',
      headers: { 'cf-access-jwt-assertion': 'eyJhbGciOiJSUzI1NiJ9.fake' },
    });
    expect(res.statusCode).toBe(200);
    expect(verifyCfAccessJwt).toHaveBeenCalledWith(
      expect.objectContaining({
        token: 'eyJhbGciOiJSUzI1NiJ9.fake',
        teamDomain: 'team.cloudflareaccess.com',
        audience: 'audience-tag-123',
      }),
    );
  });

  it('401 when verifyCfAccessJwt returns failure', async () => {
    vi.mocked(verifyCfAccessJwt).mockResolvedValue({ ok: false, reason: 'expired' });
    const app = await makeApp(vi.fn());
    const res = await app.inject({
      method: 'GET',
      url: '/admin/overview',
      headers: { 'cf-access-jwt-assertion': 'bad.token' },
    });
    expect(res.statusCode).toBe(401);
  });
});
