import Fastify from 'fastify';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { registerAdminRoutes } from '../routes.js';

async function makeApp(mockQuery: ReturnType<typeof vi.fn>) {
  const app = Fastify();
  await registerAdminRoutes(app, { pool: { query: mockQuery } as unknown as Pool });
  return app;
}

const ACCESS_HEADERS = {
  'cf-access-authenticated-user-email': 'operator@example.com',
};

const VALID_UUID = 'a0000000-0000-4000-a000-000000000099';

function mockMemberDetail() {
  return {
    id: VALID_UUID,
    email: 'a@example.com',
    discord_user_id: 'd1',
    subscription_status: 'active',
    payjp_plan_id: 'plan_x',
    role_state: 'granted',
    created_at: '2025-01-01T00:00:00.000Z',
    last_synced_at: '2025-01-02T00:00:00.000Z',
    inflight_operation_id: null,
    unresolved_impact_count: 0,
    payjp_customer_id: 'cus_1',
    payjp_subscription_id: 'sub_1',
    access_end_at: null,
    next_billing_at: '2025-02-01T00:00:00.000Z',
    cancel_requested_at: null,
    inflight_operation_type: null,
    inflight_operation_started_at: null,
    inflight_subscribe_plan_id: null,
    updated_at: '2025-01-01T00:00:00.000Z',
  };
}

describe('admin routes (read-only)', () => {
  it('rejects POST with 405', async () => {
    const app = await makeApp(vi.fn());
    const res = await app.inject({ method: 'POST', url: '/admin/overview', payload: {} });
    expect(res.statusCode).toBe(405);
  });

  it('rejects GET without auth headers', async () => {
    const app = await makeApp(vi.fn());
    const res = await app.inject({ method: 'GET', url: '/admin/overview' });
    expect(res.statusCode).toBe(401);
  });

  it('accepts local fallback headers when ADMIN_API_KEY matches', async () => {
    const original = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = 'local-secret';
    try {
      const mockQuery = vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ c: '0' }] })
        .mockResolvedValueOnce({ rows: [{ c: '0' }] });
      const app = await makeApp(mockQuery);
      const res = await app.inject({
        method: 'GET',
        url: '/admin/overview',
        headers: {
          'x-admin-audit-actor': 'local-operator@example.com',
          'x-admin-api-key': 'local-secret',
        },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      if (original === undefined) {
        delete process.env.ADMIN_API_KEY;
      } else {
        process.env.ADMIN_API_KEY = original;
      }
    }
  });

  it('GET /admin/overview aggregates status rows', async () => {
    const mockQuery = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          { subscription_status: 'active', c: '2' },
          { subscription_status: null, c: '1' },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ c: '3' }] })
      .mockResolvedValueOnce({ rows: [{ c: '1' }] });
    const app = await makeApp(mockQuery);
    const res = await app.inject({ method: 'GET', url: '/admin/overview', headers: ACCESS_HEADERS });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.unresolvedImpactCount).toBe(3);
    expect(body.inflightMemberCount).toBe(1);
    expect(body.membersByStatus).toEqual({ active: 2, null: 1 });
  });

  it('GET /admin/members returns pagination fields', async () => {
    const mockQuery = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ c: '1' }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: VALID_UUID,
            email: 'a@example.com',
            discord_user_id: 'd1',
            subscription_status: 'trial',
            payjp_plan_id: 'plan_x',
            role_state: 'granted',
            created_at: '2025-01-01T00:00:00.000Z',
            last_synced_at: '2025-01-02T00:00:00.000Z',
            inflight_operation_id: null,
            unresolved_impact_count: 0,
          },
        ],
      });
    const app = await makeApp(mockQuery);
    const res = await app.inject({
      method: 'GET',
      url: '/admin/members?limit=10&page=1',
      headers: ACCESS_HEADERS,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { total: number; members: unknown[]; limit: number };
    expect(body.total).toBe(1);
    expect(body.members).toHaveLength(1);
    expect(body.limit).toBe(10);
  });

  it('GET /admin/members/:id returns 400 for invalid uuid', async () => {
    const app = await makeApp(vi.fn());
    const res = await app.inject({
      method: 'GET',
      url: '/admin/members/not-a-uuid',
      headers: ACCESS_HEADERS,
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('admin routes — HTTP method enforcement', () => {
  it.each(['PUT', 'PATCH', 'DELETE'] as const)('%s → 405', async (method) => {
    const app = await makeApp(vi.fn());
    const res = await app.inject({ method, url: '/admin/overview', headers: ACCESS_HEADERS });
    expect(res.statusCode).toBe(405);
  });

  it('HEAD /admin/overview → 200 (allowed alongside GET)', async () => {
    const mockQuery = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ c: '0' }] })
      .mockResolvedValueOnce({ rows: [{ c: '0' }] });
    const app = await makeApp(mockQuery);
    const res = await app.inject({ method: 'HEAD', url: '/admin/overview', headers: ACCESS_HEADERS });
    expect(res.statusCode).toBe(200);
  });
});

