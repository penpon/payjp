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
    'x-payjp-webhook-token':
      typeof headers['x-payjp-webhook-token'] === 'string' ? headers['x-payjp-webhook-token'] : undefined,
  };
}
