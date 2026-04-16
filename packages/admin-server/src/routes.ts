import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { verifyCfAccessJwt } from './cf-access-jwt.js';
import { isUuid, queryAdminOverview, queryMemberDetail, queryMemberImpactLogs, queryMembersList } from './queries.js';

function parseBool(v: unknown): boolean | null {
  if (v === undefined || v === null || v === '') return null;
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return null;
}

function parseHeaderValue(v: unknown): string | null {
  if (Array.isArray(v)) {
    const first = v[0];
    if (typeof first === 'string') {
      const trimmed = first.trim();
      return trimmed === '' ? null : trimmed;
    }
    return null;
  }
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed === '' ? null : trimmed;
}

function hasValidAdminApiKey(provided: string | null, expectedRaw: string | undefined): boolean {
  const expected = expectedRaw?.trim() ?? '';
  if (expected === '' || !provided) return false;
  const providedDigest = createHash('sha256').update(provided, 'utf8').digest();
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

function logAdminRequest(request: FastifyRequest, actor: string): void {
  let pathname = '';
  try {
    pathname = new URL(request.url, 'http://_').pathname;
  } catch {
    pathname = '[invalid-url]';
  }
  request.log.info({ auditActor: actor, path: pathname }, 'admin request');
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

    const teamDomain = process.env.CLOUDFLARE_ACCESS_TEAM_DOMAIN?.trim() ?? '';
    const accessAudience = process.env.CLOUDFLARE_ACCESS_AUDIENCE?.trim() ?? '';
    if (teamDomain && accessAudience) {
      const jwtAssertion = parseHeaderValue(request.headers['cf-access-jwt-assertion']);
      if (!jwtAssertion) {
        return reply.status(401).send({
          error: 'unauthorized_admin_request',
          message: 'Cf-Access-Jwt-Assertion is required',
        });
      }
      const verified = await verifyCfAccessJwt({
        token: jwtAssertion,
        teamDomain,
        audience: accessAudience,
      });
      if (verified.ok) {
        logAdminRequest(request, verified.email);
        return;
      }
      return reply.status(401).send({
        error: 'unauthorized_admin_request',
        message: 'Invalid Cloudflare Access token',
      });
    }

    const localActor = parseHeaderValue(request.headers['x-admin-audit-actor']);
    const localApiKey = parseHeaderValue(request.headers['x-admin-api-key']);
    if (localActor && hasValidAdminApiKey(localApiKey, process.env.ADMIN_API_KEY)) {
      logAdminRequest(request, localActor);
      return;
    }

    return reply.status(401).send({
      error: 'unauthorized_admin_request',
      message: 'Authentication required',
    });
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
