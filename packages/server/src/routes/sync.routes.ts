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

function extractWebhookHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | undefined> {
  return {
    'x-payjp-webhook-token': firstHeaderValue(headers, 'x-payjp-webhook-token'),
  };
}

/**
 * Fastify may represent duplicate headers as `string[]`. A single string or one-element array is
 * unambiguous; multiple elements are rejected (must not skip authentication).
 */
function firstHeaderValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const v = headers[name];
  if (typeof v === 'string') {
    const t = v.trim();
    return t === '' ? undefined : t;
  }
  if (Array.isArray(v)) {
    if (v.length !== 1) return undefined;
    const item = v[0];
    if (typeof item !== 'string') return undefined;
    const t = item.trim();
    return t === '' ? undefined : t;
  }
  return undefined;
}
