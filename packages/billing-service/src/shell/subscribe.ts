/**
 * Subscribe Orchestration — Billing-first flow
 *
 * 課金先行フロー: Discord認証不要でPAY.JP課金を実行する。
 * Discord連携（ロール付与）は別エンドポイント（link-discord）で実施。
 */
import { randomBytes } from 'node:crypto';
import type { Member } from '@hayane/shared';
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
  memberSessionTokenHash,
  validatePlanId,
} from '../core/index.js';
import { isUncertainError } from './errors.js';
import type { BillingDeps, SubscribeRequest, SubscribeResult } from './types.js';

const MEMBER_SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function slog(level: 'info' | 'warn' | 'error', message: string, ctx: Record<string, unknown> = {}): void {
  console[level](JSON.stringify({ level, service: 'billing-subscribe', message, ...ctx }));
}

async function issueMemberSessionToken(
  db: BillingDeps['db'],
  memberId: string,
  now: Date,
  ctx: { email: string; operationId?: string },
): Promise<string | undefined> {
  const rawToken = randomBytes(32).toString('hex');
  const tokenHash = memberSessionTokenHash(rawToken);
  try {
    await db.insertMemberSession({
      memberSessionTokenHash: tokenHash,
      memberId,
      expiresAt: new Date(now.getTime() + MEMBER_SESSION_TTL_MS),
    });
    return rawToken;
  } catch (err) {
    slog('error', 'insertMemberSession failed', {
      email: ctx.email,
      memberId,
      ...(ctx.operationId !== undefined ? { operationId: ctx.operationId } : {}),
      error: String(err),
    });
    // Non-fatal: subscription succeeded, but session cookie must not be set without a DB row
    return undefined;
  }
}

/** F-02 確定失敗パス: inflight 解除はベストエフォート */
async function clearInflightOnDefinitePayjpFailure(
  db: BillingDeps['db'],
  memberId: string,
  email: string,
  operationId: string,
  payjpStep: 'createCustomer' | 'createCharge' | 'createSubscription',
): Promise<void> {
  try {
    await db.clearInflightOperation(memberId);
  } catch (err) {
    slog('error', 'clearInflightOperation failed on definite PAY.JP failure path', {
      email,
      operationId,
      memberId,
      payjpStep,
      error: String(err),
    });
  }
}

const EMAIL_RE =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

