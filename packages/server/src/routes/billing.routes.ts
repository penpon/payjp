import type {
  BillingDeps,
  CancelFormLinkRequest,
  CancelRequest,
  GoogleCancelSubmitRequest,
  SubscribeRequest,
} from '@hayane/billing-service';
import {
  formatRfc3339Utc,
  handleCancel,
  handleCreateCancelFormLink,
  handleGoogleCancelSubmit,
  handleSubscribe,
  hasActiveSubscription,
  isSameOrigin,
  linkSessionTokenHash,
  memberSessionTokenHash,
} from '@hayane/billing-service';
import type { Member } from '@hayane/shared';
import { buildCookieAttributes, serializeCookieAttributes } from '@hayane/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isForbiddenCrossSiteFetch } from '../cross-site-fetch.js';

function extractRequestContext(request: FastifyRequest): {
  body: Record<string, unknown> | null;
  origin: string;
  linkSessionToken: string;
  memberSessionToken: string;
  accessGateSessionToken: string;
} {
  return {
    body: request.body as Record<string, unknown> | null,
    origin: typeof request.headers.origin === 'string' ? request.headers.origin : '',
    linkSessionToken: request.cookies['__Host-link_session'] ?? '',
    memberSessionToken: request.cookies['__Host-member_session'] ?? '',
    accessGateSessionToken: request.cookies['__Host-access_gate'] ?? '',
  };
}

/** Same entitlement rule as subscribe / sync: active/trial, or canceled until access_end_at. */
function subscriptionStatusBodyForMember(
  member: Member,
  now: Date,
):
  | { subscription: null }
  | { subscription: { status: string; planId: string | null; accessEndAt: string | null } }
  | null {
  if (!member.subscription_status || member.subscription_status === 'deleted') {
    return null;
  }
  if (!hasActiveSubscription(member.subscription_status, member.access_end_at, now)) {
    return { subscription: null };
  }
  return {
    subscription: {
      status: member.subscription_status,
      planId: member.payjp_plan_id,
      accessEndAt: member.access_end_at ? formatRfc3339Utc(member.access_end_at) : null,
    },
  };
}

