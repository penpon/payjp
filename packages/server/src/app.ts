import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import type { BillingDeps } from '@hayane/billing-service';
import Fastify, { type FastifyError } from 'fastify';
import { authRoutes } from './routes/auth.routes.js';
import { billingRoutes } from './routes/billing.routes.js';
import type { SyncDeps } from './routes/sync.routes.js';
import { syncRoutes } from './routes/sync.routes.js';

export interface AppConfig {
  readonly frontendBaseUrl: string;
  readonly discordClientId: string;
  readonly discordClientSecret: string;
  readonly discordRedirectUri: string;
}

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export function buildApp(config: AppConfig, billingDeps?: BillingDeps, syncDeps?: SyncDeps) {
  const app = Fastify({ logger: false });

  app.register(fastifyCookie);
  // REQ-AUTH-008: Origin validation is primarily handled by auth-service's isSameOrigin.
  // @fastify/cors manages CORS header injection; it does not block non-preflight GETs.
  app.register(fastifyCors, {
    origin: config.frontendBaseUrl,
    credentials: true,
  });

  app.addHook('onSend', (_request, reply, payload, done) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('Referrer-Policy', 'no-referrer');
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
          timestamp: new Date().toISOString(),
        }),
      );
      reply.status(statusCode).send({ error: 'Internal Server Error' });
    } else {
      reply.status(statusCode).send({ error: safeMessage });
    }
  });

  app.get('/health', async () => {
    return { status: 'ok' };
  });

  app.register(authRoutes, { config });

  if (billingDeps) {
    app.register(billingRoutes, { billingDeps });
  }

  if (syncDeps) {
    app.register(syncRoutes, { syncDeps });
  }

  return app;
}
