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
  hasCancelableSubscription,
  hasInflightOperation,
  isSameOrigin,
  linkSessionTokenHash,
  maskSensitiveLogFields,
  memberSessionTokenHash,
  normalizeEmail,
  verifyGoogleCancelSubmitSignature,
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

function slog(level: 'info' | 'warn' | 'error', message: string, ctx: Record<string, unknown> = {}): void {
  const entry = maskSensitiveLogFields({ level, service: 'billing-cancel', message, ...ctx });
  console[level](JSON.stringify(entry));
}

function secureCompare(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}

function cancelLockKey(member: Member): string {
  return `member:${member.id}`;
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
      message: `Your previous ${member.inflight_operation_type ?? 'unknown'} operation (${member.inflight_operation_id}) is still in progress`,
      operationId: member.inflight_operation_id,
    };
  }

  // V3-H1: Guard against canceled status with null cancel_requested_at
  if (member.subscription_status === 'canceled' && member.cancel_requested_at === null) {
    slog('warn', 'canceled status with null cancel_requested_at — normalizing', { memberId: member.id });
    try {
      const normalizedMember = await deps.db.updateMemberAfterCancel(member.id, {
        cancel_requested_at: now,
        subscription_status: 'canceled',
        access_end_at: member.access_end_at ?? now,
        next_billing_at: member.next_billing_at ?? member.access_end_at,
        inflight_operation_id: null,
        inflight_operation_type: null,
        inflight_operation_started_at: null,
      });
      return { member: normalizedMember };
    } catch (err) {
      slog('error', 'Failed to normalize canceled+null state', {
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

  if (member.cancel_requested_at !== null) {
    if (member.subscription_status === 'canceled' && member.access_end_at !== null) {
      return { member };
    }
    try {
      const normalizedMember = await deps.db.updateMemberAfterCancel(member.id, {
        cancel_requested_at: member.cancel_requested_at,
        subscription_status: 'canceled',
        access_end_at: member.next_billing_at ?? member.access_end_at ?? now,
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

  if (member.payjp_subscription_id === null) {
    return {
      ok: false,
      statusCode: 409,
      errorCode: 'NO_PAYJP_SUBSCRIPTION',
      message: 'payjp_subscription_id is null',
    };
  }

  if (member.access_end_at === null) {
    return {
      ok: false,
      statusCode: 409,
      errorCode: 'NO_ACCESS_END',
      message: 'access_end_at is not set',
    };
  }

  const operationId = deps.generateOperationId();
  try {
    await deps.db.setInflightOperation(member.id, operationId, 'cancel', now);
  } catch (err) {
    slog('error', 'setInflightOperation failed', { memberId: member.id, operationId, error: String(err) });
    return {
      ok: false,
      statusCode: 503,
      errorCode: 'DB_UPDATE_FAILED',
      message: 'Failed to set inflight operation',
      operationId,
    };
  }

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
  const periodEnd = nextBillingAt ?? member.access_end_at ?? now;

  try {
    const updatedMember = await deps.db.updateMemberAfterCancel(member.id, {
      cancel_requested_at: now,
      subscription_status: 'canceled',
      access_end_at: periodEnd,
      next_billing_at: periodEnd,
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
  },
): Promise<CancelResult> {
  const roleId = member.payjp_plan_id ? (deps.config.planRoleMapping[member.payjp_plan_id] ?? null) : null;
  let roleRemovalAt = member.cancel_requested_at ?? deps.clock();

  if (member.role_state !== 'revoked' && member.discord_user_id && roleId) {
    try {
      await deps.discord.removeRole(deps.config.discordGuildId, member.discord_user_id, roleId);
      await deps.db.updateMemberRoleState(member.id, 'revoked');
      roleRemovalAt = deps.clock();
    } catch (err) {
      // V3-M2: Log role revoke failure regardless of role_state update outcome
      slog('error', 'Discord role revoke failed', {
        memberId: member.id,
        flow: ctx.flow,
        operationId: ctx.operationId,
        error: String(err),
      });
      try {
        await deps.db.updateMemberRoleState(member.id, 'unknown');
      } catch (roleStateErr) {
        slog('error', 'critical_failure: role revoke + role_state update both failed', {
          memberId: member.id,
          flow: ctx.flow,
          operationId: ctx.operationId,
          issue: 'role_revoke_double_failure',
          error: String(err),
          roleStateError: String(roleStateErr),
        });
      }
      return {
        ok: false,
        statusCode: 503,
        errorCode: 'DISCORD_ROLE_REVOKE_FAILED',
        message: 'Discord role revoke failed after cancel',
      };
    }
  } else if (member.role_state !== 'revoked' && member.discord_user_id) {
    // PAY.JP cancel succeeded but role mapping missing — partial success
    // inflight already cleared by applyImmediateCancelState, so log and continue
    slog('error', 'Role mapping missing for immediate revoke after cancel', {
      memberId: member.id,
      planId: member.payjp_plan_id,
      flow: ctx.flow,
      operationId: ctx.operationId,
      issue: 'unmapped_plan_after_cancel',
    });
    try {
      await deps.db.updateMemberRoleState(member.id, 'unknown');
    } catch (roleStateErr) {
      slog('error', 'Role mapping missing and role_state fallback update failed', {
        memberId: member.id,
        flow: ctx.flow,
        operationId: ctx.operationId,
        roleStateError: String(roleStateErr),
      });
    }
    return {
      ok: false,
      statusCode: 503,
      errorCode: 'DISCORD_ROLE_REVOKE_FAILED',
      message: 'Discord role mapping missing for immediate revoke',
    };
  }

  return { ok: true, data: buildCancelResponse(member, roleRemovalAt) };
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
  if (!member || (member.subscription_status !== 'active' && member.subscription_status !== 'trial')) {
    return { ok: false, statusCode: 409, errorCode: 'NO_SUBSCRIPTION', message: 'No active subscription found' };
  }
  if (hasInflightOperation(member.inflight_operation_id)) {
    return {
      ok: false,
      statusCode: 503,
      errorCode: 'INFLIGHT_OPERATION',
      message: `Your previous ${member.inflight_operation_type ?? 'unknown'} operation (${member.inflight_operation_id}) is still in progress`,
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

  // Defense-in-depth: bearer-secret alone is insufficient. HMAC ties the submit
  // body (email + token) to the shared key, so a leaked bearer cannot forge
  // an arbitrary submit without also possessing the key to compute signatures.
  if (
    !verifyGoogleCancelSubmitSignature(req.signature, deps.config.googleFormCancelSecret, {
      email: req.email,
      token: req.token,
    })
  ) {
    return { ok: false, statusCode: 401, errorCode: 'INVALID_CANCEL_SIGNATURE', message: 'Invalid signature' };
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
    return {
      ok: false,
      statusCode: 401,
      errorCode: 'INVALID_CANCEL_FORM_TOKEN',
      message: 'Cancel form token missing',
    };
  }
  if (tokenRecord.used_at !== null) {
    return { ok: false, statusCode: 401, errorCode: 'CONSUMED_CANCEL_FORM_TOKEN', message: 'Cancel form token used' };
  }
  if (tokenRecord.expires_at <= now) {
    return {
      ok: false,
      statusCode: 401,
      errorCode: 'EXPIRED_CANCEL_FORM_TOKEN',
      message: 'Cancel form token expired',
    };
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

    // §8 item 3: consume cancel form token before PAY.JP write, after lock acquisition
    // V3-M3: Add try/catch for consumeCancelFormToken to prevent silent propagation
    try {
      await deps.db.consumeCancelFormToken(verifiedToken.payload.jti, now);
    } catch (err) {
      slog('error', 'consumeCancelFormToken failed', {
        memberId: lockedMember.id,
        flow: 'google-submit',
        error: String(err),
      });
      return {
        ok: false,
        statusCode: 503,
        errorCode: 'DB_UPDATE_FAILED',
        message: 'Failed to consume token',
      };
    }

    const cancelState = await applyImmediateCancelState(lockedMember, deps, now);
    if ('ok' in cancelState) {
      return cancelState;
    }

    return await finalizeImmediateCancel(cancelState.member, deps, {
      flow: 'google-submit',
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

  const lockKey = cancelLockKey(member);
  const lockAcquired = await deps.db.acquireAdvisoryLock(lockKey);
  if (!lockAcquired) {
    return { ok: false, statusCode: 503, errorCode: 'LOCK_UNAVAILABLE', message: 'Could not acquire advisory lock' };
  }

  try {
    const lockedMember = await deps.db.findMemberByDiscordUserId(linkSession.discord_user_id);
    if (!lockedMember) {
      return { ok: false, statusCode: 409, errorCode: 'NO_SUBSCRIPTION', message: 'No active subscription found' };
    }

    const cancelState = await applyImmediateCancelState(lockedMember, deps, now);
    if ('ok' in cancelState) {
      return cancelState;
    }

    // Keep link_session reusable when we only reject by pre-PAY.JP guards
    // (e.g. existing inflight operation). Consume it only when proceeding past guards.
    try {
      await deps.db.consumeLinkSession(tokenHash, now);
    } catch (err) {
      slog('error', 'consumeLinkSession failed', {
        memberId: lockedMember.id,
        flow: 'browser',
        error: String(err),
      });
      return {
        ok: false,
        statusCode: 503,
        errorCode: 'DB_UPDATE_FAILED',
        message: 'Failed to consume session',
      };
    }

    return await finalizeImmediateCancel(cancelState.member, deps, {
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
