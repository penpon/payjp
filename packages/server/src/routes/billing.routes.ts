import type { BillingDeps, CancelRequest, SubscribeRequest } from '@hayane/billing-service';
import { formatRfc3339Utc, handleCancel, handleSubscribe, linkSessionTokenHash } from '@hayane/billing-service';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/** Cookie attributes matching __Host- prefix requirements (§6 fixed) */
const CLEAR_LINK_SESSION_COOKIE = {
  path: '/' as const,
  secure: true,
  httpOnly: true,
  sameSite: 'lax' as const,
  maxAge: 0,
};

function extractRequestContext(request: FastifyRequest): {
  body: Record<string, string> | null;
  origin: string;
  linkSessionToken: string;
} {
  return {
    body: request.body as Record<string, string> | null,
    origin: typeof request.headers.origin === 'string' ? request.headers.origin : '',
    linkSessionToken: request.cookies['__Host-link_session'] ?? '',
  };
}

export async function billingRoutes(app: FastifyInstance, opts: { billingDeps: BillingDeps }) {
  const { billingDeps } = opts;

  app.post('/v1/subscriptions', async (request, reply) => {
    const { body, origin, linkSessionToken } = extractRequestContext(request);

    const req: SubscribeRequest = {
      origin,
      linkSessionToken,
      discordUserId: body?.discordUserId ?? '',
      email: body?.email ?? '',
      payjpToken: body?.payjpToken ?? '',
      planId: body?.planId ?? '',
    };

    const result = await handleSubscribe(req, billingDeps);
    if (result.ok) {
      reply.setCookie('__Host-link_session', '', CLEAR_LINK_SESSION_COOKIE);
    }
    return sendBillingResponse(reply, result);
  });

  app.get('/v1/subscriptions/status', async (request, reply) => {
    const linkSessionToken = request.cookies['__Host-link_session'] ?? '';
    if (!linkSessionToken) {
      return reply.status(200).send({ subscription: null });
    }

    try {
      const now = billingDeps.clock();
      const tokenHash = linkSessionTokenHash(linkSessionToken);
      const linkSession = await billingDeps.db.findLinkSession(tokenHash);
      if (!linkSession) {
        return reply.status(200).send({ subscription: null });
      }
      if (linkSession.expires_at < now) {
        return reply.status(200).send({ subscription: null });
      }
      if (linkSession.used_at !== null) {
        return reply.status(200).send({ subscription: null });
      }

      const member = await billingDeps.db.findMemberByDiscordUserId(linkSession.discord_user_id);
      if (!member?.subscription_status || member.subscription_status === 'deleted') {
        return reply.status(200).send({ subscription: null });
      }

      return reply.status(200).send({
        subscription: {
          status: member.subscription_status,
          planId: member.payjp_plan_id,
          accessEndAt: member.access_end_at ? formatRfc3339Utc(member.access_end_at) : null,
        },
      });
    } catch (err) {
      request.log.error({ err }, 'subscription status lookup failed');
      return reply.status(503).send({
        ok: false,
        errorCode: 'STATUS_UNAVAILABLE',
        message: 'Could not load subscription status',
      });
    }
  });

  app.post('/v1/subscriptions/cancel', async (request, reply) => {
    const { body, origin, linkSessionToken } = extractRequestContext(request);

    const req: CancelRequest = {
      origin,
      linkSessionToken,
      discordUserId: body?.discordUserId ?? '',
    };

    const result = await handleCancel(req, billingDeps);
    if (result.ok) {
      reply.setCookie('__Host-link_session', '', CLEAR_LINK_SESSION_COOKIE);
    }
    return sendBillingResponse(reply, result);
  });
}

function sendBillingResponse(
  reply: FastifyReply,
  result:
    | { ok: true; data: unknown }
    | { ok: false; statusCode: number; errorCode: string; message: string; operationId?: string },
) {
  if (result.ok) {
    return reply.status(200).send(result.data);
  }
  const body: Record<string, unknown> = {
    ok: false,
    errorCode: result.errorCode,
    message: result.message,
  };
  if (result.operationId) {
    body.operationId = result.operationId;
  }
  return reply.status(result.statusCode).send(body);
}
