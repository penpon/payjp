import type { WebhookHandlerDeps, WebhookRequest } from '@hayane/sync-service';
import { handleWebhook } from '@hayane/sync-service';
import type { FastifyInstance, FastifyRequest } from 'fastify';

export interface SyncDeps {
  webhookDeps: WebhookHandlerDeps;
}

/** Use the TCP peer address for audit logs — not `request.ip`, which follows X-Forwarded-For when trustProxy is enabled. */
function webhookRemoteIp(request: FastifyRequest): string {
  const addr = request.socket?.remoteAddress;
  return typeof addr === 'string' && addr.length > 0 ? addr : '';
}

export async function syncRoutes(app: FastifyInstance, opts: { syncDeps: SyncDeps }) {
  const { webhookDeps } = opts.syncDeps;

  app.post(
    '/v1/payjp/webhook',
    { config: { rateLimit: { max: 100, timeWindow: '1 minute' } } },
    async (request, reply) => {
      try {
        const req: WebhookRequest = {
          headers: extractWebhookHeaders(request.headers),
          body: request.body,
          remoteIp: webhookRemoteIp(request),
        };

        const result = await handleWebhook(req, webhookDeps);
        return reply.status(result.status).send(result.body);
      } catch (err) {
        console.error(
          JSON.stringify({
            level: 'error',
            service: 'sync-routes',
            message: 'webhook handler threw unexpectedly',
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

/**
 * Single value for `X-Payjp-Webhook-Token`. Rejects ambiguous / combined values:
 * - RFC 7230 combines duplicate header fields with ", " — that must not be accepted as one token
 *   (otherwise `expected, guess` can compare equal to `expected` in the HMAC digest step).
 * - Multiple header field lines become `string[]` in Fastify — reject unless exactly one.
 */
function parseSingleWebhookTokenHeader(raw: string | string[] | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const s = Array.isArray(raw) ? (raw.length === 1 ? raw[0] : undefined) : raw;
  if (typeof s !== 'string') return undefined;
  const trimmed = s.trim();
  if (trimmed === '' || trimmed.includes(',')) return undefined;
  return trimmed;
}

function extractWebhookHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | undefined> {
  return {
    'x-payjp-webhook-token': parseSingleWebhookTokenHeader(headers['x-payjp-webhook-token']),
  };
}
