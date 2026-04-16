import type { AuthConfig, AuthRequest } from '@hayane/auth-service';
import { handleAuthRequest } from '@hayane/auth-service';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { isForbiddenCrossSiteFetch } from '../cross-site-fetch.js';

const MANAGED_HEADERS = new Set([
  'cache-control',
  'referrer-policy',
  'access-control-allow-origin',
  'access-control-allow-credentials',
]);

export async function authRoutes(app: FastifyInstance, opts: { config: AuthConfig }) {
  const { config } = opts;

  app.get(
    '/v1/auth/discord/start',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (_request, reply) => {
      try {
        const authReq: AuthRequest = {
          endpoint: '/v1/auth/discord/start',
        };
        const result = await handleAuthRequest(authReq, config);
        return sendAuthResponse(reply, result);
      } catch (err) {
        console.error(
          JSON.stringify({
            level: 'error',
            service: 'auth-routes',
            message: 'auth start handler threw unexpectedly',
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
            timestamp: new Date().toISOString(),
          }),
        );
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
        console.error(
          JSON.stringify({
            level: 'error',
            service: 'auth-routes',
            message: 'auth callback handler threw unexpectedly',
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
            timestamp: new Date().toISOString(),
          }),
        );
        return reply.status(503).send({ error: 'Service Unavailable' });
      }
    },
  );

  app.get(
    '/v1/auth/discord/session',
    { config: { rateLimit: { max: 15, timeWindow: '1 minute' } } },
    async (request, reply) => {
      // Block cross-site top-level navigations / no-cors loads that omit Origin (FIND-008 allows
      // same-origin navigations without Origin; attackers otherwise obtain JSON via <a href> + Referrer).
      if (isForbiddenCrossSiteFetch(request)) {
        return reply.status(403).send({ error: 'Forbidden' });
      }
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
        console.error(
          JSON.stringify({
            level: 'error',
            service: 'auth-routes',
            message: 'auth session handler threw unexpectedly',
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
            timestamp: new Date().toISOString(),
          }),
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