describe('admin routes — auth edge cases', () => {
  it('local fallback: API key mismatch → 401', async () => {
    const original = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = 'correct-secret';
    try {
      const app = await makeApp(vi.fn());
      const res = await app.inject({
        method: 'GET',
        url: '/admin/overview',
        headers: { 'x-admin-audit-actor': 'op@example.com', 'x-admin-api-key': 'wrong-secret' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      if (original === undefined) delete process.env.ADMIN_API_KEY;
      else process.env.ADMIN_API_KEY = original;
    }
  });

  it('local fallback: audit-actor missing + API key present → 401', async () => {
    const original = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = 'local-secret';
    try {
      const app = await makeApp(vi.fn());
      const res = await app.inject({
        method: 'GET',
        url: '/admin/overview',
        headers: { 'x-admin-api-key': 'local-secret' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      if (original === undefined) delete process.env.ADMIN_API_KEY;
      else process.env.ADMIN_API_KEY = original;
    }
  });

  it('local fallback: ADMIN_API_KEY env not set → 401', async () => {
    const original = process.env.ADMIN_API_KEY;
    delete process.env.ADMIN_API_KEY;
    try {
      const app = await makeApp(vi.fn());
      const res = await app.inject({
        method: 'GET',
        url: '/admin/overview',
        headers: { 'x-admin-audit-actor': 'op@example.com', 'x-admin-api-key': 'any-key' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      if (original !== undefined) process.env.ADMIN_API_KEY = original;
    }
  });
});

describe('admin routes — GET /admin/members/:memberId', () => {
  it('valid UUID, member exists → 200', async () => {
    const mockQuery = vi.fn().mockResolvedValueOnce({ rows: [mockMemberDetail()] });
    const app = await makeApp(mockQuery);
    const res = await app.inject({
      method: 'GET',
      url: `/admin/members/${VALID_UUID}`,
      headers: ACCESS_HEADERS,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; member: { id: string } };
    expect(body.ok).toBe(true);
    expect(body.member.id).toBe(VALID_UUID);
  });

  it('valid UUID, member not found → 404', async () => {
    const mockQuery = vi.fn().mockResolvedValueOnce({ rows: [] });
    const app = await makeApp(mockQuery);
    const res = await app.inject({
      method: 'GET',
      url: `/admin/members/${VALID_UUID}`,
      headers: ACCESS_HEADERS,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
  });
});

describe('admin routes — GET /admin/members/:memberId/impact-logs', () => {
  it('returns unresolved logs by default', async () => {
    const logs = [
      {
        id: 'log-1',
        member_id: VALID_UUID,
        issue_code: 'role_sync_failed',
        detail: {},
        operation_id: null,
        resolved_at: null,
        created_at: '2025-01-01',
      },
    ];
    const mockQuery = vi.fn().mockResolvedValueOnce({ rows: logs });
    const app = await makeApp(mockQuery);
    const res = await app.inject({
      method: 'GET',
      url: `/admin/members/${VALID_UUID}/impact-logs`,
      headers: ACCESS_HEADERS,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; impactLogs: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.impactLogs).toHaveLength(1);
  });

  it('resolved=all returns all logs', async () => {
    const mockQuery = vi.fn().mockResolvedValueOnce({ rows: [] });
    const app = await makeApp(mockQuery);
    const res = await app.inject({
      method: 'GET',
      url: `/admin/members/${VALID_UUID}/impact-logs?resolved=all`,
      headers: ACCESS_HEADERS,
    });
    expect(res.statusCode).toBe(200);
    const sql = mockQuery.mock.calls[0]?.[0] as string;
    expect(sql).not.toContain('resolved_at IS NULL');
    expect(sql).not.toContain('resolved_at IS NOT NULL');
  });

  it('resolved=true filters to resolved only', async () => {
    const mockQuery = vi.fn().mockResolvedValueOnce({ rows: [] });
    const app = await makeApp(mockQuery);
    await app.inject({
      method: 'GET',
      url: `/admin/members/${VALID_UUID}/impact-logs?resolved=true`,
      headers: ACCESS_HEADERS,
    });
    const sql = mockQuery.mock.calls[0]?.[0] as string;
    expect(sql).toContain('resolved_at IS NOT NULL');
  });

  it('invalid UUID → 400', async () => {
    const app = await makeApp(vi.fn());
    const res = await app.inject({
      method: 'GET',
      url: '/admin/members/not-uuid/impact-logs',
      headers: ACCESS_HEADERS,
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('admin routes — pagination boundary values', () => {
  function mockMembersList() {
    return vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ c: '0' }] })
      .mockResolvedValueOnce({ rows: [] });
  }

  it('page=0 → clamped to 1 (Math.max)', async () => {
    const mockQuery = mockMembersList();
    const app = await makeApp(mockQuery);
    const res = await app.inject({
      method: 'GET',
      url: '/admin/members?page=0&limit=10',
      headers: ACCESS_HEADERS,
    });
    expect(res.statusCode).toBe(200);
    const params = mockQuery.mock.calls[1]?.[1] as unknown[];
    const offsetIdx = params.length - 1;
    expect(params[offsetIdx]).toBe(0);
  });

  it('limit=-1 → clamped to 1 (Math.max)', async () => {
    const mockQuery = mockMembersList();
    const app = await makeApp(mockQuery);
    const res = await app.inject({
      method: 'GET',
      url: '/admin/members?page=1&limit=-1',
      headers: ACCESS_HEADERS,
    });
    expect(res.statusCode).toBe(200);
    const params = mockQuery.mock.calls[1]?.[1] as unknown[];
    const limitIdx = params.length - 2;
    expect(params[limitIdx]).toBe(1);
  });

  it('limit=999 → clamped to 100 (Math.min)', async () => {
    const mockQuery = mockMembersList();
    const app = await makeApp(mockQuery);
    const res = await app.inject({
      method: 'GET',
      url: '/admin/members?page=1&limit=999',
      headers: ACCESS_HEADERS,
    });
    expect(res.statusCode).toBe(200);
    const params = mockQuery.mock.calls[1]?.[1] as unknown[];
    const limitIdx = params.length - 2;
    expect(params[limitIdx]).toBe(100);
  });

  it('page=NaN → defaults to 1', async () => {
    const mockQuery = mockMembersList();
    const app = await makeApp(mockQuery);
    const res = await app.inject({
      method: 'GET',
      url: '/admin/members?page=abc',
      headers: ACCESS_HEADERS,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { page: number };
    expect(body.page).toBe(1);
  });

  it('page=999999 (very large offset) → empty members', async () => {
    const mockQuery = mockMembersList();
    const app = await makeApp(mockQuery);
    const res = await app.inject({
      method: 'GET',
      url: '/admin/members?page=999999',
      headers: ACCESS_HEADERS,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { members: unknown[] };
    expect(body.members).toHaveLength(0);
  });
});

describe('admin routes — filter parameters', () => {
  function mockMembersList() {
    return vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ c: '0' }] })
      .mockResolvedValueOnce({ rows: [] });
  }

  it('subscription_status filter passes value to query', async () => {
    const mockQuery = mockMembersList();
    const app = await makeApp(mockQuery);
    await app.inject({
      method: 'GET',
      url: '/admin/members?subscription_status=active',
      headers: ACCESS_HEADERS,
    });
    const sql = mockQuery.mock.calls[0]?.[0] as string;
    expect(sql).toContain('subscription_status IS NOT DISTINCT FROM');
    const params = mockQuery.mock.calls[0]?.[1] as unknown[];
    expect(params).toContain('active');
  });

  it('role_state filter passes value to query', async () => {
    const mockQuery = mockMembersList();
    const app = await makeApp(mockQuery);
    await app.inject({
      method: 'GET',
      url: '/admin/members?role_state=granted',
      headers: ACCESS_HEADERS,
    });
    const sql = mockQuery.mock.calls[0]?.[0] as string;
    expect(sql).toContain('role_state =');
    const params = mockQuery.mock.calls[0]?.[1] as unknown[];
    expect(params).toContain('granted');
  });

  it('has_inflight=true adds NOT NULL filter', async () => {
    const mockQuery = mockMembersList();
    const app = await makeApp(mockQuery);
    await app.inject({
      method: 'GET',
      url: '/admin/members?has_inflight=true',
      headers: ACCESS_HEADERS,
    });
    const sql = mockQuery.mock.calls[0]?.[0] as string;
    expect(sql).toContain('inflight_operation_id IS NOT NULL');
  });

  it('has_inflight=false adds IS NULL filter', async () => {
    const mockQuery = mockMembersList();
    const app = await makeApp(mockQuery);
    await app.inject({
      method: 'GET',
      url: '/admin/members?has_inflight=false',
      headers: ACCESS_HEADERS,
    });
    const sql = mockQuery.mock.calls[0]?.[0] as string;
    expect(sql).toContain('inflight_operation_id IS NULL');
  });

  it('q with LIKE metacharacters is escaped in query params', async () => {
    const mockQuery = mockMembersList();
    const app = await makeApp(mockQuery);
    await app.inject({
      method: 'GET',
      url: '/admin/members?q=%25_test',
      headers: ACCESS_HEADERS,
    });
    const params = mockQuery.mock.calls[0]?.[1] as unknown[];
    const likeParam = params[0] as string;
    expect(likeParam).toContain('\\%');
    expect(likeParam).toContain('\\_');
  });
});
