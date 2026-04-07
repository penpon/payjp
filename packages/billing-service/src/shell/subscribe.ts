/**
 * Subscribe Orchestration — Phase 2b (Green)
 *
 * 仕様書 §5.1 の 14 ステップ（REQ-BILL-003〜016）に対応する。
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

function slog(level: 'info' | 'warn' | 'error', message: string, ctx: Record<string, unknown> = {}): void {
  console[level](JSON.stringify({ level, service: 'billing-subscribe', message, ...ctx }));
}

/** F-02 確定失敗パス: inflight 解除はベストエフォート。DB 失敗で PAY.JP エラー応答（operationId 付き）を潰さない */
async function clearInflightOnDefinitePayjpFailure(
  db: BillingDeps['db'],
  memberId: string,
  discordUserId: string,
  operationId: string,
  payjpStep: 'createCustomer' | 'createCharge' | 'createSubscription',
): Promise<void> {
  try {
    await db.clearInflightOperation(memberId);
  } catch (err) {
    slog('error', 'clearInflightOperation failed on definite PAY.JP failure path', {
      discordUserId,
      operationId,
      memberId,
      payjpStep,
      error: String(err),
    });
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function handleSubscribe(req: SubscribeRequest, deps: BillingDeps): Promise<SubscribeResult> {
  const { db, payjp, discord, config, clock, generateOperationId } = deps;
  const now = clock();

  // Step 1: Origin / link_session / planId validation (spec §5.1 step 1)
  if (!isSameOrigin(req.origin, config.frontendBaseUrl)) {
    return { ok: false, statusCode: 403, errorCode: 'FORBIDDEN_ORIGIN', message: 'Origin not allowed' };
  }

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

  // discordUserId はリンクセッションから取得（P-03: ボディからは受け取らない）
  const discordUserId = linkSession.discord_user_id;

  if (!validatePlanId(req.planId, config.allowedPlanIds)) {
    return { ok: false, statusCode: 422, errorCode: 'INVALID_PLAN_ID', message: 'planId not in allowlist' };
  }

  // F-11: サーバーサイドemail形式バリデーション
  if (!req.email || !EMAIL_RE.test(req.email)) {
    return { ok: false, statusCode: 422, errorCode: 'INVALID_EMAIL', message: 'Invalid email format' };
  }

  // F-10: privacyConsented バリデーション
  if (!req.privacyConsented) {
    return { ok: false, statusCode: 422, errorCode: 'CONSENT_REQUIRED', message: 'Privacy consent is required' };
  }

  // Step 2: Advisory lock (spec §5.1 step 2)
  const lockAcquired = await db.acquireAdvisoryLock(discordUserId);
  if (!lockAcquired) {
    // Should not normally happen in a single-instance test; treat as 503
    return { ok: false, statusCode: 503, errorCode: 'LOCK_UNAVAILABLE', message: 'Could not acquire advisory lock' };
  }

  try {
    // Step 3: Upsert provisional member row (spec §5.1 step 3)
    const member = await db.upsertProvisionalMember(discordUserId, req.email);

    // Step 4: Inflight operation check (spec §5.1 step 4)
    if (hasInflightOperation(member.inflight_operation_id)) {
      return {
        ok: false,
        statusCode: 503,
        errorCode: 'INFLIGHT_OPERATION',
        message: 'Another operation is in progress',
        operationId: member.inflight_operation_id,
      };
    }

    // Step 5: Existing subscription check (spec §5.1 step 5)
    if (hasActiveSubscription(member.subscription_status, member.access_end_at, now)) {
      const response = buildSubscriptionResponse(member);
      return { ok: true, data: response };
    }

    // Step 6: Discord pre-check (spec §5.1 step 6)
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

    // Step 7: Persist operationId BEFORE any PAY.JP write (spec §5.1 step 7)
    const operationId = generateOperationId();
    await db.setInflightOperation(member.id, operationId, 'subscribe', now);

    // Step 9 (before spec step 8): PAY.JP token 3DS verification (READ-only)
    // Executed before link session consumption so invalid tokens don't consume session
    let payjpTokenData: Awaited<ReturnType<typeof payjp.fetchToken>>;
    try {
      payjpTokenData = await payjp.fetchToken(req.payjpToken);
    } catch (err) {
      slog('error', 'PAY.JP token fetch failed', { discordUserId, operationId, error: String(err) });
      // READ-only failure — no PAY.JP writes occurred; clear inflight (best-effort)
      try {
        await db.clearInflightOperation(member.id);
      } catch (clearErr) {
        slog('error', 'clearInflightOperation failed after fetchToken error', {
          discordUserId,
          operationId,
          error: String(clearErr),
        });
      }
      return {
        ok: false,
        statusCode: 503,
        errorCode: 'PAYJP_ERROR',
        message: 'Failed to fetch PAY.JP token',
        operationId,
      };
    }

    // REQ-BILL-009: used=false AND three_d_secure_status=verified
    // Token validation is READ-only — no PAY.JP writes occurred; clear inflight before returning
    if (payjpTokenData.used) {
      try {
        await db.clearInflightOperation(member.id);
      } catch (clearErr) {
        slog('error', 'clearInflightOperation failed after TOKEN_ALREADY_USED', {
          discordUserId,
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
          discordUserId,
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

    // Step 8: Link session consumption (spec §5.1 step 8, executed after step 9)
    await db.consumeLinkSession(tokenHash, now);

    // Step 10-11: Customer creation or reuse (spec §5.1 step 10-11)
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
          slog('error', 'PAY.JP createCustomer uncertain failure', { discordUserId, operationId, error: String(err) });
          return {
            ok: false,
            statusCode: 503,
            errorCode: 'PAYJP_UNCERTAIN',
            message: 'Uncertain failure during customer creation',
            operationId,
          };
        }
        // F-02: 4xx確定失敗 + 既存顧客なし → inflightクリアして503
        slog('error', 'PAY.JP createCustomer definite failure', { discordUserId, operationId, error: String(err) });
        await clearInflightOnDefinitePayjpFailure(db, member.id, discordUserId, operationId, 'createCustomer');
        return {
          ok: false,
          statusCode: 503,
          errorCode: 'PAYJP_ERROR',
          message: 'Customer creation failed',
          operationId,
        };
      }
      customerId = customer.id;
      // Persist customer id immediately — survives subsequent failure
      await db.updateMemberCustomerId(member.id, customerId);
    }

    // Step 12 (first-time only): Initial charge (spec §5.1 step 12)
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
          slog('error', 'PAY.JP createCharge uncertain failure', { discordUserId, operationId, error: String(err) });
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
          } catch (reconcileErr) {
            slog('error', 'Charge reconciliation failed', {
              discordUserId,
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
          // F-02: 4xx確定失敗 + 既存charge_idなし → inflightクリアして503
          slog('error', 'PAY.JP createCharge definite failure', { discordUserId, operationId, error: String(err) });
          await clearInflightOnDefinitePayjpFailure(db, member.id, discordUserId, operationId, 'createCharge');
          return { ok: false, statusCode: 503, errorCode: 'PAYJP_ERROR', message: 'Charge failed', operationId };
        }
      }
      if (!initialChargeId) {
        initialChargeId = charge!.id;
      }
      // REQ-BILL-013: immediately persist charge_id before subscription creation
      await db.updateMemberChargeId(member.id, initialChargeId, now);
    }

    // Step 13: Subscription creation (spec §5.1 step 13)
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
          discordUserId,
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
      // Reconcile: if payjp_subscription_id exists, re-fetch
      if (member.payjp_subscription_id) {
        try {
          const existingSub = await payjp.fetchSubscription(member.payjp_subscription_id);
          subscription = existingSub;
        } catch (reconcileErr) {
          slog('error', 'Subscription reconciliation failed', {
            discordUserId,
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
        // F-02: 4xx確定失敗 + 既存sub_idなし → inflightクリアして503
        slog('error', 'PAY.JP createSubscription definite failure', { discordUserId, operationId, error: String(err) });
        await clearInflightOnDefinitePayjpFailure(db, member.id, discordUserId, operationId, 'createSubscription');
        return {
          ok: false,
          statusCode: 503,
          errorCode: 'PAYJP_ERROR',
          message: 'Subscription creation failed',
          operationId,
        };
      }
    }

    // Step 14: Member state update + role sync (spec §5.1 step 14)
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
        privacy_consented_at: now,
      });
    } catch (err) {
      // DB failure after PAY.JP success — retain inflight for CLI reconciliation
      slog('error', 'DB update failed after PAY.JP subscription creation', {
        discordUserId,
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

    // Role sync (retry 3x: 0s/1s/2s wait, 1s timeout each, total ≤ 6s)
    const ROLE_SYNC_DELAYS_MS = [0, 1000, 2000];
    let roleAssigned = false;
    let lastRoleSyncError: unknown;
    for (let attempt = 0; attempt < ROLE_SYNC_MAX_RETRIES; attempt++) {
      if (ROLE_SYNC_DELAYS_MS[attempt] > 0) {
        await new Promise((r) => setTimeout(r, ROLE_SYNC_DELAYS_MS[attempt]));
      }
      try {
        await discord.assignRole(config.discordGuildId, discordUserId, config.discordPaidRoleId);
        roleAssigned = true;
        break;
      } catch (err) {
        lastRoleSyncError = err;
        const status = (err as { status?: number }).status;
        // 429 はレート制限 — バックオフ付きリトライの対象。それ以外の 4xx は再試行しない。
        const isNonRetryable4xx = status !== undefined && status >= 400 && status < 500 && status !== 429;
        if (isNonRetryable4xx) {
          slog('error', `Discord role assignment failed with non-retryable status ${status}`, {
            discordUserId,
            operationId,
            error: String(err),
          });
          break;
        }
        slog('warn', `Discord role assignment attempt ${attempt + 1} failed, retrying`, {
          discordUserId,
          operationId,
          error: String(err),
        });
      }
    }
    if (!roleAssigned && lastRoleSyncError !== undefined) {
      slog('error', 'Discord role assignment failed after all retries', {
        discordUserId,
        operationId,
        error: String(lastRoleSyncError),
      });
    }

    if (!roleAssigned) {
      // Step 7 で設定した inflight は維持される（updateMemberAfterSubscribe は inflight 列を更新しない）。
      // 運用は operationId と CLI で対応する。
      return {
        ok: false,
        statusCode: 503,
        errorCode: 'DISCORD_ROLE_SYNC_FAILED',
        message: 'Failed to assign Discord role after 3 retries',
        operationId,
      };
    }

    // P-09: ロール同期成功後に inflight をクリア。決済・Discord は完了済みのため、
    // ここでの DB 失敗はユーザーに 503 を返さずログのみ（従来は UPDATE 内で原子的にクリアしていた）。
    try {
      await db.clearInflightOperation(updatedMember.id);
    } catch (err) {
      slog('error', 'clearInflightOperation failed after successful subscribe and role sync', {
        discordUserId,
        operationId,
        memberId: updatedMember.id,
        error: String(err),
      });
    }

    slog('info', 'subscribe completed', {
      discordUserId,
      operationId,
      planId: req.planId,
      subscriptionId: subscription.id,
    });
    return { ok: true, data: buildSubscriptionResponse(updatedMember) };
  } finally {
    try {
      await db.releaseAdvisoryLock(discordUserId);
    } catch (err) {
      // Lock release failure must not mask the billing response
      slog('error', 'Advisory lock release failed', { discordUserId, error: String(err) });
    }
  }
}
