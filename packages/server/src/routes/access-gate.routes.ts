/**
 * Shared passcode gate: session probe + verify (sets __Host-access_gate).
 * Legacy signed invite URLs redirect to the public site root with a hint query param.
 */
import { randomBytes } from 'node:crypto';
import type { BillingDeps } from '@hayane/billing-service';
import { accessGateSessionTokenHash, isSameOrigin, verifySharedPasscode } from '@hayane/billing-service';
import { buildCookieAttributes, serializeCookieAttributes } from '@hayane/shared';
import type { FastifyInstance } from 'fastify';

export async function accessGateRoutes(app: FastifyInstance, opts: { billingDeps: BillingDeps }) {
  const { billingDeps } = opts;

  app.get(
    '/v1/access-gate/session',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const origin = typeof request.headers.origin === 'string' ? request.headers.origin : '';
      if (origin && !isSameOrigin(origin, billingDeps.config.frontendBaseUrl)) {
        return reply.status(403).send({ error: 'Forbidden' });
      }
      if (isForbiddenCrossSiteFetch(request)) {
        return reply.status(403).send({ error: 'Forbidden' });
      }

      const now = billingDeps.clock();
      const code = billingDeps.config.subscribeGateCode ?? '';
      if (!code) {
        return reply.status(200).send({ gateEnforced: false, unlocked: true });
      }

      const raw = request.cookies['__Host-access_gate'] ?? '';
      if (!raw) {
        return reply.status(200).send({ gateEnforced: true, unlocked: false });
      }

      const hash = accessGateSessionTokenHash(raw);
      const ok = await billingDeps.db.findAccessGateSessionByTokenHash(hash, now);
      if (!ok) {
        return reply.status(200).send({ gateEnforced: true, unlocked: false });
      }

      return reply.status(200).send({ gateEnforced: true, unlocked: true });
    },
  );

  app.post(
    '/v1/access-gate/verify',
    {
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          required: ['passcode'],
          properties: {
            passcode: { type: 'string', minLength: 1, maxLength: 512 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const origin = request.headers.origin ?? null;
      if (origin && !isSameOrigin(origin, billingDeps.config.frontendBaseUrl)) {
        return reply.status(403).send({ error: 'Forbidden' });
      }

      // Cross-site fetches that omit Origin (e.g. <img> / no-cors) cannot prove the request
      // came from our frontend. When Origin is present and matches, allow even if
      // Sec-Fetch-Site is `cross-site` (some navigations still send the document Origin).
      const secFetchSite =
        typeof request.headers['sec-fetch-site'] === 'string' ? request.headers['sec-fetch-site'] : '';
      if (secFetchSite === 'cross-site' && !origin) {
        return reply.status(403).send({ error: 'Forbidden' });
      }

      const expected = billingDeps.config.subscribeGateCode ?? '';
      if (!expected) {
        return reply.status(404).send({ error: 'Not Found' });
      }

      const body = request.body as { passcode?: string };
      const submittedRaw = typeof body.passcode === 'string' ? body.passcode : '';
      const submitted = submittedRaw.trim();
      if (!submitted) {
        return reply.status(422).send({
          ok: false,
          errorCode: 'PASSCODE_REQUIRED',
          message: 'passcode is required',
        });
      }

      if (!verifySharedPasscode(submitted, expected)) {
        return reply.status(403).send({
          ok: false,
          errorCode: 'INVALID_GATE_PASSCODE',
          message: 'Invalid passcode',
        });
      }

      const now = billingDeps.clock();
      const rawSession = randomBytes(32).toString('hex');
      const sessionHash = accessGateSessionTokenHash(rawSession);
      const ttl = billingDeps.config.accessGateSessionTtlSeconds;
      const sessionExpires = new Date(now.getTime() + ttl * 1000);

      try {
        await billingDeps.db.insertAccessGateSession({
          accessGateSessionTokenHash: sessionHash,
          expiresAt: sessionExpires,
        });
      } catch {
        return reply.status(503).send({
          ok: false,
          errorCode: 'DB_ERROR',
          message: 'Failed to create access gate session',
        });
      }

      const attrs = buildCookieAttributes('__Host-access_gate', ttl);
      reply.header('Set-Cookie', serializeCookieAttributes(attrs, rawSession));
      return reply.status(200).send({ ok: true });
    },
  );

  /** @deprecated Per-user signed invites — redirect to site root (passcode gate). */
  app.get(
    '/v1/invites/accept',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (_request, reply) => {
      const base = billingDeps.config.frontendBaseUrl;
      const u = new URL(`${base}/`);
      u.searchParams.set('gate', 'renewed');
      return reply.redirect(u.toString(), 302);
    },
  );
}