export async function billingRoutes(app: FastifyInstance, opts: { billingDeps: BillingDeps }) {
  const { billingDeps } = opts;

  app.post(
    '/v1/subscriptions',
    {
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          required: ['planId', 'email', 'payjpToken', 'privacyConsented'],
          properties: {
            planId: { type: 'string', minLength: 1, maxLength: 50 },
            email: { type: 'string', minLength: 1, maxLength: 254 },
            payjpToken: { type: 'string', minLength: 1, maxLength: 100 },
            privacyConsented: { type: 'boolean' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      if (isForbiddenCrossSiteFetch(request)) {
        return sendBillingResponse(reply, {
          ok: false,
          statusCode: 403,
          errorCode: 'FORBIDDEN_ORIGIN',
          message: 'Cross-site fetch is not allowed',
        });
      }

      const { body, origin, linkSessionToken, accessGateSessionToken } = extractRequestContext(request);

      const req: SubscribeRequest = {
        origin,
        email: typeof body?.email === 'string' ? body.email : '',
        payjpToken: typeof body?.payjpToken === 'string' ? body.payjpToken : '',
        planId: typeof body?.planId === 'string' ? body.planId : '',
        privacyConsented: body?.privacyConsented === true,
        linkSessionToken,
        accessGateSessionToken,
      };

      try {
        const result = await handleSubscribe(req, billingDeps);
        // Issue __Host-member_session cookie on successful subscribe
        if (result.ok && result.memberSessionToken) {
          const attrs = buildCookieAttributes('__Host-member_session', 86400);
          reply.header('Set-Cookie', serializeCookieAttributes(attrs, result.memberSessionToken));
        }
        return sendBillingResponse(reply, result);
      } catch (err) {
        console.error(
          JSON.stringify({
            level: 'error',
            service: 'billing-routes',
            message: 'subscribe handler threw unexpectedly',
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
            timestamp: new Date().toISOString(),
          }),
        );
        return sendBillingResponse(reply, {
          ok: false,
          statusCode: 503,
          errorCode: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred',
        });
      }
    },
  );

  app.get(
    '/v1/subscriptions/status',
    { config: { rateLimit: { max: 15, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const origin = typeof request.headers.origin === 'string' ? request.headers.origin : '';
      // Same-origin GET requests may omit Origin in browsers.
      if (origin && !isSameOrigin(origin, billingDeps.config.frontendBaseUrl)) {
        return sendBillingResponse(reply, {
          ok: false,
          statusCode: 403,
          errorCode: 'FORBIDDEN_ORIGIN',
          message: 'Origin not allowed',
        });
      }
      // Reject cross-site fetches even when Origin is absent (img/script/no-cors).
      // Browsers set Sec-Fetch-Site to `cross-site` for such loads; legitimate same-origin
      // navigations/fetches send `same-origin` or `same-site`. curl/server-side callers omit it.
      if (isForbiddenCrossSiteFetch(request)) {
        return sendBillingResponse(reply, {
          ok: false,
          statusCode: 403,
          errorCode: 'FORBIDDEN_ORIGIN',
          message: 'Cross-site fetch is not allowed',
        });
      }

      try {
        const now = billingDeps.clock();

        // Prefer member_session (post-subscribe member cookie), then link_session fallback
        const memberSessionToken = request.cookies['__Host-member_session'] ?? '';
        if (memberSessionToken) {
          const msHash = memberSessionTokenHash(memberSessionToken);
          const ms = await billingDeps.db.findMemberSession(msHash);
          if (ms && ms.expires_at > now) {
            const member = await billingDeps.db.findMemberById(ms.member_id);
            if (member) {
              const body = subscriptionStatusBodyForMember(member, now);
              return reply.status(200).send(body ?? { subscription: null });
            }
          }
        }

        // Fallback: link_session (cancel flow / legacy)
        const linkSessionToken = request.cookies['__Host-link_session'] ?? '';
        if (linkSessionToken) {
          const tokenHash = linkSessionTokenHash(linkSessionToken);
          const linkSession = await billingDeps.db.findLinkSession(tokenHash);
          if (linkSession && linkSession.expires_at > now) {
            const member = await billingDeps.db.findMemberByDiscordUserId(linkSession.discord_user_id);
            if (member) {
              const body = subscriptionStatusBodyForMember(member, now);
              if (body !== null) {
                return reply.status(200).send(body);
              }
            }
          }
        }

        return reply.status(200).send({ subscription: null });
      } catch (err) {
        console.error(
          JSON.stringify({
            level: 'error',
            service: 'billing-routes',
            message: 'subscription status lookup failed',
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
            timestamp: new Date().toISOString(),
          }),
        );
        return sendBillingResponse(reply, {
          ok: false,
          statusCode: 503,
          errorCode: 'STATUS_UNAVAILABLE',
          message: 'Could not load subscription status',
        });
      }
    },
  );

  app.post(
    '/v1/subscriptions/cancel/google-form-link',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (isForbiddenCrossSiteFetch(request)) {
        return sendBillingResponse(reply, {
          ok: false,
          statusCode: 403,
          errorCode: 'FORBIDDEN_ORIGIN',
          message: 'Cross-site fetch is not allowed',
        });
      }

      const { origin, memberSessionToken } = extractRequestContext(request);
      // Browser POSTs from the configured frontend always send Origin; require it so
      // cookie-authenticated flows cannot be driven by non-browser clients without a forged header.
      if (origin === '') {
        return sendBillingResponse(reply, {
          ok: false,
          statusCode: 403,
          errorCode: 'FORBIDDEN_ORIGIN',
          message: 'Origin not allowed',
        });
      }

      const req: CancelFormLinkRequest = {
        origin,
        memberSessionToken,
      };

      try {
        const result = await handleCreateCancelFormLink(req, billingDeps);
        return sendBillingResponse(reply, result);
      } catch (err) {
        console.error(
          JSON.stringify({
            level: 'error',
            service: 'billing-routes',
            message: 'cancel google-form-link handler threw unexpectedly',
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
            timestamp: new Date().toISOString(),
          }),
        );
        return sendBillingResponse(reply, {
          ok: false,
          statusCode: 503,
          errorCode: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred',
        });
      }
    },
  );

  app.post(
    '/v1/subscriptions/cancel/google-submit',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          required: ['email', 'name', 'reason', 'token'],
          properties: {
            email: { type: 'string', minLength: 1, maxLength: 254 },
            name: { type: 'string', maxLength: 200 },
            reason: { type: 'string', maxLength: 5000 },
            token: { type: 'string', minLength: 1, maxLength: 4096 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      if (isForbiddenCrossSiteFetch(request)) {
        return sendBillingResponse(reply, {
          ok: false,
          statusCode: 403,
          errorCode: 'FORBIDDEN_ORIGIN',
          message: 'Cross-site fetch is not allowed',
        });
      }

      const { body } = extractRequestContext(request);

      const h = request.headers;
      const sharedSecret =
        typeof h['x-cancel-secret'] === 'string'
          ? h['x-cancel-secret']
          : typeof h['x-google-cancel-secret'] === 'string'
            ? h['x-google-cancel-secret']
            : '';
      const signature = typeof h['x-cancel-signature'] === 'string' ? h['x-cancel-signature'] : '';

      const req: GoogleCancelSubmitRequest = {
        email: typeof body?.email === 'string' ? body.email : '',
        name: typeof body?.name === 'string' ? body.name : '',
        reason: typeof body?.reason === 'string' ? body.reason : '',
        token: typeof body?.token === 'string' ? body.token : '',
        secret: sharedSecret,
        signature,
      };

      try {
        const result = await handleGoogleCancelSubmit(req, billingDeps);
        return sendBillingResponse(reply, result);
      } catch (err) {
        console.error(
          JSON.stringify({
            level: 'error',
            service: 'billing-routes',
            message: 'cancel google-submit handler threw unexpectedly',
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
            timestamp: new Date().toISOString(),
          }),
        );
        return sendBillingResponse(reply, {
          ok: false,
          statusCode: 503,
          errorCode: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred',
        });
      }
    },
  );

  app.post(
    '/v1/subscriptions/cancel',
    {
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      if (isForbiddenCrossSiteFetch(request)) {
        return sendBillingResponse(reply, {
          ok: false,
          statusCode: 403,
          errorCode: 'FORBIDDEN_ORIGIN',
          message: 'Cross-site fetch is not allowed',
        });
      }

      const { origin, linkSessionToken } = extractRequestContext(request);
      if (origin === '') {
        return sendBillingResponse(reply, {
          ok: false,
          statusCode: 403,
          errorCode: 'FORBIDDEN_ORIGIN',
          message: 'Origin not allowed',
        });
      }

      const req: CancelRequest = {
        origin,
        linkSessionToken,
      };

      try {
        const result = await handleCancel(req, billingDeps);
        return sendBillingResponse(reply, result);
      } catch (err) {
        console.error(
          JSON.stringify({
            level: 'error',
            service: 'billing-routes',
            message: 'cancel handler threw unexpectedly',
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
            timestamp: new Date().toISOString(),
          }),
        );
        return sendBillingResponse(reply, {
          ok: false,
          statusCode: 503,
          errorCode: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred',
        });
      }
    },
  );
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
