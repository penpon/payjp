import type { WebhookHandlerDeps, WebhookRequest } from '@hayane/sync-service';
import { handleWebhook } from '@hayane/sync-service';
import type { FastifyInstance } from 'fastify';

export interface SyncDeps {
  webhookDeps: WebhookHandlerDeps;
}

export async function syncRoutes(app: FastifyInstance, opts: { syncDeps: SyncDeps }) {
  const { webhookDeps } = opts.syncDeps;

  app.post(
    '/v1/payjp/webhook',
    { config: { rateLimit: { max: 100, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const req: WebhookRequest = {
        headers: extractWebhookHeaders(request.headers),
        body: request.body,
        remoteIp: request.ip,
      };

      const result = await handleWebhook(req, webhookDeps);
      return reply.status(result.status).send(result.body);
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
