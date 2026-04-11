/**
 * Cancel Orchestration
 *
 * - Browser legacy path: POST /v1/subscriptions/cancel
 * - Google Form path: POST /v1/subscriptions/cancel/google-form-link
 * - Apps Script callback: POST /v1/subscriptions/cancel/google-submit
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Member } from '@hayane/shared';
import {
  buildCancelFormLinkResponse,
  buildCancelResponse,
  buildGoogleFormPrefillUrl,
  createSignedCancelFormToken,
  hasActiveSubscription,
  hasCancelableSubscription,
  hasInflightOperation,
  isSameOrigin,
  linkSessionTokenHash,
  memberSessionTokenHash,
  normalizeEmail,
  verifySignedCancelFormToken,
} from '../core/index.js';
import { isUncertainError } from './errors.js';
import type {
  BillingDeps,
  CancelFormLinkRequest,
  CancelFormLinkResult,
  CancelRequest,
  CancelResult,
  GoogleCancelSubmitRequest,
  OperationError,
} from './types.js';

const ROLE_SYNC_RETRY_DELAYS_MS = [0, 1000, 2000] as const;

function slog(level: 'info' | 'warn' | 'error', message: string, ctx: Record<string, unknown> = {}): void {
  console[level](JSON.stringify({ level, service: 'billing-cancel', message, ...ctx }));
}

function secureCompare(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}

function uniqueRoleIds(roleMapping: Record<string, string>): string[] {
  return [...new Set(Object.values(roleMapping).filter((roleId) => roleId.length > 0))];
}

function resolveRoleIdsForRevocation(member: Member, deps: BillingDeps): string[] {
  if (member.payjp_plan_id) {
    const mapped = deps.config.planRoleMapping[member.payjp_plan_id];
    if (mapped) return [mapped];
  }
  return uniqueRoleIds(deps.config.planRoleMapping);
}

function cancelLockKey(member: Member, fallbackDiscordUserId?: string): string {
  return member.discord_user_id ?? fallbackDiscordUserId ?? member.id;
}

async function delay(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function markRoleStateUnknown(deps: BillingDeps, memberId: string, ctx: Record<string, unknown>): Promise<void> {
  try {
    await deps.db.updateMemberRoleState(memberId, 'unknown');
  } catch (dbErr) {
    slog('error', 'Failed to persist unknown role state after revoke failure', {
      ...ctx,
      error: String(dbErr),
    });
  }
}

async function revokeDiscordRolesImmediately(
  member: Member,
  deps: BillingDeps,
  ctx: { operationId?: string; flow: 'browser' | 'google-submit' },
): Promise<OperationError | null> {
  if (!member.discord_user_id) {
    try {
      await deps.db.updateMemberRoleState(member.id, 'revoked');
      return null;
    } catch (err) {
      slog('error', 'Failed to persist revoked role state for unlinked member', {
        memberId: member.id,
        flow: ctx.flow,
        operationId: ctx.operationId,
        error: String(err),
      });
      return {
        ok: false,
        statusCode: 503,
        errorCode: 'DB_UPDATE_FAILED',
        message: 'Failed to finalize cancel state',
        operationId: ctx.operationId,
      };
    }
  }

  const roleIds = resolveRoleIdsForRevocation(member, deps);
  for (const roleId of roleIds) {
    let success = false;
    for (const retryDelayMs of ROLE_SYNC_RETRY_DELAYS_MS) {
      await delay(retryDelayMs);
      try {
        await deps.discord.removeRole(deps.config.discordGuildId, member.discord_user_id, roleId);
        success = true;
        break;
      } catch (err) {
        const isLastAttempt = retryDelayMs === ROLE_SYNC_RETRY_DELAYS_MS[ROLE_SYNC_RETRY_DELAYS_MS.length - 1];
        if (isLastAttempt) {
          slog('error', 'Discord role revoke failed after retries', {
            memberId: member.id,
            discordUserId: member.discord_user_id,
            roleId,
            flow: ctx.flow,
            operationId: ctx.operationId,
            error: String(err),
          });
        }
      }
    }

    if (!success) {
      await markRoleStateUnknown(deps, member.id, {
        memberId: member.id,
        discordUserId: member.discord_user_id,
        roleId,
        flow: ctx.flow,
        operationId: ctx.operationId,
      });
      return {
        ok: false,
        statusCode: 503,
        errorCode: 'ROLE_REVOKE_FAILED',
        message: 'Discord role removal failed',
        operationId: ctx.operationId,
      };
    }
  }

  try {
    await deps.db.updateMemberRoleState(member.id, 'revoked');
  } catch (err) {
    slog('error', 'Failed to persist revoked role state after successful revoke', {
      memberId: member.id,
      discordUserId: member.discord_user_id,
      flow: ctx.flow,
      operationId: ctx.operationId,
      error: String(err),
    });
    return {
      ok: false,
      statusCode: 503,
      errorCode: 'DB_UPDATE_FAILED',
      message: 'Failed to finalize cancel state',
      operationId: ctx.operationId,
    };
  }

  return null;
}

async function applyImmediateCancelState(
  member: Member,
  deps: BillingDeps,
  now: Date,
): Promise<{ member: Member; operationId?: string } | OperationError> {
  if (!hasCancelableSubscription(member.subscription_status)) {
    return { ok: false, statusCode: 409, errorCode: 'NO_SUBSCRIPTION', message: 'No cancelable subscription found' };
  }

  if (hasInflightOperation(member.inflight_operation_id)) {
    return {
      ok: false,
      statusCode: 503,
      errorCode: 'INFLIGHT_OPERATION',
      message: 'Another operation is in progress',
      operationId: member.inflight_operation_id,
    };
  }

  if (member.cancel_requested_at !== null) {
    if (member.subscription_status !== 'canceled' || member.access_end_at === null || member.access_end_at > now) {
      try {
        const normalizedMember = await deps.db.updateMemberAfterCancel(member.id, {
          cancel_requested_at: member.cancel_requested_at,
          subscription_status: 'canceled',
          access_end_at: now,
          next_billing_at: member.next_billing_at ?? member.access_end_at,
          inflight_operation_id: null,
          inflight_operation_type: null,
          inflight_operation_started_at: null,
        });
        return { member: normalizedMember };
      } catch (err) {
        slog('error', 'Failed to normalize already-canceled member state', {
          memberId: member.id,
          error: String(err),
        });
        return {
          ok: false,
          statusCode: 503,
          errorCode: 'DB_UPDATE_FAILED',
          message: 'Failed to normalize cancel state',
        };
      }
    }
    return { member };
  }

  if (member.payjp_subscription_id === null) {
    return {
      ok: false,
      statusCode: 409,
      errorCode: 'NO_PAYJP_SUBSCRIPTION',
      message: 'payjp_subscription_id is null',
    };
  }

  const operationId = deps.generateOperationId();
  await deps.db.setInflightOperation(member.id, operationId, 'cancel', now);

  let canceledSubscription: Awaited<ReturnType<typeof deps.payjp.cancelSubscription>>;
  try {
    canceledSubscription = await deps.payjp.cancelSubscription(member.payjp_subscription_id);
  } catch (err) {
    if (isUncertainError(err)) {
      slog('error', 'PAY.JP cancelSubscription uncertain failure', {
        memberId: member.id,
        discordUserId: member.discord_user_id,
        operationId,
        error: String(err),
      });
      return {
        ok: false,
        statusCode: 503,
        errorCode: 'PAYJP_UNCERTAIN',
        message: 'Uncertain failure during cancel',
        operationId,
      };
    }

    slog('error', 'PAY.JP cancelSubscription definite failure, attempting reconciliation', {
      memberId: member.id,
      discordUserId: member.discord_user_id,
      operationId,
      error: String(err),
    });
    try {
      const refetched = await deps.payjp.fetchSubscription(member.payjp_subscription_id);
      if (refetched.status !== 'canceled') {
        try {
          await deps.db.clearInflightOperation(member.id);
        } catch (clearErr) {
          slog('error', 'clearInflightOperation failed after definite cancel failure', {
            memberId: member.id,
            operationId,
            error: String(clearErr),
          });
        }
        return {
          ok: false,
          statusCode: 422,
          errorCode: 'PAYJP_CANCEL_FAILED',
          message: 'Cancel not applied (confirmed by reconciliation)',
          operationId,
        };
      }
      canceledSubscription = refetched;
    } catch (reconcileErr) {
      slog('error', 'PAY.JP cancel reconciliation failed', {
        memberId: member.id,
        operationId,
        reconcileErr: String(reconcileErr),
        originalErr: String(err),
      });
      return {
        ok: false,
        statusCode: 503,
        errorCode: 'PAYJP_UNCERTAIN',
        message: 'Reconciliation failed after cancel failure',
        operationId,
      };
    }
  }

  const nextBillingAt =
    canceledSubscription.current_period_end != null && canceledSubscription.current_period_end !== 0
      ? new Date(canceledSubscription.current_period_end * 1000)
      : member.next_billing_at;

  try {
    const updatedMember = await deps.db.updateMemberAfterCancel(member.id, {
      cancel_requested_at: now,
      subscription_status: 'canceled',
      access_end_at: now,
      next_billing_at: nextBillingAt,
      inflight_operation_id: null,
      inflight_operation_type: null,
      inflight_operation_started_at: null,
    });
    return { member: updatedMember, operationId };
  } catch (err) {
    slog('error', 'DB update failed after PAY.JP cancel', {
      memberId: member.id,
      discordUserId: member.discord_user_id,
      operationId,
      error: String(err),
    });
    return {
      ok: false,
      statusCode: 503,
      errorCode: 'DB_UPDATE_FAILED',
      message: 'DB update failed after PAY.JP cancel',
      operationId,
    };
  }
}

async function finalizeImmediateCancel(
  member: Member,
  deps: BillingDeps,
  ctx: {
    flow: 'browser' | 'google-submit';
    operationId?: string;
    finalizeSuccess?: () => Promise<void>;
  },
): Promise<CancelResult> {
  const roleSyncResult = await revokeDiscordRolesImmediately(member, deps, {
    operationId: ctx.operationId,
    flow: ctx.flow,
  });
  if (roleSyncResult) {
    return roleSyncResult;
  }

  if (ctx.finalizeSuccess) {
    try {
      await ctx.finalizeSuccess();
    } catch (err) {
      slog('error', 'Finalize-after-success step failed', {
        memberId: member.id,
        flow: ctx.flow,
        operationId: ctx.operationId,
        error: String(err),
      });
      return {
        ok: false,
        statusCode: 503,
        errorCode: 'DB_UPDATE_FAILED',
        message: 'Failed to finalize cancel state',
        operationId: ctx.operationId,
      };
    }
  }

  return { ok: true, data: buildCancelResponse(member) };
}

export async function handleCreateCancelFormLink(
  req: CancelFormLinkRequest,
  deps: BillingDeps,
): Promise<CancelFormLinkResult> {
  const now = deps.clock();

  if (!isSameOrigin(req.origin, deps.config.frontendBaseUrl)) {
    return { ok: false, statusCode: 403, errorCode: 'FORBIDDEN_ORIGIN', message: 'Origin not allowed' };
  }

  const sessionToken = req.memberSessionToken.trim();
  if (!sessionToken) {
    return { ok: false, statusCode: 401, errorCode: 'INVALID_MEMBER_SESSION', message: 'Member session not found' };
  }

  const session = await deps.db.findMemberSession(memberSessionTokenHash(sessionToken));
  if (!session) {
    return { ok: false, statusCode: 401, errorCode: 'INVALID_MEMBER_SESSION', message: 'Member session not found' };
  }
  if (session.expires_at <= now) {
    return { ok: false, statusCode: 401, errorCode: 'EXPIRED_MEMBER_SESSION', message: 'Member session expired' };
  }

  const member = await deps.db.findMemberById(session.member_id);
  if (!member || !hasActiveSubscription(member.subscription_status, member.access_end_at, now)) {
    return { ok: false, statusCode: 409, errorCode: 'NO_SUBSCRIPTION', message: 'No active subscription found' };
  }
  if (hasInflightOperation(member.inflight_operation_id)) {
    return {
      ok: false,
      statusCode: 503,
      errorCode: 'INFLIGHT_OPERATION',
      message: 'Another operation is in progress',
      operationId: member.inflight_operation_id,
    };
  }

  const tokenId = randomUUID();
  const expiresAt = new Date(now.getTime() + deps.config.googleFormCancelTokenTtlSeconds * 1000);
  const normalizedEmail = normalizeEmail(member.email);
  const token = createSignedCancelFormToken(
    {
      jti: tokenId,
      memberId: member.id,
      email: normalizedEmail,
      exp: Math.floor(expiresAt.getTime() / 1000),
      nonce: randomBytes(16).toString('base64url'),
    },
    deps.config.googleFormCancelTokenSecret,
  );

  try {
    await deps.db.insertCancelFormToken({
      id: tokenId,
      memberId: member.id,
      email: normalizedEmail,
      expiresAt,
    });
  } catch (err) {
    slog('error', 'Failed to persist cancel form token', {
      memberId: member.id,
      error: String(err),
    });
    return {
      ok: false,
      statusCode: 503,
      errorCode: 'DB_UPDATE_FAILED',
      message: 'Failed to prepare cancel form link',
    };
  }

  const formUrl = buildGoogleFormPrefillUrl(
    deps.config.googleFormCancelBaseUrl,
    deps.config.googleFormCancelEmailEntryId,
    deps.config.googleFormCancelTokenEntryId,
    normalizedEmail,
    token,
  );
  return { ok: true, data: buildCancelFormLinkResponse(formUrl, expiresAt) };
}

export async function handleGoogleCancelSubmit(
  req: GoogleCancelSubmitRequest,
  deps: BillingDeps,
): Promise<CancelResult> {
  const now = deps.clock();

  if (!secureCompare(req.secret, deps.config.googleFormCancelSecret)) {
    return { ok: false, statusCode: 401, errorCode: 'INVALID_GOOGLE_SECRET', message: 'Invalid Google secret' };
  }

  const verifiedToken = verifySignedCancelFormToken(req.token, deps.config.googleFormCancelTokenSecret, now);
  if (!verifiedToken.ok) {
    return {
      ok: false,
      statusCode: 401,
      errorCode: verifiedToken.reason === 'expired' ? 'EXPIRED_CANCEL_FORM_TOKEN' : 'INVALID_CANCEL_FORM_TOKEN',
      message: 'Cancel form token is invalid',
    };
  }

  const normalizedEmail = normalizeEmail(req.email);
  if (normalizedEmail !== verifiedToken.payload.email) {
    return { ok: false, statusCode: 401, errorCode: 'TOKEN_EMAIL_MISMATCH', message: 'Email does not match token' };
  }

  const tokenRecord = await deps.db.findCancelFormToken(verifiedToken.payload.jti);
  if (!tokenRecord) {
    return { ok: false, statusCode: 401, errorCode: 'INVALID_CANCEL_FORM_TOKEN', message: 'Cancel form token missing' };
  }
  if (tokenRecord.used_at !== null) {
    return { ok: false, statusCode: 401, errorCode: 'CONSUMED_CANCEL_FORM_TOKEN', message: 'Cancel form token used' };
  }
  if (tokenRecord.expires_at <= now) {
    return { ok: false, statusCode: 401, errorCode: 'EXPIRED_CANCEL_FORM_TOKEN', message: 'Cancel form token expired' };
  }
  if (
    tokenRecord.member_id !== verifiedToken.payload.memberId ||
    normalizeEmail(tokenRecord.email) !== normalizedEmail
  ) {
    return {
      ok: false,
      statusCode: 401,
      errorCode: 'INVALID_CANCEL_FORM_TOKEN',
      message: 'Cancel form token mismatch',
    };
  }

  const member = await deps.db.findMemberById(tokenRecord.member_id);
  if (!member) {
    return { ok: false, statusCode: 409, errorCode: 'NO_SUBSCRIPTION', message: 'No member found for token' };
  }

  const lockKey = cancelLockKey(member);
  const lockAcquired = await deps.db.acquireAdvisoryLock(lockKey);
  if (!lockAcquired) {
    return { ok: false, statusCode: 503, errorCode: 'LOCK_UNAVAILABLE', message: 'Could not acquire advisory lock' };
  }

  try {
    const lockedToken = await deps.db.findCancelFormToken(verifiedToken.payload.jti);
    if (!lockedToken) {
      return {
        ok: false,
        statusCode: 401,
        errorCode: 'INVALID_CANCEL_FORM_TOKEN',
        message: 'Cancel form token missing',
      };
    }
    if (lockedToken.used_at !== null) {
      return {
        ok: false,
        statusCode: 401,
        errorCode: 'CONSUMED_CANCEL_FORM_TOKEN',
        message: 'Cancel form token used',
      };
    }
    if (lockedToken.expires_at <= now) {
      return {
        ok: false,
        statusCode: 401,
        errorCode: 'EXPIRED_CANCEL_FORM_TOKEN',
        message: 'Cancel form token expired',
      };
    }

    const lockedMember = await deps.db.findMemberById(lockedToken.member_id);
    if (!lockedMember) {
      return { ok: false, statusCode: 409, errorCode: 'NO_SUBSCRIPTION', message: 'No member found for token' };
    }

    const cancelState = await applyImmediateCancelState(lockedMember, deps, now);
    if ('ok' in cancelState) {
      return cancelState;
    }

    return finalizeImmediateCancel(cancelState.member, deps, {
      flow: 'google-submit',
      operationId: cancelState.operationId,
      finalizeSuccess: async () => {
        await deps.db.consumeCancelFormToken(verifiedToken.payload.jti, now);
      },
    });
  } finally {
    try {
      await deps.db.releaseAdvisoryLock(lockKey);
    } catch (err) {
      slog('error', 'Advisory lock release failed', { lockKey, error: String(err) });
    }
  }
}

export async function handleCancel(req: CancelRequest, deps: BillingDeps): Promise<CancelResult> {
  const now = deps.clock();

  if (!isSameOrigin(req.origin, deps.config.frontendBaseUrl)) {
    return { ok: false, statusCode: 403, errorCode: 'FORBIDDEN_ORIGIN', message: 'Origin not allowed' };
  }

  const tokenHash = linkSessionTokenHash(req.linkSessionToken);
  const linkSession = await deps.db.findLinkSession(tokenHash);
  if (!linkSession) {
    return { ok: false, statusCode: 401, errorCode: 'INVALID_LINK_SESSION', message: 'Link session not found' };
  }
  if (linkSession.expires_at <= now) {
    return { ok: false, statusCode: 401, errorCode: 'EXPIRED_LINK_SESSION', message: 'Link session expired' };
  }
  if (linkSession.used_at !== null) {
    return { ok: false, statusCode: 401, errorCode: 'CONSUMED_LINK_SESSION', message: 'Link session already used' };
  }

  const member = await deps.db.findMemberByDiscordUserId(linkSession.discord_user_id);
  if (!member) {
    return { ok: false, statusCode: 409, errorCode: 'NO_SUBSCRIPTION', message: 'No active subscription found' };
  }

  const lockKey = cancelLockKey(member, linkSession.discord_user_id);
  const lockAcquired = await deps.db.acquireAdvisoryLock(lockKey);
  if (!lockAcquired) {
    return { ok: false, statusCode: 503, errorCode: 'LOCK_UNAVAILABLE', message: 'Could not acquire advisory lock' };
  }

  try {
    const lockedMember = await deps.db.findMemberByDiscordUserId(linkSession.discord_user_id);
    if (!lockedMember) {
      return { ok: false, statusCode: 409, errorCode: 'NO_SUBSCRIPTION', message: 'No active subscription found' };
    }

    await deps.db.consumeLinkSession(tokenHash, now);

    const cancelState = await applyImmediateCancelState(lockedMember, deps, now);
    if ('ok' in cancelState) {
      return cancelState;
    }

    return finalizeImmediateCancel(cancelState.member, deps, {
      flow: 'browser',
      operationId: cancelState.operationId,
    });
  } finally {
    try {
      await deps.db.releaseAdvisoryLock(lockKey);
    } catch (err) {
      slog('error', 'Advisory lock release failed', { lockKey, error: String(err) });
    }
  }
}
