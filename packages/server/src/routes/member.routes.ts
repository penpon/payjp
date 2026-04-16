import type { BillingDeps, DiscordCheckResult } from '@hayane/billing-service';
import { formatRfc3339Utc, isSameOrigin, linkSessionTokenHash, memberSessionTokenHash } from '@hayane/billing-service';
import { buildCookieAttributes, decryptToken, serializeCookieAttributes } from '@hayane/shared';
import { resolveRoleIdForPlan } from '@hayane/sync-service';
import type { FastifyInstance } from 'fastify';
import { isForbiddenCrossSiteFetch } from '../cross-site-fetch.js';

function hasLinkableSubscription(status: string | null): boolean {
  if (status === 'active' || status === 'trial') return true;
  return false;
}

/** Retry delays in ms for Discord role assignment (0 = no delay on first attempt) */
const ROLE_ASSIGN_RETRY_DELAYS_MS = [0, 1000, 2000] as const;
const ROLE_ASSIGN_MAX_ATTEMPTS = ROLE_ASSIGN_RETRY_DELAYS_MS.length;

async function tryAssignPaidRoleWithRetries(
  billingDeps: BillingDeps,
  discordUserId: string,
  roleId: string,
  precheck?: DiscordCheckResult,
): Promise<boolean> {
  const discordCheck =
    precheck ?? (await billingDeps.discord.checkMembership(billingDeps.config.discordGuildId, discordUserId, roleId));
  if (!discordCheck.isMember || !discordCheck.canAssignRole) {
    return false;
  }
  for (let attempt = 0; attempt < ROLE_ASSIGN_MAX_ATTEMPTS; attempt++) {
    const delay = ROLE_ASSIGN_RETRY_DELAYS_MS[attempt];
    if (delay > 0) {
      await new Promise((r) => setTimeout(r, delay));
    }
    try {
      await billingDeps.discord.assignRole(billingDeps.config.discordGuildId, discordUserId, roleId);
      return true;
    } catch (roleErr) {
      const isLastAttempt = attempt === ROLE_ASSIGN_MAX_ATTEMPTS - 1;
      if (isLastAttempt) {
        console.error(
          JSON.stringify({
            level: 'error',
            service: 'member-routes',
            message: 'Discord role assignment failed after retries',
            discordUserId,
            roleId,
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
    // Reject cross-site loads (e.g. <img src> / no-cors) that omit Origin; mirrors GET /v1/subscriptions/status.
    const secFetchSite = typeof request.headers['sec-fetch-site'] === 'string' ? request.headers['sec-fetch-site'] : '';
    if (secFetchSite === 'cross-site') {
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
      if (!session || session.expires_at <= now) {
        // Clear stale cookie to avoid repeated DB lookups
        const clearAttrs = buildCookieAttributes('__Host-member_session', 0);
        reply.header('Set-Cookie', serializeCookieAttributes(clearAttrs, ''));
        return reply.status(200).send({ member: null });
      }

      const member = await billingDeps.db.findMemberById(session.member_id);
      if (!member) {
        const clearAttrs = buildCookieAttributes('__Host-member_session', 0);
        reply.header('Set-Cookie', serializeCookieAttributes(clearAttrs, ''));
        return reply.status(200).send({ member: null });
      }

      return reply.status(200).send({
        member: {
          memberId: member.id,
          subscriptionStatus: member.subscription_status,
          planId: member.payjp_plan_id,
          accessEndAt: member.access_end_at ? formatRfc3339Utc(member.access_end_at) : null,
          discordLinked: member.discord_user_id !== null,
          roleState: member.role_state,
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

      if (isForbiddenCrossSiteFetch(request)) {
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
        if (!memberSession || memberSession.expires_at <= now) {
          return reply.status(401).send({ ok: false, errorCode: 'INVALID_MEMBER_SESSION' });
        }

        // Early validation of link_session (before lock). Full re-validation under lock below.
        const lsHash = linkSessionTokenHash(linkSessionToken);
        const linkSessionPreCheck = await billingDeps.db.findLinkSession(lsHash);
        if (!linkSessionPreCheck || linkSessionPreCheck.expires_at <= now) {
          return reply.status(401).send({ ok: false, errorCode: 'INVALID_LINK_SESSION' });
        }

        const memberId = memberSession.member_id;

        // Serialize all link-discord work for this member first. A discord_user_id-only lock
        // lets two concurrent requests (same member, different Discord accounts) take different
        // locks and overwrite each other after passing pre-lock checks.
        const memberLockKey = `member-link:${memberId}`;
        const memberLockAcquired = await billingDeps.db.acquireAdvisoryLock(memberLockKey);
        if (!memberLockAcquired) {
          return reply.status(503).send({ ok: false, errorCode: 'LOCK_UNAVAILABLE' });
        }

        try {
          // Re-validate link_session under lock to prevent TOCTOU race
          const linkSession = await billingDeps.db.findLinkSession(lsHash);
          if (!linkSession || linkSession.expires_at <= now || linkSession.used_at !== null) {
            return reply.status(401).send({ ok: false, errorCode: 'INVALID_LINK_SESSION' });
          }
          const discordUserId = linkSession.discord_user_id;

          // Fresh read under member lock
          const member = await billingDeps.db.findMemberById(memberId);
          if (!member) {
            return reply.status(404).send({ ok: false, errorCode: 'MEMBER_NOT_FOUND' });
          }

          if (!hasLinkableSubscription(member.subscription_status)) {
            return reply.status(409).send({ ok: false, errorCode: 'NO_SUBSCRIPTION' });
          }

          // Idempotency: already linked and role already granted
          if (member.discord_user_id === discordUserId && member.role_state === 'granted') {
            let plainAccessTokenIdempotent: string | undefined;
            if (linkSession.discord_access_token_encrypted && billingDeps.config.discordTokenEncryptionKey) {
              try {
                plainAccessTokenIdempotent = decryptToken(
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
            try {
              await billingDeps.db.consumeLinkSession(lsHash, now);
            } catch {
              // Already consumed by a concurrent request — idempotent success
            }
            if (plainAccessTokenIdempotent) {
              void billingDeps.discord.revokeToken(plainAccessTokenIdempotent).catch(() => {});
            }
            return reply.status(200).send({ ok: true, discordUserId, roleGranted: true });
          }

          // Conflict: already linked to different discord user
          if (member.discord_user_id !== null && member.discord_user_id !== discordUserId) {
            return reply.status(409).send({ ok: false, errorCode: 'ALREADY_LINKED' });
          }

          // Check discord_user_id not used by another member
          const existingMember = await billingDeps.db.findMemberByDiscordUserId(discordUserId);
          if (existingMember && existingMember.id !== memberId) {
            // active/trial のみブロック。canceled は解約済みなので Discord ID の独占権を手放す
            const s = existingMember.subscription_status;
            if (s === 'active' || s === 'trial') {
              return reply.status(409).send({ ok: false, errorCode: 'DISCORD_ALREADY_USED' });
            }
            // 非アクティブ(canceled/paused/deleted/null): Discord リンクをクリアして転送を許可
            await billingDeps.db.clearMemberDiscordUserId(existingMember.id);
          }

          // Cross-member serialization for the same Discord account (subscribe/cancel use same key)
          const discordLockAcquired = await billingDeps.db.acquireAdvisoryLock(discordUserId);
          if (!discordLockAcquired) {
            return reply.status(503).send({ ok: false, errorCode: 'LOCK_UNAVAILABLE' });
          }

          try {
            // Update discord_user_id
            await billingDeps.db.updateMemberDiscordUserId(memberId, discordUserId);

            // Consume link_session (safe: already validated under lock, but guard against concurrent consume)
            try {
              await billingDeps.db.consumeLinkSession(lsHash, now);
            } catch {
              // Already consumed by a concurrent request — proceed (discord_user_id update already committed)
            }

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
            const memberRoleId = resolveRoleIdForPlan(member.payjp_plan_id, billingDeps.config.planRoleMapping);
            let roleGranted = false;
            if (!memberRoleId) {
              console.warn(
                JSON.stringify({
                  level: 'warn',
                  service: 'member-routes',
                  message: 'No role mapping for plan, skipping role assignment',
                  discordUserId,
                  planId: member.payjp_plan_id,
                }),
              );
            } else {
              try {
                const discordCheck = await billingDeps.discord.checkMembership(
                  billingDeps.config.discordGuildId,
                  discordUserId,
                  memberRoleId,
                );
                if (!discordCheck.isMember && plainAccessToken) {
                  // Auto-join guild with role (guilds.join)
                  try {
                    const joinResult = await billingDeps.discord.addMemberToGuild(
                      billingDeps.config.discordGuildId,
                      discordUserId,
                      plainAccessToken,
                      memberRoleId,
                    );
                    if (joinResult.joinedNew) {
                      roleGranted = true;
                    } else {
                      // 204: user already in guild — roles from body were not applied (race with membership check)
                      roleGranted = await tryAssignPaidRoleWithRetries(billingDeps, discordUserId, memberRoleId);
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
                  roleGranted = await tryAssignPaidRoleWithRetries(
                    billingDeps,
                    discordUserId,
                    memberRoleId,
                    discordCheck,
                  );
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
