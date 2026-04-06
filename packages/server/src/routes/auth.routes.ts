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

  app.get('/v1/auth/discord/start', async (_request, reply) => {
    const authReq: AuthRequest = {
      endpoint: '/v1/auth/discord/start',
    };
    const result = await handleAuthRequest(authReq, config);
    return sendAuthResponse(reply, result);
  });

  app.get('/v1/auth/discord/callback', async (request, reply) => {
    const query = request.query as Record<string, string>;
    const authReq: AuthRequest = {
      endpoint: '/v1/auth/discord/callback',
      query: {
        code: query.code ?? '',
        state: query.state ?? '',
      },
      cookies: {
        '__Host-oauth_session': request.cookies['__Host-oauth_session'] ?? '',
      },
    };
    const result = await handleAuthRequest(authReq, config);
    return sendAuthResponse(reply, result);
  });

  app.get('/v1/auth/discord/session', async (request, reply) => {
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
  });
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
