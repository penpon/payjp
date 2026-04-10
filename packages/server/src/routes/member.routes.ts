import type { BillingDeps, DiscordCheckResult } from '@hayane/billing-service';
import { formatRfc3339Utc, isSameOrigin, linkSessionTokenHash, memberSessionTokenHash } from '@hayane/billing-service';
import type { Member } from '@hayane/shared';
import { decryptToken } from '@hayane/shared';
import type { FastifyInstance } from 'fastify';

/** Paid entitlement required to link Discord and grant the paid role (PAY.JP sync). */
function hasActiveSubscriptionForDiscordLink(member: Member): boolean {
  return member.subscription_status === 'active' || member.subscription_status === 'trial';
}

async function tryAssignPaidRoleWithRetries(
  billingDeps: BillingDeps,
  discordUserId: string,
  precheck?: DiscordCheckResult,
): Promise<boolean> {
  const discordCheck =
    precheck ?? (await billingDeps.discord.checkMembership(billingDeps.config.discordGuildId, discordUserId));
  if (!discordCheck.isMember || !discordCheck.canAssignRole) {
    return false;
  }
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
      return true;
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
  return false;
}

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
          memberId: member.id,
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

        // Serialize all link-discord work for this member first. A discord_user_id-only lock
        // lets two concurrent requests (same member, different Discord accounts) take different
        // locks and overwrite each other after passing pre-lock checks.
        const memberLockKey = `member-link:${memberId}`;
        const memberLockAcquired = await billingDeps.db.acquireAdvisoryLock(memberLockKey);
        if (!memberLockAcquired) {
          return reply.status(503).send({ ok: false, errorCode: 'LOCK_UNAVAILABLE' });
        }

        try {
          // Fresh read under member lock
          const member = await billingDeps.db.findMemberById(memberId);
          if (!member) {
            return reply.status(404).send({ ok: false, errorCode: 'MEMBER_NOT_FOUND' });
          }

          // Idempotency: already linked and role already granted
          if (member.discord_user_id === discordUserId && member.role_state === 'granted') {
            await billingDeps.db.consumeLinkSession(lsHash, now);
            return reply.status(200).send({ ok: true, discordUserId, roleGranted: true });
          }

          // Conflict: already linked to different discord user
          if (member.discord_user_id !== null && member.discord_user_id !== discordUserId) {
            return reply.status(409).send({ ok: false, errorCode: 'ALREADY_LINKED' });
          }

          // Check discord_user_id not used by another member
          const existingMember = await billingDeps.db.findMemberByDiscordUserId(discordUserId);
          if (existingMember && existingMember.id !== memberId) {
            return reply.status(409).send({ ok: false, errorCode: 'DISCORD_ALREADY_USED' });
          }

          if (!hasActiveSubscriptionForDiscordLink(member)) {
            return reply.status(403).send({ ok: false, errorCode: 'SUBSCRIPTION_INACTIVE' });
          }

          // Cross-member serialization for the same Discord account (subscribe/cancel use same key)
          const discordLockAcquired = await billingDeps.db.acquireAdvisoryLock(discordUserId);
          if (!discordLockAcquired) {
            return reply.status(503).send({ ok: false, errorCode: 'LOCK_UNAVAILABLE' });
          }

          try {
            // Update discord_user_id
            await billingDeps.db.updateMemberDiscordUserId(memberId, discordUserId);

            // Consume link_session
            await billingDeps.db.consumeLinkSession(lsHash, now);

            // Decrypt access_token for guild join (if available)
            let plainAccessToken: string | undefined;
            if (linkSession.discord_access_token_encrypted && billingDeps.config.discordTokenEncryptionKey) {
              try {
                plainAccessToken = decryptToken(
                  linkSession.discord_access_token_encrypted,
                  billingDeps.config.discordTokenEncryptionKey,
                );
              } catch (decErr) {
                console.error(
                  JSON.stringify({
                    level: 'error',
                    service: 'member-routes',
                    message: 'Failed to decrypt Discord access token',
                    discordUserId,
                    error: decErr instanceof Error ? decErr.message : String(decErr),
                  }),
                );
              }
            }

            // Guild membership check + auto-join + role assignment
            let roleGranted = false;
            try {
              const discordCheck = await billingDeps.discord.checkMembership(
                billingDeps.config.discordGuildId,
                discordUserId,
              );
              if (!discordCheck.isMember && plainAccessToken) {
                // Auto-join guild with role (guilds.join)
                try {
                  const joinResult = await billingDeps.discord.addMemberToGuild(
                    billingDeps.config.discordGuildId,
                    discordUserId,
                    plainAccessToken,
                    billingDeps.config.discordPaidRoleId,
                  );
                  if (joinResult.joinedNew) {
                    roleGranted = true;
                  } else {
                    // 204: user already in guild — roles from body were not applied (race with membership check)
                    roleGranted = await tryAssignPaidRoleWithRetries(billingDeps, discordUserId);
                  }
                } catch (joinErr) {
                  console.error(
                    JSON.stringify({
                      level: 'error',
                      service: 'member-routes',
                      message: 'Discord guild join failed',
                      discordUserId,
                      error: joinErr instanceof Error ? joinErr.message : String(joinErr),
                    }),
                  );
                }
              } else if (discordCheck.isMember && discordCheck.canAssignRole) {
                roleGranted = await tryAssignPaidRoleWithRetries(billingDeps, discordUserId, discordCheck);
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

            // Revoke access_token after use (best-effort)
            if (plainAccessToken) {
              void billingDeps.discord.revokeToken(plainAccessToken).catch(() => {});
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
        } finally {
          try {
            await billingDeps.db.releaseAdvisoryLock(memberLockKey);
          } catch (err) {
            console.error(
              JSON.stringify({
                level: 'error',
                service: 'member-routes',
                message: 'Advisory lock release failed',
                memberLockKey,
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
