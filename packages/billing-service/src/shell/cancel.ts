/**
 * Cancel Orchestration — Phase 2b (Green)
 *
 * 仕様書 §5.2 の 12 ステップ（REQ-BILL-019〜025）に対応する。
 * Step 1 はサブステップ 1b, 1c に分割して実装。
 */
import {
  buildCancelResponse,
  hasActiveSubscription,
  hasInflightOperation,
  isSameOrigin,
  linkSessionTokenHash,
} from '../core/index.js';
import { isUncertainError } from './errors.js';
import type { BillingDeps, CancelRequest, CancelResult } from './types.js';

function slog(level: 'info' | 'warn' | 'error', message: string, ctx: Record<string, unknown> = {}): void {
  console[level](JSON.stringify({ level, service: 'billing-cancel', message, ...ctx }));
}

export async function handleCancel(req: CancelRequest, deps: BillingDeps): Promise<CancelResult> {
  const { db, payjp, config, clock, generateOperationId } = deps;
  const now = clock();

  // Step 1: Origin validation
  if (!isSameOrigin(req.origin, config.frontendBaseUrl)) {
    return { ok: false, statusCode: 403, errorCode: 'FORBIDDEN_ORIGIN', message: 'Origin not allowed' };
  }

  // Step 1b: Link session early validation (consume later at step 8)
  const tokenHash = linkSessionTokenHash(req.linkSessionToken);
  const linkSession = await db.findLinkSession(tokenHash);
  if (!linkSession) {
    return { ok: false, statusCode: 401, errorCode: 'INVALID_LINK_SESSION', message: 'Link session not found' };
  }
  if (linkSession.expires_at < now) {
    return { ok: false, statusCode: 401, errorCode: 'EXPIRED_LINK_SESSION', message: 'Link session expired' };
  }
  if (linkSession.used_at !== null) {
    return { ok: false, statusCode: 401, errorCode: 'CONSUMED_LINK_SESSION', message: 'Link session already used' };
  }

  // P-03: discordUserIdはリンクセッションから取得（ボディからは受け取らない）
  const discordUserId = linkSession.discord_user_id;

  // Step 2: Advisory lock (spec §5.2 step 2)
  const lockAcquired = await db.acquireAdvisoryLock(discordUserId);
  if (!lockAcquired) {
    return { ok: false, statusCode: 503, errorCode: 'LOCK_UNAVAILABLE', message: 'Could not acquire advisory lock' };
  }

  try {
    // Step 3: Existing subscription check
    const member = await db.findMemberByDiscordUserId(discordUserId);
    if (!member || !hasActiveSubscription(member.subscription_status, member.access_end_at, now)) {
      return { ok: false, statusCode: 409, errorCode: 'NO_SUBSCRIPTION', message: 'No active subscription found' };
    }

    // Step 4: Inflight operation check
    if (hasInflightOperation(member.inflight_operation_id)) {
      return {
        ok: false,
        statusCode: 503,
        errorCode: 'INFLIGHT_OPERATION',
        message: 'Another operation is in progress',
        operationId: member.inflight_operation_id,
      };
    }

    // Step 5: access_end_at check
    if (member.access_end_at === null) {
      return { ok: false, statusCode: 409, errorCode: 'ACCESS_END_AT_NULL', message: 'access_end_at is null' };
    }

    // Step 6: payjp_subscription_id check
    if (member.payjp_subscription_id === null) {
      return {
        ok: false,
        statusCode: 409,
        errorCode: 'NO_PAYJP_SUBSCRIPTION',
        message: 'payjp_subscription_id is null',
      };
    }

    // Step 7: Link session consumption (validation already done at step 1b)
    // REQ-BILL-022: link session is consumed even on idempotent path
    await db.consumeLinkSession(tokenHash, now);

    // Step 9: cancel_requested_at idempotency check
    if (member.cancel_requested_at !== null) {
      // Already cancelled — return idempotent response without calling PAY.JP again
      return { ok: true, data: buildCancelResponse(member) };
    }

    // Step 10: operationId persistence BEFORE PAY.JP cancel call
    const operationId = generateOperationId();
    await db.setInflightOperation(member.id, operationId, 'cancel', now);

    // Step 11: PAY.JP cancel API (no retry)
    let canceledSubscription: Awaited<ReturnType<typeof payjp.cancelSubscription>>;
    try {
      canceledSubscription = await payjp.cancelSubscription(member.payjp_subscription_id);
    } catch (err) {
      // Uncertain failure — retain inflight
      if (isUncertainError(err)) {
        slog('error', 'PAY.JP cancelSubscription uncertain failure', {
          discordUserId,
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
      // Definite failure after write attempt — try reconcile by checking actual state
      slog('error', 'PAY.JP cancelSubscription definite failure, attempting reconciliation', {
        discordUserId,
        operationId,
        error: String(err),
      });
      try {
        const refetched = await payjp.fetchSubscription(member.payjp_subscription_id);
        if (refetched.status !== 'canceled') {
          // Cancel was not actually applied — definite 4xx + reconcile confirms no cancel → clear inflight
          try {
            await db.clearInflightOperation(member.id);
          } catch (clearErr) {
            slog('error', 'clearInflightOperation failed after definite cancel failure', {
              discordUserId,
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
          discordUserId,
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

    // Step 12: State update + clear inflight
    // PAY.JP cancel is complete — DB update failure retains inflight for CLI resolution
    const accessEndAt =
      canceledSubscription.current_period_end != null && canceledSubscription.current_period_end !== 0
        ? new Date(canceledSubscription.current_period_end * 1000)
        : member.access_end_at;

    let updatedMember: Awaited<ReturnType<typeof db.updateMemberAfterCancel>>;
    try {
      updatedMember = await db.updateMemberAfterCancel(member.id, {
        cancel_requested_at: now,
        subscription_status: 'canceled',
        access_end_at: accessEndAt,
        inflight_operation_id: null,
        inflight_operation_type: null,
        inflight_operation_started_at: null,
      });
    } catch (err) {
      // DB failure after PAY.JP cancel success — retain inflight for CLI reconciliation
      slog('error', 'DB update failed after PAY.JP cancel', { discordUserId, operationId, error: String(err) });
      return {
        ok: false,
        statusCode: 503,
        errorCode: 'DB_UPDATE_FAILED',
        message: 'DB update failed after PAY.JP cancel',
        operationId,
      };
    }

    return { ok: true, data: buildCancelResponse(updatedMember) };
  } finally {
    try {
      await db.releaseAdvisoryLock(discordUserId);
    } catch (err) {
      slog('error', 'Advisory lock release failed', { discordUserId, error: String(err) });
    }
  }
}
