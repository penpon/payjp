import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { isUuid, queryAdminOverview, queryMemberDetail, queryMemberImpactLogs, queryMembersList } from './queries.js';

function parseBool(v: unknown): boolean | null {
  if (v === undefined || v === null || v === '') return null;
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return null;
}

export async function registerAdminRoutes(app: FastifyInstance, opts: { pool: Pool }): Promise<void> {
  const { pool } = opts;

  app.addHook('preHandler', async (request, reply) => {
    if (request.method === 'OPTIONS') {
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return reply.status(405).send({ error: 'read_only', message: 'Only GET is allowed' });
    }
  });

  app.get('/admin/overview', async () => {
    const overview = await queryAdminOverview(pool);
    return { ok: true as const, ...overview };
  });

  app.get('/admin/members', async (request) => {
    const q = request.query as Record<string, unknown>;
    const page = Number.parseInt(typeof q.page === 'string' ? q.page : '1', 10);
    const limit = Number.parseInt(typeof q.limit === 'string' ? q.limit : '50', 10);
    const pageN = Number.isFinite(page) ? page : 1;
    const limitN = Number.isFinite(limit) ? limit : 50;
    const { rows, total } = await queryMembersList(pool, {
      page: pageN,
      limit: limitN,
      q: typeof q.q === 'string' ? q.q : null,
      subscriptionStatus: typeof q.subscription_status === 'string' ? q.subscription_status : null,
      roleState: typeof q.role_state === 'string' ? q.role_state : null,
      hasInflight: parseBool(q.has_inflight),
    });
    return { ok: true as const, members: rows, total, page: pageN, limit: limitN };
  });

  app.get<{ Params: { memberId: string } }>('/admin/members/:memberId', async (request, reply) => {
    const { memberId } = request.params;
    if (!isUuid(memberId)) {
      return reply.status(400).send({ error: 'invalid_member_id' });
    }
    const member = await queryMemberDetail(pool, memberId);
    if (!member) {
      return reply.status(404).send({ error: 'not_found' });
    }
    return { ok: true as const, member };
  });

  app.get<{ Params: { memberId: string } }>('/admin/members/:memberId/impact-logs', async (request, reply) => {
    const { memberId } = request.params;
    if (!isUuid(memberId)) {
      return reply.status(400).send({ error: 'invalid_member_id' });
    }
    const q = request.query as Record<string, unknown>;
    const resolved = typeof q.resolved === 'string' ? q.resolved : '';
    const mode = resolved === 'all' ? 'all' : resolved === 'true' ? 'resolved' : ('unresolved' as const);
    const rows = await queryMemberImpactLogs(pool, memberId, mode);
    return { ok: true as const, impactLogs: rows };
  });
}
