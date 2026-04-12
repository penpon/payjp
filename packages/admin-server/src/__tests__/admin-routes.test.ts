import Fastify from 'fastify';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { registerAdminRoutes } from '../routes.js';

async function makeApp(mockQuery: ReturnType<typeof vi.fn>) {
  const app = Fastify();
  await registerAdminRoutes(app, { pool: { query: mockQuery } as unknown as Pool });
  return app;
}

describe('admin routes (read-only)', () => {
  it('rejects POST with 405', async () => {
    const app = await makeApp(vi.fn());
    const res = await app.inject({ method: 'POST', url: '/admin/overview', payload: {} });
    expect(res.statusCode).toBe(405);
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
    const res = await app.inject({ method: 'GET', url: '/admin/overview' });
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
            id: '00000000-0000-0000-0000-000000000099',
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
    const res = await app.inject({ method: 'GET', url: '/admin/members?limit=10&page=1' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { total: number; members: unknown[]; limit: number };
    expect(body.total).toBe(1);
    expect(body.members).toHaveLength(1);
    expect(body.limit).toBe(10);
  });

  it('GET /admin/members/:id returns 400 for invalid uuid', async () => {
    const app = await makeApp(vi.fn());
    const res = await app.inject({ method: 'GET', url: '/admin/members/not-a-uuid' });
    expect(res.statusCode).toBe(400);
  });
});
