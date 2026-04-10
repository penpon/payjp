import type { BillingDeps } from '@hayane/billing-service';
import { formatRfc3339Utc, isSameOrigin, linkSessionTokenHash, memberSessionTokenHash } from '@hayane/billing-service';
import type { FastifyInstance } from 'fastify';

export async function memberRoutes(app: FastifyInstance, opts: { billingDeps: BillingDeps }) {
  const { billingDeps } = opts;

  // GET /v1/members/me — member_session Cookie で member 状態を取得
  app.get('/v1/members/me', { config: { rateLimit: { max: 15, timeWindow: '1 minute' } } }, async (request, reply) => {
    const origin = typeof request.headers.origin === 'string' ? request.headers.origin : '';
    if (origin && !isSameOrigin(origin, billingDeps.config.frontendBaseUrl)) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const memberSessionToken = request.cookies['__Host-member_session'] ?? '';
    if (!memberSessionToken) {
      return reply.status(200).send({ member: null });
    }

    try {
      const now = billingDeps.clock();
      const tokenHash = memberSessionTokenHash(memberSessionToken);
      const session = await billingDeps.db.findMemberSession(tokenHash);
      if (!session || session.expires_at < now) {
        return reply.status(200).send({ member: null });
      }

      const member = await billingDeps.db.findMemberById(session.member_id);
      if (!member) {
        return reply.status(200).send({ member: null });
      }

      return reply.status(200).send({
        member: {
          subscriptionStatus: member.subscription_status,
          planId: member.payjp_plan_id,
          accessEndAt: member.access_end_at ? formatRfc3339Utc(member.access_end_at) : null,
          discordLinked: member.discord_user_id !== null,
        },
      });
    } catch (err) {
      console.error(
        JSON.stringify({
          level: 'error',
          service: 'member-routes',
          message: 'GET /v1/members/me failed',
          error: err instanceof Error ? err.message : String(err),
          timestamp: new Date().toISOString(),
        }),
      );
      return reply.status(503).send({ error: 'Service Unavailable' });
    }
  });

  // POST /v1/members/link-discord — member_session + link_session で Discord 紐付け
  app.post(
    '/v1/members/link-discord',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const origin = typeof request.headers.origin === 'string' ? request.headers.origin : '';
      if (!isSameOrigin(origin, billingDeps.config.frontendBaseUrl)) {
        return reply.status(403).send({ ok: false, errorCode: 'FORBIDDEN_ORIGIN' });
      }

      const memberSessionToken = request.cookies['__Host-member_session'] ?? '';
      const linkSessionToken = request.cookies['__Host-link_session'] ?? '';

      if (!memberSessionToken || !linkSessionToken) {
        return reply.status(401).send({ ok: false, errorCode: 'SESSION_REQUIRED' });
      }

      try {
        const now = billingDeps.clock();

        // Validate member_session
        const msHash = memberSessionTokenHash(memberSessionToken);
        const memberSession = await billingDeps.db.findMemberSession(msHash);
        if (!memberSession || memberSession.expires_at < now) {
          return reply.status(401).send({ ok: false, errorCode: 'INVALID_MEMBER_SESSION' });
        }

        // Validate link_session
        const lsHash = linkSessionTokenHash(linkSessionToken);
        const linkSession = await billingDeps.db.findLinkSession(lsHash);
        if (!linkSession || linkSession.expires_at < now || linkSession.used_at !== null) {
          return reply.status(401).send({ ok: false, errorCode: 'INVALID_LINK_SESSION' });
        }

        const memberId = memberSession.member_id;
        const discordUserId = linkSession.discord_user_id;

        // Check member exists
        const member = await billingDeps.db.findMemberById(memberId);
        if (!member) {
          return reply.status(404).send({ ok: false, errorCode: 'MEMBER_NOT_FOUND' });
        }

        // Idempotency: already linked to same discord user
        if (member.discord_user_id === discordUserId) {
          await billingDeps.db.consumeLinkSession(lsHash, now);
          return reply.status(200).send({ ok: true, discordUserId, roleGranted: member.role_state === 'granted' });
        }

        // Conflict: already linked to different discord user
        if (member.discord_user_id !== null) {
          return reply.status(409).send({ ok: false, errorCode: 'ALREADY_LINKED' });
        }

        // Check discord_user_id not used by another member
        const existingMember = await billingDeps.db.findMemberByDiscordUserId(discordUserId);
        if (existingMember && existingMember.id !== memberId) {
          return reply.status(409).send({ ok: false, errorCode: 'DISCORD_ALREADY_USED' });
        }

        // Advisory lock on discord_user_id
        const lockAcquired = await billingDeps.db.acquireAdvisoryLock(discordUserId);
        if (!lockAcquired) {
          return reply.status(503).send({ ok: false, errorCode: 'LOCK_UNAVAILABLE' });
        }

        try {
          // Update discord_user_id
          await billingDeps.db.updateMemberDiscordUserId(memberId, discordUserId);

          // Consume link_session
          await billingDeps.db.consumeLinkSession(lsHash, now);

          // Guild membership check + role assignment
          let roleGranted = false;
          try {
            const discordCheck = await billingDeps.discord.checkMembership(
              billingDeps.config.discordGuildId,
              discordUserId,
            );
            if (discordCheck.isMember && discordCheck.canAssignRole) {
              // Role assignment with retry (3x: 0s/1s/2s)
              const delays = [0, 1000, 2000];
              for (let attempt = 0; attempt < 3; attempt++) {
                if (delays[attempt] > 0) {
                  await new Promise((r) => setTimeout(r, delays[attempt]));
                }
                try {
                  await billingDeps.discord.assignRole(
                    billingDeps.config.discordGuildId,
                    discordUserId,
                    billingDeps.config.discordPaidRoleId,
                  );
                  roleGranted = true;
                  break;
                } catch (roleErr) {
                  if (attempt === 2) {
                    console.error(
                      JSON.stringify({
                        level: 'error',
                        service: 'member-routes',
                        message: 'Discord role assignment failed after retries',
                        discordUserId,
                        error: roleErr instanceof Error ? roleErr.message : String(roleErr),
                      }),
                    );
                  }
                }
              }
            }
          } catch (discordErr) {
            console.error(
              JSON.stringify({
                level: 'error',
                service: 'member-routes',
                message: 'Discord membership check failed',
                discordUserId,
                error: discordErr instanceof Error ? discordErr.message : String(discordErr),
              }),
            );
          }

          // Update role_state
          if (roleGranted) {
            try {
              await billingDeps.db.updateMemberRoleState(memberId, 'granted');
            } catch {
              // Best-effort
            }
          }

          return reply.status(200).send({ ok: true, discordUserId, roleGranted });
        } finally {
          try {
            await billingDeps.db.releaseAdvisoryLock(discordUserId);
          } catch (err) {
            console.error(
              JSON.stringify({
                level: 'error',
                service: 'member-routes',
                message: 'Advisory lock release failed',
                discordUserId,
                error: err instanceof Error ? err.message : String(err),
              }),
            );
          }
        }
      } catch (err) {
        console.error(
          JSON.stringify({
            level: 'error',
            service: 'member-routes',
            message: 'POST /v1/members/link-discord failed',
            error: err instanceof Error ? err.message : String(err),
            timestamp: new Date().toISOString(),
          }),
        );
        return reply.status(503).send({ ok: false, errorCode: 'INTERNAL_ERROR' });
      }
    },
  );
}
