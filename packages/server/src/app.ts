import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import fastifyRateLimit from '@fastify/rate-limit';
import type { AuthConfig } from '@hayane/auth-service';
import type { BillingDeps } from '@hayane/billing-service';
import Fastify, { type FastifyError } from 'fastify';
import { accessGateRoutes } from './routes/access-gate.routes.js';
import { authRoutes } from './routes/auth.routes.js';
import { billingRoutes } from './routes/billing.routes.js';
import { memberRoutes } from './routes/member.routes.js';
import type { SyncDeps } from './routes/sync.routes.js';
import { syncRoutes } from './routes/sync.routes.js';

export type AppConfig = AuthConfig;

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Standard phrases for 4xx when the framework uses a non-standard `error.message` (e.g. Fastify 404). */
function clientErrorMessageForStatus(statusCode: number): string | undefined {
  switch (statusCode) {
    case 400:
      return 'Bad Request';
    case 401:
      return 'Unauthorized';
    case 403:
      return 'Forbidden';
    case 404:
      return 'Not Found';
    case 405:
      return 'Method Not Allowed';
    case 409:
      return 'Conflict';
    case 413:
      return 'Payload Too Large';
    case 415:
      return 'Unsupported Media Type';
    case 422:
      return 'Unprocessable Entity';
    case 429:
      return 'Too Many Requests';
    default:
      return undefined;
  }
}

export function buildApp(config: AppConfig, billingDeps?: BillingDeps, syncDeps?: SyncDeps) {
  const app = Fastify({ logger: false });

  app.register(fastifyCookie);
  // REQ-AUTH-008: Origin validation is primarily handled by auth-service's isSameOrigin.
  // @fastify/cors manages CORS header injection; it does not block non-preflight GETs.
  app.register(fastifyCors, {
    origin: config.frontendBaseUrl,
    credentials: true,
  });

  // Rate limiting — global: false means per-route opt-in via config.rateLimit
  app.register(fastifyRateLimit, { global: false });

  app.addHook('onSend', (_request, reply, payload, done) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
    reply.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    done(null, payload);
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = error.statusCode ?? 500;
    const safeMessage = error.message.replace(UUID_PATTERN, '[REDACTED]');
    if (statusCode >= 500) {
      console.error(
        JSON.stringify({
          level: 'error',
          statusCode,
          method: request.method,
          url: request.url,
          error: safeMessage,
          stack: error.stack?.replace(UUID_PATTERN, '[REDACTED]'),
          timestamp: new Date().toISOString(),
        }),
      );
      reply.status(statusCode).send({ error: 'Internal Server Error' });
    } else {
      const clientMessage = clientErrorMessageForStatus(statusCode) ?? 'Bad Request';
      reply.status(statusCode).send({ error: clientMessage });
    }
  });

  app.get('/health', async () => {
    return { status: 'ok' };
  });

  app.register(authRoutes, { config });

  if (billingDeps) {
    app.register(accessGateRoutes, { billingDeps });
    app.register(billingRoutes, { billingDeps });
    app.register(memberRoutes, { billingDeps });
  }

  if (syncDeps) {
    app.register(syncRoutes, { syncDeps });
  }

  return app;
}