export async function handleSubscribe(req: SubscribeRequest, deps: BillingDeps): Promise<SubscribeResult> {
  const { db, payjp, config, clock, generateOperationId } = deps;
  const now = clock();

  // Step 1: Origin / planId / email / consent validation
  if (!isSameOrigin(req.origin, config.frontendBaseUrl)) {
    return { ok: false, statusCode: 403, errorCode: 'FORBIDDEN_ORIGIN', message: 'Origin not allowed' };
  }

  if (!validatePlanId(req.planId, config.allowedPlanIds)) {
    return { ok: false, statusCode: 422, errorCode: 'INVALID_PLAN_ID', message: 'planId not in allowlist' };
  }

  // Normalize email to lowercase to prevent case-sensitive duplicates
  const normalizedEmail = req.email.toLowerCase().trim();

  if (!normalizedEmail || !EMAIL_RE.test(normalizedEmail)) {
    return { ok: false, statusCode: 422, errorCode: 'INVALID_EMAIL', message: 'Invalid email format' };
  }

  if (!req.privacyConsented) {
    return { ok: false, statusCode: 422, errorCode: 'CONSENT_REQUIRED', message: 'Privacy consent is required' };
  }

  // Step 2: Advisory lock on normalized email (prevents duplicate subscriptions)
  const lockAcquired = await db.acquireAdvisoryLock(normalizedEmail);
  if (!lockAcquired) {
    return { ok: false, statusCode: 503, errorCode: 'LOCK_UNAVAILABLE', message: 'Could not acquire advisory lock' };
  }

  try {
    // Step 3: Upsert provisional member by email (discord_user_id=NULL)
    const member = await db.upsertProvisionalMemberByEmail(normalizedEmail);

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

    // Step 5: Existing subscription check
    if (hasActiveSubscription(member.subscription_status, member.access_end_at, now)) {
      const response = buildSubscriptionResponse(member);
      const memberSessionToken = await issueMemberSessionToken(db, member.id, now, { email: normalizedEmail });
      return {
        ok: true,
        data: response,
        ...(memberSessionToken !== undefined ? { memberSessionToken } : {}),
      };
    }

    // Step 6: Persist operationId BEFORE any PAY.JP write
    const operationId = generateOperationId();
    await db.setInflightOperation(member.id, operationId, 'subscribe', now);

    // Step 7: PAY.JP token 3DS verification (READ-only)
    let payjpTokenData: Awaited<ReturnType<typeof payjp.fetchToken>>;
    try {
      payjpTokenData = await payjp.fetchToken(req.payjpToken);
    } catch (err) {
      slog('error', 'PAY.JP token fetch failed', { email: normalizedEmail, operationId, error: String(err) });
      try {
        await db.clearInflightOperation(member.id);
      } catch (clearErr) {
        slog('error', 'clearInflightOperation failed after fetchToken error', {
          email: normalizedEmail,
          operationId,
          error: String(clearErr),
        });
      }
      return {
        ok: false,
        statusCode: 422,
        errorCode: 'PAYJP_TOKEN_INVALID',
        message: 'Failed to fetch PAY.JP token',
        operationId,
      };
    }

    if (payjpTokenData.used) {
      try {
        await db.clearInflightOperation(member.id);
      } catch (clearErr) {
        slog('error', 'clearInflightOperation failed after TOKEN_ALREADY_USED', {
          email: normalizedEmail,
          operationId,
          error: String(clearErr),
        });
      }
      return {
        ok: false,
        statusCode: 422,
        errorCode: 'TOKEN_ALREADY_USED',
        message: 'Token already used',
        operationId,
      };
    }

    if (!isThreeDSecureVerified(payjpTokenData.three_d_secure_status)) {
      try {
        await db.clearInflightOperation(member.id);
      } catch (clearErr) {
        slog('error', 'clearInflightOperation failed after THREE_D_SECURE_REQUIRED', {
          email: normalizedEmail,
          operationId,
          error: String(clearErr),
        });
      }
      return {
        ok: false,
        statusCode: 422,
        errorCode: 'THREE_D_SECURE_REQUIRED',
        message: '3DS verification required',
        operationId,
      };
    }

    // Step 8: Customer creation or reuse
    const metadata = buildSubscriptionMetadata(member.id, operationId, member.discord_user_id);
    let customerId = member.payjp_customer_id;
    if (!customerId) {
      let customer: Awaited<ReturnType<typeof payjp.createCustomer>>;
      try {
        customer = await payjp.createCustomer({
          email: normalizedEmail,
          card: req.payjpToken,
          metadata,
        });
      } catch (err) {
        if (isUncertainError(err)) {
          slog('error', 'PAY.JP createCustomer uncertain failure', {
            email: normalizedEmail,
            operationId,
            error: String(err),
          });
          return {
            ok: false,
            statusCode: 503,
            errorCode: 'PAYJP_UNCERTAIN',
            message: 'Uncertain failure during customer creation',
            operationId,
          };
        }
        slog('error', 'PAY.JP createCustomer definite failure', {
          email: normalizedEmail,
          operationId,
          error: String(err),
        });
        await clearInflightOnDefinitePayjpFailure(db, member.id, normalizedEmail, operationId, 'createCustomer');
        return {
          ok: false,
          statusCode: 422,
          errorCode: 'PAYJP_ERROR',
          message: 'Customer creation failed',
          operationId,
        };
      }
      customerId = customer.id;
      try {
        await db.updateMemberCustomerId(member.id, customerId);
      } catch (err) {
        slog('error', 'Failed to persist customer id after PAY.JP customer creation', {
          email: normalizedEmail,
          operationId,
          customerId,
          error: String(err),
        });
        return {
          ok: false,
          statusCode: 503,
          errorCode: 'DB_UPDATE_FAILED',
          message: 'DB update failed after customer creation',
          operationId,
        };
      }
    }

    // Step 9: Initial charge (first-time only)
    const isFirstTime = isFirstTimeUser(member.first_trial_granted_at);
    let initialChargeId: string | null = null;
    if (isFirstTime) {
      let charge: Awaited<ReturnType<typeof payjp.createCharge>> | undefined;
      try {
        charge = await payjp.createCharge({
          customer: customerId,
          amount: config.initialChargeAmount,
          currency: config.initialChargeAmountCurrency,
          metadata,
        });
      } catch (err) {
        if (isUncertainError(err)) {
          slog('error', 'PAY.JP createCharge uncertain failure', {
            email: normalizedEmail,
            operationId,
            error: String(err),
          });
          return {
            ok: false,
            statusCode: 503,
            errorCode: 'PAYJP_UNCERTAIN',
            message: 'Uncertain failure during charge',
            operationId,
          };
        }
        if (member.payjp_initial_charge_id) {
          try {
            const existingCharge = await payjp.fetchCharge(member.payjp_initial_charge_id);
            initialChargeId = existingCharge.id;
          } catch (reconcileErr) {
            slog('error', 'Charge reconciliation failed', {
              email: normalizedEmail,
              operationId,
              reconcileErr: String(reconcileErr),
              originalErr: String(err),
            });
            return {
              ok: false,
              statusCode: 503,
              errorCode: 'PAYJP_UNCERTAIN',
              message: 'Reconciliation failed after charge failure',
              operationId,
            };
          }
        } else {
          slog('error', 'PAY.JP createCharge definite failure', {
            email: normalizedEmail,
            operationId,
            error: String(err),
          });
          await clearInflightOnDefinitePayjpFailure(db, member.id, normalizedEmail, operationId, 'createCharge');
          return { ok: false, statusCode: 422, errorCode: 'PAYJP_ERROR', message: 'Charge failed', operationId };
        }
      }
      if (!initialChargeId) {
        if (!charge) {
          slog('error', 'No charge object available after createCharge flow', { email: normalizedEmail, operationId });
          return {
            ok: false,
            statusCode: 503,
            errorCode: 'PAYJP_ERROR',
            message: 'No charge ID available',
            operationId,
          };
        }
        initialChargeId = charge.id;
      }
      try {
        await db.updateMemberChargeId(member.id, initialChargeId, now);
      } catch (err) {
        slog('error', 'Failed to persist initial charge id after PAY.JP charge creation', {
          email: normalizedEmail,
          operationId,
          chargeId: initialChargeId,
          error: String(err),
        });
        return {
          ok: false,
          statusCode: 503,
          errorCode: 'DB_UPDATE_FAILED',
          message: 'DB update failed after charge creation',
          operationId,
        };
      }
    }

    // Step 10: Subscription creation
    const trialEnd = isFirstTime ? calculateTrialEnd(now) : undefined;
    const subscriptionParams = {
      customer: customerId,
      plan: req.planId,
      metadata,
      ...(trialEnd !== undefined && { trial_end: Math.floor(trialEnd.getTime() / 1000) }),
    };

    let subscription: Awaited<ReturnType<typeof payjp.createSubscription>>;
    try {
      subscription = await payjp.createSubscription(subscriptionParams);
    } catch (err) {
      if (isUncertainError(err)) {
        slog('error', 'PAY.JP createSubscription uncertain failure', {
          email: normalizedEmail,
          operationId,
          error: String(err),
        });
        return {
          ok: false,
          statusCode: 503,
          errorCode: 'PAYJP_UNCERTAIN',
          message: 'Uncertain failure during subscription creation',
          operationId,
        };
      }
      if (member.payjp_subscription_id) {
        try {
          const existingSub = await payjp.fetchSubscription(member.payjp_subscription_id);
          subscription = existingSub;
        } catch (reconcileErr) {
          slog('error', 'Subscription reconciliation failed', {
            email: normalizedEmail,
            operationId,
            reconcileErr: String(reconcileErr),
            originalErr: String(err),
          });
          return {
            ok: false,
            statusCode: 503,
            errorCode: 'PAYJP_UNCERTAIN',
            message: 'Reconciliation failed after subscription creation failure',
            operationId,
          };
        }
      } else {
        slog('error', 'PAY.JP createSubscription definite failure', {
          email: normalizedEmail,
          operationId,
          error: String(err),
        });
        await clearInflightOnDefinitePayjpFailure(db, member.id, normalizedEmail, operationId, 'createSubscription');
        return {
          ok: false,
          statusCode: 422,
          errorCode: 'PAYJP_ERROR',
          message: 'Subscription creation failed',
          operationId,
        };
      }
    }

    // Step 11: Member state update + clear inflight
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
        role_state: 'unknown',
        last_synced_at: now,
        privacy_consented_at: now,
      });
    } catch (err) {
      slog('error', 'DB update failed after PAY.JP subscription creation', {
        email: normalizedEmail,
        operationId,
        error: String(err),
      });
      return {
        ok: false,
        statusCode: 503,
        errorCode: 'DB_UPDATE_FAILED',
        message: 'DB update failed after PAY.JP subscription creation',
        operationId,
      };
    }

    // Step 12: Clear inflight operation
    try {
      await db.clearInflightOperation(updatedMember.id);
    } catch (err) {
      slog('error', 'clearInflightOperation failed after successful subscribe', {
        email: normalizedEmail,
        operationId,
        memberId: updatedMember.id,
        error: String(err),
      });
      return {
        ok: false,
        statusCode: 503,
        errorCode: 'DB_UPDATE_FAILED',
        message: 'Failed to finalize subscription state',
        operationId,
      };
    }
    const memberForResponse = {
      ...updatedMember,
      inflight_operation_id: null,
      inflight_operation_type: null as Member['inflight_operation_type'],
      inflight_operation_started_at: null,
    };

    // Step 13: Issue member session token for post-subscribe flows (only if DB row is persisted)
    const memberSessionToken = await issueMemberSessionToken(db, updatedMember.id, now, {
      email: normalizedEmail,
      operationId,
    });

    slog('info', 'subscribe completed', {
      email: normalizedEmail,
      operationId,
      planId: req.planId,
      subscriptionId: subscription.id,
    });
    return {
      ok: true,
      data: buildSubscriptionResponse(memberForResponse),
      ...(memberSessionToken !== undefined ? { memberSessionToken } : {}),
    };
  } finally {
    try {
      await db.releaseAdvisoryLock(normalizedEmail);
    } catch (err) {
      slog('error', 'Advisory lock release failed', { email: normalizedEmail, error: String(err) });
    }
  }
}
