/**
 * Read-only admin API — Phase A (see docs/admin-console-boundary.md).
 * Binds ADMIN_FRONTEND_ORIGIN for CORS and enforces request identity headers.
 */
import cors from '@fastify/cors';
import { createPool, runMigrations } from '@hayane/shared';
import Fastify from 'fastify';
import { registerAdminRoutes } from './routes.js';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const frontendOrigin = process.env.ADMIN_FRONTEND_ORIGIN?.trim();
  if (!databaseUrl) {
    process.stderr.write('[admin-server] DATABASE_URL is required\n');
    process.exit(1);
  }
  if (!frontendOrigin) {
    process.stderr.write('[admin-server] ADMIN_FRONTEND_ORIGIN is required (e.g. https://admin.and--line.com)\n');
    process.exit(1);
  }

  const sslDisabled = databaseUrl.includes('sslmode=disable');
  const pool = createPool(databaseUrl, sslDisabled ? { ssl: false } : undefined);
  await runMigrations(pool);

  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
  });

  await app.register(cors, {
    origin: frontendOrigin,
    credentials: true,
  });

  // Security headers on every response (parity with packages/server/src/app.ts)
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    reply.header('X-Frame-Options', 'DENY');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
    reply.header('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');
    return payload;
  });

  await registerAdminRoutes(app, { pool });

  const port = Number.parseInt(process.env.PORT ?? '3011', 10);
  if (!Number.isFinite(port) || port <= 0) {
    process.stderr.write('[admin-server] PORT must be a positive integer\n');
    process.exit(1);
  }

  // bind to 0.0.0.0 inside the container: reachable only via the `admin-frontend` docker network.
  // docker-compose.yml publishes nothing to the host (`expose: 3011`, no `ports:`), and nginx is
  // the sole ingress via cloudflared tunnel at 127.0.0.1:8443. Switching to '127.0.0.1' would cut
  // off nginx → admin-api traffic inside docker networking.
  await app.listen({ port, host: '0.0.0.0' });
}

void main().catch((err) => {
  console.error('[admin-server]', err);
  process.exit(1);
});
