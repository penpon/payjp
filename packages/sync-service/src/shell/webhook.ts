/**
 * sync-service Webhook Handler — Phase 2b (Green)
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { LogEntry } from '@hayane/shared';
import {
  buildTokenMismatchLog,
  determineIgnoreReason,
  formatRfc3339Utc,
  isEventStale,
  isStatusUnknown,
  isSubscriptionCreatedEvent,
  mapSubscriptionStatus,
  maskSensitiveLogFields,
  resolveEffectiveSubscriptionStatus,
  resolveRoleIdForPlan,
  shouldGrantPaidDiscordAccess,
  shouldSwapRole,
  shouldSyncRole,
  validateRequiredFields,
  validateWebhookToken,
  type WebhookEvent,
} from '../core/index.js';
import { insertImpactLog, ROLE_SYNC_FAILED_WEBHOOK } from './member-impact-log.js';
import type { DbPool, PayjpEventInsert, WebhookHandlerDeps, WebhookRequest, WebhookResponse } from './types.js';

// Constant-time string comparison via HMAC — normalizes length and prevents timing leaks from Buffer allocation
function constantTimeCompare(a: string, b: string): boolean {
  const key = 'webhook-token-cmp';
  const ha = createHmac('sha256', key).update(a).digest();
  const hb = createHmac('sha256', key).update(b).digest();
  return timingSafeEqual(ha, hb);
}

export async function handleWebhook(req: WebhookRequest, deps: WebhookHandlerDeps): Promise<WebhookResponse> {
  const receivedToken = req.headers['x-payjp-webhook-token'] ?? '';

  // REQ-SYNC-001: Token verification (constant-time via timingSafeEqual)
  if (!validateWebhookToken(receivedToken, deps.payjpWebhookToken, constantTimeCompare)) {
    const now = formatRfc3339Utc(new Date());
    const mismatchLog = buildTokenMismatchLog(
      { type: (req.body as Record<string, unknown>)?.type ?? 'unknown' },
      now,
      req.remoteIp,
      'token_mismatch',
    );
    deps.log(
      maskSensitiveLogFields({
        timestamp: now,
        service: 'sync-service',
        endpoint: '/v1/payjp/webhook',
        result: 'failure',
        ...mismatchLog,
      }) as LogEntry,
    );
    return { status: 401, body: { error: 'Unauthorized' } };
  }

  const event = req.body as WebhookEvent;

  // REQ-SYNC-002/003/004: Ignore checks
  const ignoreReason = determineIgnoreReason(event, deps.expectedLivemode);
  if (ignoreReason) {
    try {
      await insertPayjpEvent(deps.db, {
        id: event.id ?? `unknown-${crypto.randomUUID()}`,
        event_type: event.type ?? 'unknown',
        payload: event,
        processing_result: 'ignored',
        ignore_reason: ignoreReason,
        data_metadata_operation_id: event.data?.metadata?.operation_id ?? null,
      });
    } catch (err) {
      return handleDbError(err, deps, event.id, event.type);
    }
    return { status: 200, body: { ok: true } };
  }

  // REQ-SYNC-005: Required field validation
  const fieldResult = validateRequiredFields(event);
  if (!fieldResult.ok) {
    try {
      await insertPayjpEvent(deps.db, {
        id: event.id ?? `unknown-${crypto.randomUUID()}`,
        event_type: event.type ?? 'unknown',
        payload: event,
        processing_result: 'failed',
        fail_reason: `missing_fields:${fieldResult.missingFields.join(',')}`,
        data_metadata_operation_id: event.data?.metadata?.operation_id ?? null,
      });
    } catch (err) {
      return handleDbError(err, deps, event.id, event.type);
    }
    return { status: 200, body: { ok: true } };
  }

  // REQ-SYNC-006: Idempotency
  try {
    const existing = await findPayjpEvent(deps.db, event.id!);
    if (existing) {
      return { status: 200, body: { ok: true } };
    }
  } catch (err) {
    return handleDbError(err, deps, event.id, event.type);
  }

  // REQ-SYNC-008: subscription.created → ignored
  if (isSubscriptionCreatedEvent(event.type!)) {
    try {
      await insertPayjpEvent(deps.db, {
        id: event.id!,
        event_type: event.type!,
        payload: event,
        processing_result: 'ignored',
        ignore_reason: 'subscription_created',
        data_metadata_operation_id: event.data?.metadata?.operation_id ?? null,
      });
    } catch (err) {
      return handleDbError(err, deps, event.id, event.type);
    }
    return { status: 200, body: { ok: true } };
  }

  // REQ-SYNC-029: Acquire per-member advisory lock before member resolution/update
  // Use hashtext for consistency with billing-service's lock strategy
  const discordUserIdFromMetadata = event.data?.metadata?.discord_user_id;
  const memberIdFromMetadata = event.data?.metadata?.member_id;

  // REQ-SYNC-009: Member resolution
  let member: Record<string, unknown> | null = null;
  try {
    member = await resolveMember(deps.db, discordUserIdFromMetadata, event.data!.id!, memberIdFromMetadata);
  } catch (err) {
    if (err instanceof MemberResolutionConflictError) {
      try {
        await insertPayjpEvent(deps.db, {
          id: event.id!,
          event_type: event.type!,
          payload: event,
          processing_result: 'failed',
          fail_reason: 'member_resolution_conflict',
          data_metadata_operation_id: event.data?.metadata?.operation_id ?? null,
        });
      } catch (insertErr) {
        return handleDbError(insertErr, deps, event.id, event.type);
      }
      return { status: 200, body: { ok: true } };
    }
    return handleDbError(err, deps, event.id, event.type);
  }

  if (!member) {
    try {
      await insertPayjpEvent(deps.db, {
        id: event.id!,
        event_type: event.type!,
        payload: event,
        processing_result: 'failed',
        fail_reason: 'member_not_found',
        data_metadata_operation_id: event.data?.metadata?.operation_id ?? null,
      });
    } catch (err) {
      return handleDbError(err, deps, event.id, event.type);
    }
    return { status: 200, body: { ok: true } };
  }

  // --- Transactional section: lock + stale check + status update + event insert ---
  // Uses withTransaction to guarantee all queries run on the same connection (BEGIN/COMMIT/ROLLBACK)
  const lockKey = (member.discord_user_id as string | null) ?? (member.id as string);

  type TxResult =
    | { type: 'member_not_found' }
    | { type: 'stale'; lockedMember: Record<string, unknown> }
    | { type: 'unknown_status'; lockedMember: Record<string, unknown> }
    | {
        type: 'processed';
        lockedMember: Record<string, unknown>;
        statusChanged: boolean;
        action?: 'grant' | 'revoke';
        planChanged: boolean;
        oldPlanId: string | null;
        newPlanId: string | null;
        mergedAccessEndAt: Date | null;
      };

  let txResult: TxResult;
  try {
    txResult = await deps.db.withTransaction(async (query) => {
      const txDb: DbPool = {
        query,
        withTransaction: () => {
          throw new Error('nested transactions not supported');
        },
      };

      // Advisory lock inside transaction — released automatically on COMMIT/ROLLBACK
      await query('SELECT pg_advisory_xact_lock(0, hashtext($1))', [lockKey]);

      // Re-fetch member inside transaction to get consistent state under lock
      const memberRes = await query('SELECT * FROM members WHERE id = $1', [member.id]);
      const lockedRow = memberRes.rows[0] as Record<string, unknown> | undefined;
      if (!lockedRow) {
        // Member removed after pre-transaction resolution (e.g. deleted) — do not use stale `member`
        await insertPayjpEvent(txDb, {
          id: event.id!,
          event_type: event.type!,
          payload: event,
          processing_result: 'failed',
          fail_reason: 'member_not_found',
          data_metadata_operation_id: event.data?.metadata?.operation_id ?? null,
        });
        return { type: 'member_not_found' as const };
      }
      const lockedMember = lockedRow;

      // REQ-SYNC-007: Stale event check
      const lastEventCreated = lockedMember.last_payjp_event_created_at as number | null;
      if (isEventStale(event.created!, lastEventCreated)) {
        await insertPayjpEvent(txDb, {
          id: event.id!,
          event_type: event.type!,
          payload: event,
          processing_result: 'ignored',
          member_id: lockedMember.id as string,
          ignore_reason: 'stale_event',
          data_metadata_operation_id: event.data?.metadata?.operation_id ?? null,
        });
        return { type: 'stale' as const, lockedMember };
      }

      // REQ-SYNC-011: Unknown status check（subscription.deleted は resolve で常に deleted）
      const dataStatus = resolveEffectiveSubscriptionStatus(event.type!, event.data?.status);
      if (isStatusUnknown(dataStatus)) {
        await insertPayjpEvent(txDb, {
          id: event.id!,
          event_type: event.type!,
          payload: event,
          processing_result: 'failed',
          member_id: lockedMember.id as string,
          fail_reason: `unknown_status:${dataStatus}`,
          data_metadata_operation_id: event.data?.metadata?.operation_id ?? null,
        });
        return { type: 'unknown_status' as const, lockedMember };
      }

      // REQ-SYNC-010: Status update (atomic with event insert)
      const newStatus = mapSubscriptionStatus(dataStatus)!;
      const oldStatus = lockedMember.subscription_status as string | null;
      const statusChanged = shouldSyncRole(oldStatus, newStatus);

      const oldPlanId = lockedMember.payjp_plan_id as string | null;
      const newPlanId = event.data?.plan?.id ?? oldPlanId;
      const planChanged = shouldSwapRole(oldPlanId, newPlanId);

      const updates: Record<string, unknown> = {
        last_payjp_event_created_at: event.created!,
        subscription_status: newStatus,
      };

      if (event.data?.plan?.id) {
        updates.payjp_plan_id = event.data.plan.id;
      }
      const rawCpe = event.data?.current_period_end;
      const cpeUnix = rawCpe === undefined || rawCpe === null ? Number.NaN : Number(rawCpe);
      if (Number.isFinite(cpeUnix) && cpeUnix > 0) {
        const periodEnd = new Date(Math.floor(cpeUnix) * 1000);
        updates.next_billing_at = periodEnd;
        if (newStatus === 'active' || newStatus === 'trial' || newStatus === 'canceled') {
          updates.access_end_at = periodEnd;
        }
      }

      const mergedAccessEndAt =
        (updates.access_end_at as Date | undefined) ?? (lockedMember.access_end_at as Date | null);
      const now = new Date();
      const entitled = shouldGrantPaidDiscordAccess(newStatus, mergedAccessEndAt, now);

      await updateMemberFromWebhook(txDb, lockedMember.id as string, updates);
      await insertPayjpEvent(txDb, {
        id: event.id!,
        event_type: event.type!,
        payload: event,
        processing_result: 'processed',
        member_id: lockedMember.id as string,
        data_metadata_operation_id: event.data?.metadata?.operation_id ?? null,
      });

      return {
        type: 'processed' as const,
        lockedMember,
        statusChanged,
        action: statusChanged ? (entitled ? ('grant' as const) : ('revoke' as const)) : undefined,
        planChanged,
        oldPlanId,
        newPlanId,
        mergedAccessEndAt,
      };
    });
  } catch (err) {
    // ROLLBACK is handled by withTransaction; log context for debugging
    return handleDbError(err, deps, event.id, event.type);
  }

  // --- Post-transaction: role sync (best-effort, outside transaction) ---
  if (txResult.type === 'unknown_status') {
    await attemptRoleSyncAllRoles(deps, txResult.lockedMember, 'revoke', 'role_sync_failed_unknown_status');
  }

  if (txResult.type === 'processed') {
    const { statusChanged, action, planChanged, oldPlanId, newPlanId } = txResult;

    if (statusChanged && action) {
      if (action === 'revoke') {
        // Revoke: use oldPlanId (the role that was granted)
        const roleId = resolveRoleIdForPlan(oldPlanId, deps.planRoleMapping);
        if (roleId) {
          await attemptRoleSync(deps, txResult.lockedMember, 'revoke', 'role_sync_failed', roleId);
        } else {
          await attemptRoleSyncAllRoles(deps, txResult.lockedMember, 'revoke', 'role_sync_failed');
        }
      } else {
        // Grant: if plan also changed, revoke old first
        if (planChanged && oldPlanId) {
          const oldRoleId = resolveRoleIdForPlan(oldPlanId, deps.planRoleMapping);
          if (oldRoleId) {
            await attemptRoleSync(deps, txResult.lockedMember, 'revoke', 'role_swap_revoke_failed', oldRoleId);
          }
        }
        const roleId = resolveRoleIdForPlan(newPlanId, deps.planRoleMapping);
        if (roleId) {
          await attemptRoleSync(deps, txResult.lockedMember, 'grant', 'role_sync_failed', roleId);
        } else {
          await logUnmappedPlanWarning(deps, txResult.lockedMember, 'grant', newPlanId);
        }
      }
    } else if (
      !statusChanged &&
      planChanged &&
      shouldGrantPaidDiscordAccess(
        txResult.lockedMember.subscription_status as string | null,
        txResult.mergedAccessEndAt,
        new Date(),
      )
    ) {
      // Status unchanged but plan changed while still grant-eligible → swap roles
      const oldRoleId = resolveRoleIdForPlan(oldPlanId, deps.planRoleMapping);
      const newRoleId = resolveRoleIdForPlan(newPlanId, deps.planRoleMapping);
      if (oldRoleId) {
        await attemptRoleSync(deps, txResult.lockedMember, 'revoke', 'role_swap_revoke_failed', oldRoleId);
      }
      if (newRoleId) {
        await attemptRoleSync(deps, txResult.lockedMember, 'grant', 'role_swap_grant_failed', newRoleId);
      } else {
        await logUnmappedPlanWarning(deps, txResult.lockedMember, 'grant', newPlanId);
      }
    }
  }

  return { status: 200, body: { ok: true } };
}

// --- DB helpers ---

class MemberResolutionConflictError extends Error {
  constructor() {
    super('Member resolution conflict');
  }
}

async function findPayjpEvent(db: DbPool, eventId: string): Promise<Record<string, unknown> | null> {
  const result = await db.query(
    'SELECT id, event_type, processing_result, received_at FROM payjp_events WHERE id = $1',
    [eventId],
  );
  return (result.rows[0] as Record<string, unknown>) ?? null;
}

async function insertPayjpEvent(db: DbPool, event: PayjpEventInsert): Promise<void> {
  // Store processing metadata (ignore_reason, fail_reason, data_metadata_operation_id)
  // in the payload JSONB alongside the original event data
  const enrichedPayload = {
    ...(typeof event.payload === 'object' && event.payload !== null ? event.payload : {}),
    _processing: {
      ...(event.ignore_reason ? { ignore_reason: event.ignore_reason } : {}),
      ...(event.fail_reason ? { fail_reason: event.fail_reason } : {}),
      ...(event.data_metadata_operation_id !== undefined
        ? { data_metadata_operation_id: event.data_metadata_operation_id }
        : {}),
    },
  };

  await db.query(
    `INSERT INTO payjp_events (id, event_type, payload, processing_result, member_id, processed_at, data_metadata_operation_id)
     VALUES ($1, $2, $3, $4, $5, now(), $6)
     ON CONFLICT (id) DO NOTHING`,
    [
      event.id,
      event.event_type,
      JSON.stringify(enrichedPayload),
      event.processing_result,
      event.member_id ?? null,
      event.data_metadata_operation_id ?? null,
    ],
  );
}

async function resolveMember(
  db: DbPool,
  discordUserId: string | undefined,
  subscriptionId: string,
  memberId?: string,
): Promise<Record<string, unknown> | null> {
  let memberByDiscord: Record<string, unknown> | null = null;
  let memberBySub: Record<string, unknown> | null = null;
  let memberById: Record<string, unknown> | null = null;

  if (discordUserId) {
    const res = await db.query('SELECT * FROM members WHERE discord_user_id = $1', [discordUserId]);
    memberByDiscord = (res.rows[0] as Record<string, unknown>) ?? null;
  }

  const res2 = await db.query('SELECT * FROM members WHERE payjp_subscription_id = $1', [subscriptionId]);
  memberBySub = (res2.rows[0] as Record<string, unknown>) ?? null;

  if (memberId) {
    const res3 = await db.query('SELECT * FROM members WHERE id = $1', [memberId]);
    memberById = (res3.rows[0] as Record<string, unknown>) ?? null;
  }

  const candidates = [memberByDiscord, memberBySub, memberById].filter(Boolean) as Array<Record<string, unknown>>;
  if (candidates.length === 0) return null;

  // Conflict check: all resolved members must be the same
  const firstId = candidates[0].id;
  for (const c of candidates) {
    if (c.id !== firstId) throw new MemberResolutionConflictError();
  }

  return candidates[0];
}

// Whitelist of allowed column names for member updates from webhook
const ALLOWED_UPDATE_COLUMNS = new Set([
  'subscription_status',
  'payjp_plan_id',
  'access_end_at',
  'next_billing_at',
  'last_payjp_event_created_at',
  'payjp_subscription_id',
]);

async function updateMemberFromWebhook(db: DbPool, memberId: string, updates: Record<string, unknown>): Promise<void> {
  const setClauses: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  for (const [key, value] of Object.entries(updates)) {
    if (!ALLOWED_UPDATE_COLUMNS.has(key)) continue;
    setClauses.push(`${key} = $${i}`);
    values.push(value);
    i++;
  }

  if (setClauses.length === 0) return;

  setClauses.push(`updated_at = now()`);
  values.push(memberId);

  const result = await db.query(`UPDATE members SET ${setClauses.join(', ')} WHERE id = $${i}`, values);
  if (result.rowCount === 0) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        service: 'sync-service',
        message: 'updateMemberFromWebhook affected 0 rows — member may have been deleted',
        memberId,
      }),
    );
  }
}

/** Best-effort role sync with DB role_state fallback on failure */
async function attemptRoleSync(
  deps: WebhookHandlerDeps,
  lockedMember: Record<string, unknown>,
  action: 'grant' | 'revoke',
  errorLabel: string,
  roleId: string,
): Promise<void> {
  const discordUserId = lockedMember.discord_user_id as string | null;
  if (!discordUserId) {
    deps.log({
      timestamp: formatRfc3339Utc(new Date()),
      service: 'sync-service',
      endpoint: '/v1/payjp/webhook',
      result: 'success',
      message: 'role_sync_skipped_no_discord',
      member_id: lockedMember.id as string,
      action,
    } as unknown as LogEntry);
    return;
  }
  try {
    await deps.syncRole(discordUserId, action, roleId);
  } catch (roleSyncErr) {
    deps.log({
      timestamp: formatRfc3339Utc(new Date()),
      service: 'sync-service',
      endpoint: '/v1/payjp/webhook',
      result: 'failure',
      error: errorLabel,
      member_id: lockedMember.id as string,
      discord_user_id: discordUserId,
      action,
      roleId,
      roleSyncError: roleSyncErr instanceof Error ? roleSyncErr.message : String(roleSyncErr),
    } as unknown as LogEntry);
    // Mark role_state as unknown so daily resync can recover; record member impact (idempotent per member+issue)
    try {
      await deps.db.query("UPDATE members SET role_state = 'unknown', updated_at = now() WHERE id = $1", [
        lockedMember.id,
      ]);
    } catch (dbErr) {
      deps.log({
        timestamp: formatRfc3339Utc(new Date()),
        service: 'sync-service',
        endpoint: '/v1/payjp/webhook',
        result: 'critical_failure',
        error: 'role_sync_and_role_state_update_both_failed',
        member_id: lockedMember.id as string,
        discord_user_id: discordUserId,
        action,
        roleId,
        roleSyncError: roleSyncErr instanceof Error ? roleSyncErr.message : String(roleSyncErr),
        dbError: dbErr instanceof Error ? dbErr.message : String(dbErr),
      } as unknown as LogEntry);
    }
    try {
      await insertImpactLog(deps.db, lockedMember.id as string, ROLE_SYNC_FAILED_WEBHOOK, undefined, {
        errorLabel,
        action,
        roleId,
        message: roleSyncErr instanceof Error ? roleSyncErr.message : String(roleSyncErr),
      });
    } catch (impactErr) {
      deps.log({
        timestamp: formatRfc3339Utc(new Date()),
        service: 'sync-service',
        endpoint: '/v1/payjp/webhook',
        result: 'failure',
        error: 'member_impact_log_insert_failed',
        member_id: lockedMember.id as string,
        discord_user_id: discordUserId,
        impactError: impactErr instanceof Error ? impactErr.message : String(impactErr),
      } as unknown as LogEntry);
    }
  }
}

