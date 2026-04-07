import type { AuthRequest } from '@hayane/auth-service';
import { handleAuthRequest } from '@hayane/auth-service';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AppConfig } from '../app.js';

const MANAGED_HEADERS = new Set([
  'cache-control',
  'referrer-policy',
  'access-control-allow-origin',
  'access-control-allow-credentials',
]);

export async function authRoutes(app: FastifyInstance, opts: { config: AppConfig }) {
  const { config } = opts;

  app.get(
    '/v1/auth/discord/start',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      try {
        const authReq: AuthRequest = {
          endpoint: '/v1/auth/discord/start',
        };
        const result = await handleAuthRequest(authReq, config);
        return sendAuthResponse(reply, result);
      } catch (err) {
        request.log.error({ message: (err as Error)?.message ?? String(err) }, 'auth start handler threw unexpectedly');
        return reply.status(503).send({ error: 'Service Unavailable' });
      }
    },
  );

  app.get(
    '/v1/auth/discord/callback',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      try {
        const rawQuery = request.query as Record<string, unknown>;
        const code = typeof rawQuery.code === 'string' ? rawQuery.code : '';
        const state = typeof rawQuery.state === 'string' ? rawQuery.state : '';
        const authReq: AuthRequest = {
          endpoint: '/v1/auth/discord/callback',
          query: {
            code,
            state,
          },
          cookies: {
            '__Host-oauth_session': request.cookies['__Host-oauth_session'] ?? '',
          },
        };
        const result = await handleAuthRequest(authReq, config);
        return sendAuthResponse(reply, result);
      } catch (err) {
        request.log.error(
          { message: (err as Error)?.message ?? String(err) },
          'auth callback handler threw unexpectedly',
        );
        return reply.status(503).send({ error: 'Service Unavailable' });
      }
    },
  );

  app.get(
    '/v1/auth/discord/session',
    { config: { rateLimit: { max: 15, timeWindow: '1 minute' } } },
    async (request, reply) => {
      try {
        const origin = request.headers.origin;
        const authReq: AuthRequest = {
          endpoint: '/v1/auth/discord/session',
          cookies: {
            '__Host-link_session': request.cookies['__Host-link_session'] ?? '',
          },
          headers: {
            Origin: typeof origin === 'string' ? origin : '',
          },
        };
        const result = await handleAuthRequest(authReq, config);
        return sendAuthResponse(reply, result);
      } catch (err) {
        request.log.error(
          { message: (err as Error)?.message ?? String(err) },
          'auth session handler threw unexpectedly',
        );
        return reply.status(503).send({ error: 'Service Unavailable' });
      }
    },
  );
}

function sendAuthResponse(
  reply: FastifyReply,
  result: { statusCode: number; headers: Record<string, string>; body?: unknown },
) {
  for (const [key, value] of Object.entries(result.headers)) {
    // Fastify app-level hooks own these headers so auth-service output cannot conflict.
    if (MANAGED_HEADERS.has(key.toLowerCase())) continue;
    reply.header(key, value);
  }

  reply.status(result.statusCode);
  if (result.body !== undefined) {
    return reply.send(result.body);
  }
  return reply.send();
}
