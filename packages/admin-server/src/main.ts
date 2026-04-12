/**
 * Read-only admin API — Phase A (see docs/admin-console-boundary.md).
 * Binds ADMIN_FRONTEND_ORIGIN for CORS; trust Cloudflare Access at the edge.
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

  app.addHook('onRequest', async (request) => {
    const actor =
      request.headers['cf-access-authenticated-user-email'] ?? request.headers['x-admin-audit-actor'] ?? undefined;
    if (typeof actor === 'string' && actor.length > 0) {
      request.log.info({ auditActor: actor, path: request.url }, 'admin request');
    }
  });

  await registerAdminRoutes(app, { pool });

  const port = Number.parseInt(process.env.PORT ?? '3011', 10);
  if (!Number.isFinite(port) || port <= 0) {
    process.stderr.write('[admin-server] PORT must be a positive integer\n');
    process.exit(1);
  }

  await app.listen({ port, host: '0.0.0.0' });
}

void main().catch((err) => {
  console.error('[admin-server]', err);
  process.exit(1);
});