/** Revoke all plan roles when planId is unknown (safety fallback) */
async function attemptRoleSyncAllRoles(
  deps: WebhookHandlerDeps,
  lockedMember: Record<string, unknown>,
  action: 'grant' | 'revoke',
  errorLabel: string,
): Promise<void> {
  for (const roleId of Object.values(deps.planRoleMapping)) {
    await attemptRoleSync(deps, lockedMember, action, errorLabel, roleId);
  }
}

async function logUnmappedPlanWarning(
  deps: WebhookHandlerDeps,
  lockedMember: Record<string, unknown>,
  action: 'grant' | 'revoke',
  planId: string | null,
): Promise<void> {
  deps.log({
    timestamp: formatRfc3339Utc(new Date()),
    service: 'sync-service',
    endpoint: '/v1/payjp/webhook',
    result: 'failure',
    error: 'unmapped_plan_id',
    member_id: lockedMember.id as string,
    discord_user_id: (lockedMember.discord_user_id as string | null) ?? undefined,
    action,
    planId: planId ?? 'null',
  } as unknown as LogEntry);
  try {
    await deps.db.query("UPDATE members SET role_state = 'unknown', updated_at = now() WHERE id = $1", [
      lockedMember.id,
    ]);
  } catch {
    // Best-effort; daily resync will catch this
  }
}

function handleDbError(err: unknown, deps: WebhookHandlerDeps, eventId?: string, eventType?: string): WebhookResponse {
  deps.log({
    timestamp: formatRfc3339Utc(new Date()),
    service: 'sync-service',
    endpoint: '/v1/payjp/webhook',
    result: 'error',
    error: 'db_error',
    errorMessage: err instanceof Error ? err.message : String(err),
    errorCode: (err as { code?: string })?.code,
    eventId: eventId ?? 'unknown',
    eventType: eventType ?? 'unknown',
  } as unknown as LogEntry);
  return { status: 503, body: { error: 'Service Unavailable' } };
}
