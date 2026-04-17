/**
 * sync-service CLI — Phase 2b (Green)
 * Manual resync CLI: --operation-id / --discord-user-id / --all
 */
import { calculateTrialEnd, isFirstTimeUser } from '@hayane/billing-service';
import type { LogEntry } from '@hayane/shared';
import {
  buildChargeSearchParams,
  buildCliResult,
  type CliResult,
  calculateLastEventTimestamp,
  canResolveInflightOperation,
  determineCliExitCode,
  evaluateChargeSearchResult,
  evaluateSubscriptionSearchResult,
  formatRfc3339Utc,
  isAccessEndExpired,
  isInflightOperationStale,
  mapSubscriptionStatus,
  type PlanRoleMapping,
  resolveRoleIdForPlan,
  type SubscriptionCandidate,
  shouldGrantPaidDiscordAccess,
  validateCliArgs,
} from '../core/index.js';
import { insertImpactLog, ROLE_SYNC_FAILED_WEBHOOK, resolveImpactLog } from './member-impact-log.js';
import type { DbPool } from './types.js';

/** Plan id from PAY.JP subscription object (`plan.id` or legacy `plan_id`). */
function payjpSubscriptionPlanId(sub: Record<string, unknown> | null | undefined): string | null {
  if (!sub) return null;
  const plan = sub.plan;
  if (plan && typeof plan === 'object' && plan !== null) {
    const id = (plan as Record<string, unknown>).id;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  const top = sub.plan_id;
  if (typeof top === 'string' && top.length > 0) return top;
  return null;
}

export interface CliDeps {
  db: DbPool;
  getPayjpSubscription: (subscriptionId: string) => Promise<Record<string, unknown> | null>;
  listPayjpCharges: (
    params: { customer: string; since: number; until: number; limit: number },
    offset: number,
  ) => Promise<{
    data: Array<{ id: string; paid: boolean; metadata?: Record<string, string> }>;
    has_more: boolean;
  }>;
  listPayjpSubscriptions: (
    customerId: string,
    offset: number,
  ) => Promise<{ data: SubscriptionCandidate[]; has_more: boolean }>;
  createPayjpCharge: (params: Record<string, unknown>) => Promise<{ id: string }>;
  createPayjpSubscription: (params: Record<string, unknown>) => Promise<{ id: string; status: string }>;
  cancelPayjpSubscription: (subscriptionId: string) => Promise<Record<string, unknown>>;
  syncRole: (userId: string, action: 'grant' | 'revoke', roleId: string) => Promise<void>;
  planRoleMapping: PlanRoleMapping;
  /** Initial charge amounts (JPY) keyed by PAY.JP plan id — subscribe recovery. */
  planInitialChargeAmounts: Record<string, number>;
  initialChargeCurrency: string;
  log: (entry: LogEntry) => void;
  now: () => Date;
}

export interface CliOutput {
  exitCode: 0 | 1 | 2;
  result: CliResult;
}

export async function runResyncCli(args: string[], deps: CliDeps): Promise<CliOutput> {
  const startedAt = deps.now();
  const parsed = validateCliArgs(args);

  if (!parsed.ok) {
    const finishedAt = deps.now();
    return {
      exitCode: 1,
      result: buildCliResult({
        mode: 'error',
        target: 'none',
        processedCount: 0,
        succeededCount: 0,
        failedCount: 0,
        startedAt,
        finishedAt,
      }),
    };
  }

  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  const mode = parsed.mode!;

  if (mode === 'operation-id') {
    // V3-M7: Add try/catch for handleOperationRecovery
    try {
      const result = await handleOperationRecovery(parsed.value!, deps, startedAt);
      processed = 1;
      if (result.success) succeeded = 1;
      else failed = 1;
    } catch (err) {
      deps.log({
        timestamp: formatRfc3339Utc(deps.now()),
        service: 'sync-service',
        endpoint: 'cli/resync',
        result: 'error',
        error: 'handleOperationRecovery_failed',
        operation_id: parsed.value,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      try {
        const idRes = await deps.db.query('SELECT id FROM members WHERE inflight_operation_id = $1', [parsed.value]);
        const row = idRes.rows[0] as { id: string } | undefined;
        if (row) {
          await insertImpactLog(deps.db, row.id, 'cli_operation_recovery_failed', parsed.value, {
            error: String(err),
          });
        }
      } catch {
        /* ignore secondary DB errors */
      }
      processed = 1;
      failed = 1;
    }
  } else if (mode === 'discord-user-id') {
    // V3-M7: Add try/catch for handleUserReconciliation
    try {
      const result = await handleUserReconciliation(parsed.value!, deps);
      if (result.notFound) {
        // Member not found → CLI error (exit 1)
        const finishedAt = deps.now();
        return {
          exitCode: 1,
          result: buildCliResult({
            mode,
            target: parsed.value!,
            processedCount: 0,
            succeededCount: 0,
            failedCount: 0,
            startedAt,
            finishedAt,
          }),
        };
      }
      processed = 1;
      if (result.success) succeeded = 1;
      else failed = 1;
    } catch (err) {
      deps.log({
        timestamp: formatRfc3339Utc(deps.now()),
        service: 'sync-service',
        endpoint: 'cli/resync',
        result: 'error',
        error: 'handleUserReconciliation_failed',
        discord_user_id: parsed.value,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      try {
        const idRes = await deps.db.query('SELECT id FROM members WHERE discord_user_id = $1', [parsed.value]);
        const row = idRes.rows[0] as { id: string } | undefined;
        if (row) {
          await insertImpactLog(deps.db, row.id, 'cli_user_reconciliation_failed', undefined, {
            error: String(err),
            discord_user_id: parsed.value,
          });
        }
      } catch {
        /* ignore secondary DB errors */
      }
      processed = 1;
      failed = 1;
    }
  } else {
    // --all
    const result = await handleAllReconciliation(deps);
    processed = result.processed;
    succeeded = result.succeeded;
    failed = result.failed;
  }

  const finishedAt = deps.now();
  const cliResult = buildCliResult({
    mode,
    target: mode === 'all' ? 'all' : (parsed.value ?? 'unknown'),
    processedCount: processed,
    succeededCount: succeeded,
    failedCount: failed,
    startedAt,
    finishedAt,
  });

  return {
    exitCode: determineCliExitCode(failed, false),
    result: cliResult,
  };
}

interface RecoveryResult {
  success: boolean;
}

async function handleOperationRecovery(
  operationId: string,
  deps: CliDeps,
  resyncStartedAt: Date,
): Promise<RecoveryResult> {
  // Find member by inflight_operation_id
  const memberRes = await deps.db.query('SELECT * FROM members WHERE inflight_operation_id = $1', [operationId]);
  const member = memberRes.rows[0] as Record<string, unknown> | undefined;
  if (!member) return { success: false };

  const operationType = member.inflight_operation_type as string;

  // REQ-SYNC-024: Check staleness thresholds
  const inflightStartedAt = member.inflight_operation_started_at as Date | null;
  if (isInflightOperationStale(inflightStartedAt, deps.now(), 360)) {
    // 6+ hours → escalation (REQ-SYNC-024)
    deps.log({
      timestamp: formatRfc3339Utc(deps.now()),
      service: 'sync-service',
      endpoint: 'cli/resync',
      result: 'error',
      issue: 'escalation_6h_inflight',
      member_id: member.id as string,
      operation_id: operationId,
      resolution_possible: false,
      assignee: process.env.ESCALATION_ASSIGNEE ?? 'unassigned',
      detected_at: formatRfc3339Utc(deps.now()),
    });
    await insertImpactLog(deps.db, member.id as string, 'escalation_6h_inflight', operationId);
  } else if (isInflightOperationStale(inflightStartedAt, deps.now(), 30)) {
    // 30+ min → warning
    deps.log({
      timestamp: formatRfc3339Utc(deps.now()),
      service: 'sync-service',
      endpoint: 'cli/resync',
      result: 'failure',
      issue: 'inflight_30min_warning',
      member_id: member.id as string,
      operation_id: operationId,
    });
  }

  if (operationType === 'subscribe') {
    return handleSubscribeRecovery(member, operationId, deps, resyncStartedAt);
  } else if (operationType === 'cancel') {
    return handleCancelRecovery(member, operationId, deps, resyncStartedAt);
  }

  deps.log({
    timestamp: formatRfc3339Utc(deps.now()),
    service: 'sync-service',
    endpoint: 'cli/resync',
    result: 'error',
    error: 'unknown_operation_type',
    member_id: member.id as string,
    operation_id: operationId,
    operation_type: operationType,
  });
  return { success: false };
}

async function handleSubscribeRecovery(
  member: Record<string, unknown>,
  operationId: string,
  deps: CliDeps,
  resyncStartedAt: Date,
): Promise<RecoveryResult> {
  const customerId = member.payjp_customer_id as string | null;
  const memberId = member.id as string;
  const discordUserId = member.discord_user_id as string;

  const planId = (member.inflight_subscribe_plan_id as string | null) ?? (member.payjp_plan_id as string | null);
  if (!planId) {
    await insertImpactLog(deps.db, memberId, 'subscribe_recovery_no_plan', operationId);
    return { success: false };
  }

  const metaBase = {
    discord_user_id: discordUserId,
    operation_id: operationId,
    member_id: memberId,
  } as const;

  const isFirstTime = isFirstTimeUser(member.first_trial_granted_at as Date | null);

  // REQ-SYNC-019 step 1: customer_id NULL → fail-close
  if (!customerId) {
    await insertImpactLog(deps.db, memberId, 'subscribe_recovery_no_customer', operationId);
    return { success: false };
  }

  // Step 2: Check existing charge ID (initial charge only for first-time subscribers — matches subscribe.ts Step 12)
  let chargeId = member.payjp_initial_charge_id as string | null;

  if (!chargeId && isFirstTime) {
    // Step 3: Search charges
    const inflightStartedAt = member.inflight_operation_started_at as Date | null;
    if (!inflightStartedAt) {
      await insertImpactLog(deps.db, memberId, 'subscribe_recovery_no_inflight_started_at', operationId);
      return { success: false };
    }
    const inflightUnix = Math.floor(inflightStartedAt.getTime() / 1000);
    const searchParams = buildChargeSearchParams(customerId, inflightUnix);

    const matches: Array<{ id: string }> = [];
    let offset = 0;
    let hasMoreAtLimit = false;

    while (offset <= 900) {
      const result = await deps.listPayjpCharges(searchParams, offset);
      for (const charge of result.data) {
        // H4 fix: metadata 一致かつ paid=true のみ採用。未決済 charge を DB に書くと課金整合性崩壊。
        if (charge.metadata?.operation_id === operationId && charge.paid === true) {
          matches.push(charge);
        }
      }
      if (!result.has_more) break;
      offset += 100;
      if (offset > 900 && result.has_more) {
        hasMoreAtLimit = true;
        break;
      }
    }

    const evaluation = evaluateChargeSearchResult(matches.length, hasMoreAtLimit);
    if (evaluation === 'fail-close') {
      await insertImpactLog(deps.db, memberId, 'subscribe_recovery_charge_ambiguous', operationId);
      return { success: false };
    } else if (evaluation === 'existing') {
      chargeId = matches[0].id;
      await deps.db.query('UPDATE members SET payjp_initial_charge_id = $1, updated_at = now() WHERE id = $2', [
        chargeId,
        memberId,
      ]);
    } else {
      // proceed: create charge (plan-based amount)
      const amount = deps.planInitialChargeAmounts[planId] ?? 1000;
      // V3-M9: Add try/catch for createPayjpCharge
      try {
        const charge = await deps.createPayjpCharge({
          customer: customerId,
          amount,
          currency: deps.initialChargeCurrency,
          metadata: { ...metaBase },
        });
        chargeId = charge.id;
        try {
          await deps.db.query('UPDATE members SET payjp_initial_charge_id = $1, updated_at = now() WHERE id = $2', [
            chargeId,
            memberId,
          ]);
        } catch (dbErr) {
          deps.log({
            timestamp: formatRfc3339Utc(deps.now()),
            service: 'sync-service',
            endpoint: 'cli/subscribe-recovery',
            result: 'error',
            error: 'payjp_createCharge_db_update_failed',
            member_id: memberId,
            operation_id: operationId,
            payjp_charge_id: chargeId,
            errorMessage: dbErr instanceof Error ? dbErr.message : String(dbErr),
          });
          await insertImpactLog(deps.db, memberId, 'subscribe_recovery_payjp_charge_db_update_failed', operationId, {
            payjp_charge_id: chargeId,
          });
          return { success: false };
        }
      } catch (err) {
        deps.log({
          timestamp: formatRfc3339Utc(deps.now()),
          service: 'sync-service',
          endpoint: 'cli/subscribe-recovery',
          result: 'failure',
          error: 'payjp_createCharge_failed',
          member_id: memberId,
          operation_id: operationId,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
        await insertImpactLog(deps.db, memberId, 'subscribe_recovery_payjp_charge_failed', operationId);
        return { success: false };
      }
    }
  }

  // Step 4: Check subscription existence (search PAY.JP first — idempotent recovery)
  let subscriptionId = member.payjp_subscription_id as string | null;
  if (!subscriptionId) {
    let found: SubscriptionCandidate | undefined;
    let subOffset = 0;
    let subHasMoreAtLimit = false;
    while (subOffset <= 900) {
      const result = await deps.listPayjpSubscriptions(customerId, subOffset);
      for (const sub of result.data) {
        const mid = sub.metadata?.member_id;
        const oid = sub.metadata?.operation_id;
        if (mid === memberId || oid === operationId) {
          found = sub;
          break;
        }
      }
      if (found) break;
      if (!result.has_more) break;
      subOffset += 100;
      if (subOffset > 900 && result.has_more) {
        subHasMoreAtLimit = true;
        break;
      }
    }

    if (subHasMoreAtLimit) {
      await insertImpactLog(deps.db, memberId, 'subscribe_recovery_subscription_ambiguous', operationId);
      return { success: false };
    }

    if (found) {
      subscriptionId = found.id;
      const mappedStatus = mapSubscriptionStatus(found.status as string);
      if (!mappedStatus) {
        await insertImpactLog(deps.db, memberId, 'subscribe_recovery_subscription_ambiguous', operationId);
        return { success: false };
      }
      await deps.db.query(
        'UPDATE members SET payjp_subscription_id = $1, subscription_status = $2, updated_at = now() WHERE id = $3',
        [subscriptionId, mappedStatus, memberId],
      );
    } else {
      const subParams: Record<string, unknown> = {
        customer: customerId,
        plan: planId,
        metadata: { ...metaBase },
      };
      if (isFirstTime) {
        subParams.trial_end = Math.floor(calculateTrialEnd(deps.now()).getTime() / 1000);
      }
      // V3-M9: Add try/catch for createPayjpSubscription
      try {
        const sub = await deps.createPayjpSubscription(subParams);
        subscriptionId = sub.id;
        const mappedSubStatus = mapSubscriptionStatus(sub.status as string);
        if (!mappedSubStatus) {
          await insertImpactLog(deps.db, memberId, 'subscribe_recovery_subscription_ambiguous', operationId);
          return { success: false };
        }
        try {
          await deps.db.query(
            'UPDATE members SET payjp_subscription_id = $1, subscription_status = $2, updated_at = now() WHERE id = $3',
            [subscriptionId, mappedSubStatus, memberId],
          );
        } catch (dbErr) {
          deps.log({
            timestamp: formatRfc3339Utc(deps.now()),
            service: 'sync-service',
            endpoint: 'cli/subscribe-recovery',
            result: 'error',
            error: 'payjp_createSubscription_db_update_failed',
            member_id: memberId,
            operation_id: operationId,
            payjp_subscription_id: subscriptionId,
            errorMessage: dbErr instanceof Error ? dbErr.message : String(dbErr),
          });
          await insertImpactLog(
            deps.db,
            memberId,
            'subscribe_recovery_payjp_subscription_db_update_failed',
            operationId,
            {
              payjp_subscription_id: subscriptionId,
            },
          );
          return { success: false };
        }
      } catch (err) {
        deps.log({
          timestamp: formatRfc3339Utc(deps.now()),
          service: 'sync-service',
          endpoint: 'cli/subscribe-recovery',
          result: 'failure',
          error: 'payjp_createSubscription_failed',
          member_id: memberId,
          operation_id: operationId,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
        await insertImpactLog(deps.db, memberId, 'subscribe_recovery_payjp_subscription_failed', operationId);
        return { success: false };
      }
    }
  }

  // Step 5: Update member, sync role, clear inflight
  const payjpSub = await deps.getPayjpSubscription(subscriptionId);
  if (
    payjpSub &&
    canResolveInflightOperation(payjpSub.status as string, payjpSub.id as string, subscriptionId, customerId)
  ) {
    const status = payjpSub.status as string;
    const planIdFromPayjp = payjpSubscriptionPlanId(payjpSub as Record<string, unknown>);
    await deps.db.query(
      `UPDATE members SET
        subscription_status = $1,
        payjp_plan_id = COALESCE(payjp_plan_id, $3),
        inflight_operation_id = NULL,
        inflight_operation_type = NULL,
        inflight_operation_started_at = NULL,
        updated_at = now()
       WHERE id = $2`,
      [status, memberId, planIdFromPayjp],
    );

    // Step 6: Update last_payjp_event_created_at
    const existing = member.last_payjp_event_created_at as number | null;
    const resyncUnix = Math.floor(resyncStartedAt.getTime() / 1000);
    const newTimestamp = calculateLastEventTimestamp(existing, resyncUnix);
    await deps.db.query('UPDATE members SET last_payjp_event_created_at = $1, updated_at = now() WHERE id = $2', [
      newTimestamp,
      memberId,
    ]);

    // Sync role — use PAY.JP subscription plan when member row has not persisted payjp_plan_id yet
    const planIdForSync = (member.payjp_plan_id as string | null) ?? planIdFromPayjp;
    const cpe = (payjpSub as { current_period_end?: number }).current_period_end;
    const accessEndAt = cpe != null && cpe !== 0 ? new Date(cpe * 1000) : (member.access_end_at as Date | null);
    const action = shouldGrantPaidDiscordAccess(status, accessEndAt, deps.now()) ? 'grant' : 'revoke';
    const roleIdsForRecovery = resolveRoleIdsForSync(planIdForSync, action, deps.planRoleMapping);
    const syncOk = await syncRoleIds(deps, discordUserId, action, roleIdsForRecovery);
    if (roleIdsForRecovery.length > 0 && syncOk) {
      await resolveImpactLog(deps.db, memberId, ROLE_SYNC_FAILED_WEBHOOK);
    }

    // Resolve impact logs
    await resolveImpactLog(deps.db, memberId, 'subscribe_recovery_no_customer');
    await resolveImpactLog(deps.db, memberId, 'subscribe_recovery_charge_ambiguous');

    return { success: true };
  }

  await insertImpactLog(deps.db, memberId, 'subscribe_recovery_integrity_fail', operationId);
  return { success: false };
}

async function handleCancelRecovery(
  member: Record<string, unknown>,
  operationId: string,
  deps: CliDeps,
  resyncStartedAt: Date,
): Promise<RecoveryResult> {
  const customerId = member.payjp_customer_id as string | null;
  const memberId = member.id as string;
  const discordUserId = (member.discord_user_id as string | null) ?? '';

  // REQ-SYNC-020 step 1
  if (!customerId) {
    await insertImpactLog(deps.db, memberId, 'cancel_recovery_no_customer', operationId);
    return { success: false };
  }

  // Step 2: Check subscription ID
  let subscriptionId = member.payjp_subscription_id as string | null;

  if (!subscriptionId) {
    // Step 3: Search subscriptions
    const candidates: SubscriptionCandidate[] = [];
    let offset = 0;

    while (offset <= 900) {
      const result = await deps.listPayjpSubscriptions(customerId, offset);
      for (const sub of result.data) {
        if (['active', 'trial', 'canceled', 'paused'].includes(sub.status)) {
          candidates.push(sub);
        }
      }
      if (!result.has_more) break;
      offset += 100;
      if (offset > 900 && result.has_more) {
        await insertImpactLog(deps.db, memberId, 'cancel_recovery_subscription_ambiguous', operationId);
        return { success: false };
      }
    }

    const nextBillingAt = member.next_billing_at as Date | null;
    const nextBillingAtUnix = nextBillingAt ? Math.floor(nextBillingAt.getTime() / 1000) : null;
    const evaluation = evaluateSubscriptionSearchResult(candidates, discordUserId ?? '', nextBillingAtUnix, memberId);

    if (evaluation === 'fail-close') {
      await insertImpactLog(deps.db, memberId, 'cancel_recovery_subscription_ambiguous', operationId);
      return { success: false };
    }

    subscriptionId = candidates[0].id;
    await deps.db.query('UPDATE members SET payjp_subscription_id = $1, updated_at = now() WHERE id = $2', [
      subscriptionId,
      memberId,
    ]);
  }

  // Step 4: Cancel only if not already canceled
  const payjpSub = await deps.getPayjpSubscription(subscriptionId);
  if (!payjpSub) {
    await insertImpactLog(deps.db, memberId, 'cancel_recovery_subscription_not_found', operationId);
    return { success: false };
  }

  if (payjpSub.status !== 'canceled') {
    // V3-M9: Add try/catch for PAY.JP API call
    try {
      await deps.cancelPayjpSubscription(subscriptionId);
    } catch (err) {
      deps.log({
        timestamp: formatRfc3339Utc(deps.now()),
        service: 'sync-service',
        endpoint: 'cli/cancel-recovery',
        result: 'failure',
        error: 'payjp_cancel_failed',
        member_id: memberId,
        operation_id: operationId,
        payjp_subscription_id: subscriptionId,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      await insertImpactLog(deps.db, memberId, 'cancel_recovery_payjp_call_failed', operationId);
      return { success: false };
    }
  }

  // Step 5: Clear inflight on confirmed integrity
  if (canResolveInflightOperation('canceled', payjpSub.id as string, subscriptionId, customerId)) {
    const periodEndUnix = (payjpSub as { current_period_end?: number }).current_period_end;
    const periodEndDate = periodEndUnix != null && periodEndUnix !== 0 ? new Date(periodEndUnix * 1000) : deps.now();
    await deps.db.query(
      `UPDATE members SET
        subscription_status = 'canceled',
        cancel_requested_at = now(),
        access_end_at = $2,
        next_billing_at = $2,
        inflight_operation_id = NULL,
        inflight_operation_type = NULL,
        inflight_operation_started_at = NULL,
        updated_at = now()
       WHERE id = $1`,
      [memberId, periodEndDate],
    );

    const existing = member.last_payjp_event_created_at as number | null;
    const resyncUnix = Math.floor(resyncStartedAt.getTime() / 1000);
    const newTimestamp = calculateLastEventTimestamp(existing, resyncUnix);
    await deps.db.query('UPDATE members SET last_payjp_event_created_at = $1, updated_at = now() WHERE id = $2', [
      newTimestamp,
      memberId,
    ]);

    await resolveImpactLog(deps.db, memberId, 'cancel_recovery_no_customer');
    await resolveImpactLog(deps.db, memberId, 'cancel_recovery_subscription_ambiguous');

    return { success: true };
  }

  return { success: false };
}

async function handleUserReconciliation(
  discordUserId: string,
  deps: CliDeps,
): Promise<RecoveryResult & { notFound?: boolean }> {
  const memberRes = await deps.db.query('SELECT * FROM members WHERE discord_user_id = $1', [discordUserId]);
  const member = memberRes.rows[0] as Record<string, unknown> | undefined;
  if (!member) return { success: false, notFound: true };

  return reconcileMember(member, deps);
}

async function handleAllReconciliation(
  deps: CliDeps,
): Promise<{ processed: number; succeeded: number; failed: number }> {
  const allRes = await deps.db.query('SELECT * FROM members', []);
  const members = allRes.rows as Array<Record<string, unknown>>;

  let processed = 0;
  let succeeded = 0;
  let failed = 0;

  for (const member of members) {
    processed++;
    try {
      const result = await reconcileMember(member, deps);
      if (result.success) succeeded++;
      else failed++;
    } catch (err) {
      failed++;
      deps.log({
        timestamp: formatRfc3339Utc(deps.now()),
        service: 'sync-service',
        endpoint: 'cli/resync',
        result: 'error',
        error: 'reconcile_member_threw',
        member_id: member.id as string,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      // REQ-SYNC-030: Continue processing — best-effort impact log
      try {
        await insertImpactLog(deps.db, member.id as string, 'resync_individual_error', undefined);
      } catch (impactErr) {
        deps.log({
          timestamp: formatRfc3339Utc(deps.now()),
          service: 'sync-service',
          endpoint: 'cli/resync',
          result: 'error',
          error: 'impact_log_insert_failed_in_error_path',
          member_id: member.id as string,
          errorMessage: impactErr instanceof Error ? impactErr.message : String(impactErr),
        });
      }
    }
  }

  return { processed, succeeded, failed };
}

async function reconcileMember(member: Record<string, unknown>, deps: CliDeps): Promise<RecoveryResult> {
  const memberId = member.id as string;
  // V3-M8: Handle nullable discord_user_id (DROP NOT NULL in migration)
  const discordUserId = member.discord_user_id as string | null;
  const subscriptionId = member.payjp_subscription_id as string | null;
  const planId = member.payjp_plan_id as string | null;

  // Skip members with inflight operations — these must be resolved via --operation-id (count as failure for --all)
  if (member.inflight_operation_id) {
    return { success: false };
  }

  // V3-M8: Skip role sync if discord_user_id is null
  if (!discordUserId) {
    return { success: true };
  }

  let discordSyncAttempted = false;
  let discordSyncAllOk = true;

  const accessEndAt = member.access_end_at as Date | null;
  const accessExpired = isAccessEndExpired(accessEndAt, deps.now());

  // No PAY.JP subscription id — only expired access forces a revoke
  if (!subscriptionId) {
    if (accessExpired) {
      const roleIds = resolveRoleIdsForSync(planId, 'revoke', deps.planRoleMapping);
      if (roleIds.length > 0) {
        discordSyncAttempted = true;
        discordSyncAllOk = await syncRoleIds(deps, discordUserId, 'revoke', roleIds);
      }
    }
  } else {
    // PAY.JP subscription state — member access_end expiry overrides PAY.JP period/grace when reconciling roles
    const payjpSub = await deps.getPayjpSubscription(subscriptionId);
    if (!payjpSub) {
      await deps.db.query(`UPDATE members SET subscription_status = 'deleted', updated_at = now() WHERE id = $1`, [
        memberId,
      ]);
      const roleIds = resolveRoleIdsForSync(planId, 'revoke', deps.planRoleMapping);
      if (roleIds.length > 0) {
        discordSyncAttempted = true;
        discordSyncAllOk = await syncRoleIds(deps, discordUserId, 'revoke', roleIds);
      }
    } else {
      const newStatus = payjpSub.status as string;
      await deps.db.query('UPDATE members SET subscription_status = $1, updated_at = now() WHERE id = $2', [
        newStatus,
        memberId,
      ]);
      const cpe = (payjpSub as { current_period_end?: number }).current_period_end;
      const mergedAccessEnd = cpe != null && cpe !== 0 ? new Date(cpe * 1000) : (member.access_end_at as Date | null);
      const entitled = shouldGrantPaidDiscordAccess(newStatus, mergedAccessEnd, deps.now());
      const action: 'grant' | 'revoke' = accessExpired || !entitled ? 'revoke' : 'grant';
      const roleIds = resolveRoleIdsForSync(planId, action, deps.planRoleMapping);
      if (roleIds.length === 0 && action === 'grant') {
        deps.log({
          timestamp: formatRfc3339Utc(deps.now()),
          service: 'sync-service',
          endpoint: 'cli/resync',
          result: 'failure',
          error: 'unmapped_plan_grant_skipped',
          member_id: memberId,
          payjp_plan_id: planId ?? 'null',
        });
        discordSyncAttempted = true;
        discordSyncAllOk = false;
      }
      for (const roleId of roleIds) {
        discordSyncAttempted = true;
        try {
          await deps.syncRole(discordUserId, action, roleId);
        } catch (err) {
          discordSyncAllOk = false;
          deps.log({
            timestamp: formatRfc3339Utc(deps.now()),
            service: 'sync-service',
            endpoint: 'cli/resync',
            result: 'failure',
            error: 'role_sync_failed',
            member_id: memberId,
            discord_user_id: discordUserId,
            action,
            roleId,
            syncError: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  await resolveImpactLog(deps.db, memberId, 'resync_individual_error');
  if (discordSyncAttempted && discordSyncAllOk) {
    await resolveImpactLog(deps.db, memberId, ROLE_SYNC_FAILED_WEBHOOK);
  }

  return { success: !discordSyncAttempted || discordSyncAllOk };
}

// --- Role helpers ---

/** Sync a list of roleIds. Returns true iff every call succeeded (true vacuously when roleIds is empty). */
async function syncRoleIds(
  deps: CliDeps,
  discordUserId: string,
  action: 'grant' | 'revoke',
  roleIds: string[],
): Promise<boolean> {
  let allOk = true;
  for (const roleId of roleIds) {
    try {
      await deps.syncRole(discordUserId, action, roleId);
    } catch (err) {
      allOk = false;
      deps.log({
        timestamp: formatRfc3339Utc(deps.now()),
        service: 'sync-service',
        endpoint: 'cli/syncRoleIds',
        result: 'error',
        error: 'sync_role_failed',
        discord_user_id: discordUserId,
        action,
        role_id: roleId,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return allOk;
}

/** Resolve roleId(s) for sync. If planId maps to a role, return it. Otherwise fallback to all roles (safety). */
function resolveRoleIdsForSync(planId: string | null, action: 'grant' | 'revoke', mapping: PlanRoleMapping): string[] {
  const roleId = resolveRoleIdForPlan(planId, mapping);
  if (roleId) return [roleId];
  // Unknown plan → for revoke, try all roles; for grant, no-op (can't grant without known plan)
  if (action === 'revoke') return Object.values(mapping);
  return [];
}
