/**
 * Subscribe Orchestration — Phase 2b (Green)
 *
 * REQ-BILL-003〜016 の 14 ステップ順序に従い実装する。
 * 外部 I/O はすべて BillingDeps 経由でインジェクト済み。
 */
import {
  buildSubscriptionMetadata,
  buildSubscriptionResponse,
  calculateTrialEnd,
  determineSubscriptionStatus,
  hasActiveSubscription,
  hasInflightOperation,
  isFirstTimeUser,
  isSameOrigin,
  isThreeDSecureVerified,
  linkSessionTokenHash,
  validatePlanId,
} from '../core/index.js';
import { isUncertainError } from './errors.js';
import type { BillingDeps, SubscribeRequest, SubscribeResult } from './types.js';

const ROLE_SYNC_MAX_RETRIES = 3;

export async function handleSubscribe(req: SubscribeRequest, deps: BillingDeps): Promise<SubscribeResult> {
  const { db, payjp, discord, config, clock, generateOperationId } = deps;
  const now = clock();

  // Step 1: Origin validation
  if (!isSameOrigin(req.origin, config.frontendBaseUrl)) {
    return { ok: false, statusCode: 403, errorCode: 'FORBIDDEN_ORIGIN', message: 'Origin not allowed' };
  }

  // Step 2: Link session validation (pre-check — not consumed yet)
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

  // Validate discordUserId matches session
  const discordUserId = linkSession.discord_user_id;

  // Step 3: planId validation
  if (!validatePlanId(req.planId, config.allowedPlanIds)) {
    return { ok: false, statusCode: 422, errorCode: 'INVALID_PLAN_ID', message: 'planId not in allowlist' };
  }

  // Step 2 (advisory lock): Acquire lock keyed by discordUserId
  const lockKey = `subscribe:${discordUserId}`;
  const lockAcquired = await db.acquireAdvisoryLock(lockKey);
  if (!lockAcquired) {
    // Should not normally happen in a single-instance test; treat as 503
    return { ok: false, statusCode: 503, errorCode: 'LOCK_UNAVAILABLE', message: 'Could not acquire advisory lock' };
  }

  try {
    // Step 3: Upsert provisional member row
    const member = await db.upsertProvisionalMember(discordUserId, req.email);

    // Step 4: Inflight operation check
    if (hasInflightOperation(member.inflight_operation_id)) {
      return {
        ok: false,
        statusCode: 503,
        errorCode: 'INFLIGHT_OPERATION',
        message: 'Another operation is in progress',
        operationId: member.inflight_operation_id!,
      };
    }

    // Step 5: Existing subscription check
    if (hasActiveSubscription(member.subscription_status, member.access_end_at, now)) {
      const response = buildSubscriptionResponse(member);
      return { ok: true, data: response };
    }

    // Step 6: Discord pre-check
    const discordCheck = await discord.checkMembership(config.discordGuildId, discordUserId);
    if (!discordCheck.isMember) {
      return {
        ok: false,
        statusCode: 409,
        errorCode: 'DISCORD_NOT_MEMBER',
        message: 'User is not a Discord guild member',
      };
    }
    if (!discordCheck.canAssignRole) {
      return {
        ok: false,
        statusCode: 503,
        errorCode: 'DISCORD_ROLE_CAPABILITY',
        message: 'Cannot assign Discord role',
      };
    }

    // Step 7: Persist operationId BEFORE any PAY.JP write
    const operationId = generateOperationId();
    await db.setInflightOperation(member.id, operationId, 'subscribe', now);

    // Step 9: PAY.JP token 3DS verification (READ-only — no PAY.JP state change)
    // fetchToken failure retains inflight; operator resolves via CLI
    let payjpTokenData: Awaited<ReturnType<typeof payjp.fetchToken>>;
    try {
      payjpTokenData = await payjp.fetchToken(req.payjpToken);
    } catch (_err) {
      return {
        ok: false,
        statusCode: 503,
        errorCode: 'PAYJP_ERROR',
        message: 'Failed to fetch PAY.JP token',
        operationId,
      };
    }

    // REQ-BILL-009: used=false AND three_d_secure_status=verified
    // Token validation failures retain inflight; operator resolves via CLI
    if (payjpTokenData.used) {
      return {
        ok: false,
        statusCode: 422,
        errorCode: 'TOKEN_ALREADY_USED',
        message: 'Token already used',
        operationId,
      };
    }

    if (!isThreeDSecureVerified(payjpTokenData.three_d_secure_status)) {
      return {
        ok: false,
        statusCode: 422,
        errorCode: 'THREE_D_SECURE_REQUIRED',
        message: '3DS verification required',
        operationId,
      };
    }

    // Step 8: Link session consumption (after token validation, before PAY.JP writes)
    await db.consumeLinkSession(tokenHash, now);

    // Step 10: Customer creation or reuse
    const metadata = buildSubscriptionMetadata(discordUserId, operationId);
    let customerId = member.payjp_customer_id;
    if (!customerId) {
      let customer: Awaited<ReturnType<typeof payjp.createCustomer>>;
      try {
        customer = await payjp.createCustomer({
          email: req.email,
          card: req.payjpToken,
          metadata,
        });
      } catch (err) {
        if (isUncertainError(err)) {
          // Keep inflight — uncertain failure
          return {
            ok: false,
            statusCode: 503,
            errorCode: 'PAYJP_UNCERTAIN',
            message: 'Uncertain failure during customer creation',
            operationId,
          };
        }
        // Definite failure with no existing customer — retain inflight for CLI resolution
        return {
          ok: false,
          statusCode: 503,
          errorCode: 'PAYJP_ERROR',
          message: 'Customer creation failed',
          operationId,
        };
      }
      if (!customerId) {
        customerId = customer!.id;
        // Persist customer id immediately — survives subsequent failure
        await db.updateMemberCustomerId(member.id, customerId);
      }
    }

    // Step 11 (first-time only): Initial charge
    const isFirstTime = isFirstTimeUser(member.first_trial_granted_at);
    let initialChargeId: string | null = null;
    if (isFirstTime) {
      let charge: Awaited<ReturnType<typeof payjp.createCharge>>;
      try {
        charge = await payjp.createCharge({
          customer: customerId,
          amount: config.initialChargeAmount,
          currency: config.initialChargeAmountCurrency,
          metadata,
        });
      } catch (err) {
        if (isUncertainError(err)) {
          return {
            ok: false,
            statusCode: 503,
            errorCode: 'PAYJP_UNCERTAIN',
            message: 'Uncertain failure during charge',
            operationId,
          };
        }
        // Reconcile: re-fetch charge via payjp_initial_charge_id if exists
        if (member.payjp_initial_charge_id) {
          try {
            const existingCharge = await payjp.fetchCharge(member.payjp_initial_charge_id);
            initialChargeId = existingCharge.id;
          } catch {
            return {
              ok: false,
              statusCode: 503,
              errorCode: 'PAYJP_UNCERTAIN',
              message: 'Reconciliation failed after charge failure',
              operationId,
            };
          }
        } else {
          // No existing charge_id — retain inflight for CLI resolution
          return { ok: false, statusCode: 503, errorCode: 'PAYJP_ERROR', message: 'Charge failed', operationId };
        }
      }
      if (!initialChargeId) {
        initialChargeId = charge!.id;
      }
      // REQ-BILL-013: immediately persist charge_id before subscription creation
      await db.updateMemberChargeId(member.id, initialChargeId, now);
    }

    // Step 12: Subscription creation
    const trialEnd = isFirstTime ? calculateTrialEnd(now) : undefined;
    const subscriptionParams: {
      customer: string;
      plan: string;
      trial_end?: number;
      metadata: Record<string, string>;
    } = {
      customer: customerId,
      plan: req.planId,
      metadata,
    };
    if (trialEnd !== undefined) {
      subscriptionParams.trial_end = Math.floor(trialEnd.getTime() / 1000);
    }

    let subscription: Awaited<ReturnType<typeof payjp.createSubscription>>;
    try {
      subscription = await payjp.createSubscription(subscriptionParams);
    } catch (err) {
      if (isUncertainError(err)) {
        return {
          ok: false,
          statusCode: 503,
          errorCode: 'PAYJP_UNCERTAIN',
          message: 'Uncertain failure during subscription creation',
          operationId,
        };
      }
      // Reconcile: if payjp_subscription_id exists, re-fetch
      if (member.payjp_subscription_id) {
        try {
          const existingSub = await payjp.fetchSubscription(member.payjp_subscription_id);
          subscription = existingSub;
        } catch {
          return {
            ok: false,
            statusCode: 503,
            errorCode: 'PAYJP_UNCERTAIN',
            message: 'Reconciliation failed after subscription creation failure',
            operationId,
          };
        }
      } else {
        // No existing subscription_id — retain inflight for CLI resolution
        return {
          ok: false,
          statusCode: 503,
          errorCode: 'PAYJP_ERROR',
          message: 'Subscription creation failed',
          operationId,
        };
      }
    }

    // Step 13: Member state update
    // PAY.JP writes are complete — DB update failure retains inflight for CLI resolution
    const subscriptionStatus = determineSubscriptionStatus(isFirstTime);
    const accessEndAt = new Date(subscription.current_period_end * 1000);
    const nextBillingAt = new Date(subscription.current_period_end * 1000);
    let updatedMember: Awaited<ReturnType<typeof db.updateMemberAfterSubscribe>>;
    try {
      updatedMember = await db.updateMemberAfterSubscribe(member.id, {
        payjp_initial_charge_id: initialChargeId,
        initial_charge_paid_at: isFirstTime && initialChargeId ? now : null,
        payjp_subscription_id: subscription.id,
        payjp_plan_id: subscription.plan.id,
        subscription_status: subscriptionStatus,
        first_trial_granted_at: isFirstTime ? now : member.first_trial_granted_at,
        access_end_at: accessEndAt,
        next_billing_at: nextBillingAt,
        role_state: 'granted',
        last_synced_at: now,
        inflight_operation_id: null,
        inflight_operation_type: null,
        inflight_operation_started_at: null,
      });
    } catch {
      // DB failure after PAY.JP success — retain inflight for CLI reconciliation
      return {
        ok: false,
        statusCode: 503,
        errorCode: 'DB_UPDATE_FAILED',
        message: 'DB update failed after PAY.JP subscription creation',
        operationId,
      };
    }

    // Step 14: Role sync (retry 3x: 0s/1s/2s wait, 1s timeout each, total ≤ 6s)
    const ROLE_SYNC_DELAYS_MS = [0, 1000, 2000];
    let roleAssigned = false;
    for (let attempt = 0; attempt < ROLE_SYNC_MAX_RETRIES; attempt++) {
      if (ROLE_SYNC_DELAYS_MS[attempt] > 0) {
        await new Promise((r) => setTimeout(r, ROLE_SYNC_DELAYS_MS[attempt]));
      }
      try {
        await discord.assignRole(config.discordGuildId, discordUserId, config.discordPaidRoleId);
        roleAssigned = true;
        break;
      } catch {
        // retry with next delay
      }
    }

    if (!roleAssigned) {
      // 503 + operationId, inflight retained (re-set since updateMemberAfterSubscribe cleared it)
      await db.setInflightOperation(member.id, operationId, 'subscribe', now);
      return {
        ok: false,
        statusCode: 503,
        errorCode: 'DISCORD_ROLE_SYNC_FAILED',
        message: 'Failed to assign Discord role after 3 retries',
        operationId,
      };
    }

    return { ok: true, data: buildSubscriptionResponse(updatedMember) };
  } finally {
    await db.releaseAdvisoryLock(lockKey);
  }
}
