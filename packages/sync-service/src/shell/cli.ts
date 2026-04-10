/**
 * sync-service CLI — Phase 2b (Green)
 * Manual resync CLI: --operation-id / --discord-user-id / --all
 */
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
  type PlanRoleMapping,
  resolveRoleIdForPlan,
  type SubscriptionCandidate,
  shouldGrantRole,
  validateCliArgs,
} from '../core/index.js';
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
  ) => Promise<{ data: Array<{ id: string; metadata?: Record<string, string> }>; has_more: boolean }>;
  listPayjpSubscriptions: (
    customerId: string,
    offset: number,
  ) => Promise<{ data: SubscriptionCandidate[]; has_more: boolean }>;
  createPayjpCharge: (params: Record<string, unknown>) => Promise<{ id: string }>;
  createPayjpSubscription: (params: Record<string, unknown>) => Promise<{ id: string; status: string }>;
  cancelPayjpSubscription: (subscriptionId: string) => Promise<Record<string, unknown>>;
  syncRole: (userId: string, action: 'grant' | 'revoke', roleId: string) => Promise<void>;
  planRoleMapping: PlanRoleMapping;
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
    const result = await handleOperationRecovery(parsed.value!, deps, startedAt);
    processed = 1;
    if (result.success) succeeded = 1;
    else failed = 1;
  } else if (mode === 'discord-user-id') {
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

  // REQ-SYNC-019 step 1: customer_id NULL → fail-close
  if (!customerId) {
    await insertImpactLog(deps.db, memberId, 'subscribe_recovery_no_customer', operationId);
    return { success: false };
  }

  // Step 2: Check existing charge ID
  let chargeId = member.payjp_initial_charge_id as string | null;

  if (!chargeId) {
    // Step 3: Search charges
    const inflightStartedAt = member.inflight_operation_started_at as Date;
    const inflightUnix = Math.floor(inflightStartedAt.getTime() / 1000);
    const searchParams = buildChargeSearchParams(customerId, inflightUnix);

    const matches: Array<{ id: string }> = [];
    let offset = 0;
    let hasMoreAtLimit = false;

    while (offset <= 900) {
      const result = await deps.listPayjpCharges(searchParams, offset);
      for (const charge of result.data) {
        if (charge.metadata?.operation_id === operationId) {
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
      // proceed: create charge
      const charge = await deps.createPayjpCharge({
        customer: customerId,
        metadata: { discord_user_id: discordUserId, operation_id: operationId },
      });
      chargeId = charge.id;
      await deps.db.query('UPDATE members SET payjp_initial_charge_id = $1, updated_at = now() WHERE id = $2', [
        chargeId,
        memberId,
      ]);
    }
  }

  // Step 4: Check subscription existence
  let subscriptionId = member.payjp_subscription_id as string | null;
  if (!subscriptionId) {
    const sub = await deps.createPayjpSubscription({
      customer: customerId,
      metadata: { discord_user_id: discordUserId, operation_id: operationId },
    });
    subscriptionId = sub.id;
    await deps.db.query(
      'UPDATE members SET payjp_subscription_id = $1, subscription_status = $2, updated_at = now() WHERE id = $3',
      [subscriptionId, sub.status, memberId],
    );
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
    const action = shouldGrantRole(status) ? 'grant' : 'revoke';
    await syncRoleIds(deps, discordUserId, action, resolveRoleIdsForSync(planIdForSync, action, deps.planRoleMapping));

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

    const accessEndAt = member.access_end_at as Date | null;
    const accessEndAtUnix = accessEndAt ? Math.floor(accessEndAt.getTime() / 1000) : null;
    const evaluation = evaluateSubscriptionSearchResult(candidates, discordUserId ?? '', accessEndAtUnix, memberId);

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
    await deps.cancelPayjpSubscription(subscriptionId);
  }

  // Step 5: Clear inflight on confirmed integrity
  if (canResolveInflightOperation('canceled', subscriptionId, subscriptionId, customerId)) {
    await deps.db.query(
      `UPDATE members SET
        subscription_status = 'canceled',
        cancel_requested_at = now(),
        inflight_operation_id = NULL,
        inflight_operation_type = NULL,
        inflight_operation_started_at = NULL,
        updated_at = now()
       WHERE id = $1`,
      [memberId],
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
    } catch {
      failed++;
      // REQ-SYNC-030: Continue processing
      await insertImpactLog(deps.db, member.id as string, 'resync_individual_error', undefined);
    }
  }

  return { processed, succeeded, failed };
}

async function reconcileMember(member: Record<string, unknown>, deps: CliDeps): Promise<RecoveryResult> {
  const memberId = member.id as string;
  const discordUserId = member.discord_user_id as string;
  const subscriptionId = member.payjp_subscription_id as string | null;
  const planId = member.payjp_plan_id as string | null;

  // Skip members with inflight operations — these must be resolved via --operation-id
  if (member.inflight_operation_id) {
    return { success: true };
  }

  // Check access_end_at expiration
  const accessEndAt = member.access_end_at as Date | null;
  if (isAccessEndExpired(accessEndAt, deps.now())) {
    await syncRoleIds(deps, discordUserId, 'revoke', resolveRoleIdsForSync(planId, 'revoke', deps.planRoleMapping));
  }

  // Check PAY.JP subscription state
  if (subscriptionId) {
    const payjpSub = await deps.getPayjpSubscription(subscriptionId);
    if (!payjpSub) {
      // 404 → deleted
      await deps.db.query(`UPDATE members SET subscription_status = 'deleted', updated_at = now() WHERE id = $1`, [
        memberId,
      ]);
      await syncRoleIds(deps, discordUserId, 'revoke', resolveRoleIdsForSync(planId, 'revoke', deps.planRoleMapping));
    } else {
      const newStatus = payjpSub.status as string;
      await deps.db.query('UPDATE members SET subscription_status = $1, updated_at = now() WHERE id = $2', [
        newStatus,
        memberId,
      ]);
      const action = shouldGrantRole(newStatus) ? 'grant' : 'revoke';
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
      }
      for (const roleId of roleIds) {
        try {
          await deps.syncRole(discordUserId, action, roleId);
        } catch (err) {
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

  // Resolve impact logs
  await resolveImpactLog(deps.db, memberId, 'resync_individual_error');

  return { success: true };
}

// --- Role helpers ---

/** Best-effort sync for a list of roleIds. Errors are swallowed (callers that need per-error logging handle their own loop). */
async function syncRoleIds(
  deps: CliDeps,
  discordUserId: string,
  action: 'grant' | 'revoke',
  roleIds: string[],
): Promise<void> {
  for (const roleId of roleIds) {
    try {
      await deps.syncRole(discordUserId, action, roleId);
    } catch {
      /* best-effort; logged in syncRole */
    }
  }
}

/** Resolve roleId(s) for sync. If planId maps to a role, return it. Otherwise fallback to all roles (safety). */
function resolveRoleIdsForSync(planId: string | null, action: 'grant' | 'revoke', mapping: PlanRoleMapping): string[] {
  const roleId = resolveRoleIdForPlan(planId, mapping);
  if (roleId) return [roleId];
  // Unknown plan → for revoke, try all roles; for grant, no-op (can't grant without known plan)
  if (action === 'revoke') return Object.values(mapping);
  return [];
}

// --- DB helpers ---

async function insertImpactLog(db: DbPool, memberId: string, issueCode: string, operationId?: string): Promise<void> {
  await db.query(
    `INSERT INTO member_impact_logs (member_id, issue_code, operation_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (member_id, issue_code) WHERE resolved_at IS NULL DO NOTHING`,
    [memberId, issueCode, operationId ?? null],
  );
}

async function resolveImpactLog(db: DbPool, memberId: string, issueCode: string): Promise<void> {
  await db.query(
    `UPDATE member_impact_logs
     SET resolved_at = now()
     WHERE member_id = $1 AND issue_code = $2 AND resolved_at IS NULL`,
    [memberId, issueCode],
  );
}
