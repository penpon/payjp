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
  shouldGrantRole,
  shouldSyncRole,
  validateRequiredFields,
  validateWebhookToken,
  type WebhookEvent,
} from '../core/index.js';
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
      return handleDbError(err, deps);
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
      return handleDbError(err, deps);
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
    return handleDbError(err, deps);
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
      return handleDbError(err, deps);
    }
    return { status: 200, body: { ok: true } };
  }

  // REQ-SYNC-029: Acquire per-member advisory lock before member resolution/update
  // Use hashtext for consistency with billing-service's lock strategy
  const discordUserIdFromMetadata = event.data?.metadata?.discord_user_id;

  // REQ-SYNC-009: Member resolution
  let member: Record<string, unknown> | null = null;
  try {
    member = await resolveMember(deps.db, discordUserIdFromMetadata, event.data!.id!);
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
        return handleDbError(insertErr, deps);
      }
      return { status: 200, body: { ok: true } };
    }
    return handleDbError(err, deps);
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
      return handleDbError(err, deps);
    }
    return { status: 200, body: { ok: true } };
  }

  // --- Transactional section: lock + stale check + status update + event insert ---
  const lockKey = member.discord_user_id as string;
  try {
    await deps.db.query('BEGIN');
    // Advisory lock inside transaction — released automatically on COMMIT/ROLLBACK
    await deps.db.query('SELECT pg_advisory_xact_lock(0, hashtext($1))', [lockKey]);

    // Re-fetch member inside transaction to get consistent state under lock
    const memberRes = await deps.db.query('SELECT * FROM members WHERE id = $1', [member.id]);
    const lockedMember = (memberRes.rows[0] as Record<string, unknown>) ?? member;

    // REQ-SYNC-007: Stale event check
    const lastEventCreated = lockedMember.last_payjp_event_created_at as number | null;
    if (isEventStale(event.created!, lastEventCreated)) {
      await insertPayjpEvent(deps.db, {
        id: event.id!,
        event_type: event.type!,
        payload: event,
        processing_result: 'ignored',
        member_id: lockedMember.id as string,
        ignore_reason: 'stale_event',
        data_metadata_operation_id: event.data?.metadata?.operation_id ?? null,
      });
      await deps.db.query('COMMIT');
      return { status: 200, body: { ok: true } };
    }

    // REQ-SYNC-011: Unknown status check（subscription.deleted は resolve で常に deleted）
    const dataStatus = resolveEffectiveSubscriptionStatus(event.type!, event.data?.status);
    if (isStatusUnknown(dataStatus)) {
      await insertPayjpEvent(deps.db, {
        id: event.id!,
        event_type: event.type!,
        payload: event,
        processing_result: 'failed',
        member_id: lockedMember.id as string,
        fail_reason: `unknown_status:${dataStatus}`,
        data_metadata_operation_id: event.data?.metadata?.operation_id ?? null,
      });
      await deps.db.query('COMMIT');
      // Safe-side revocation (outside transaction — best-effort)
      try {
        await deps.syncRole(lockedMember.discord_user_id as string, 'revoke');
      } catch (roleSyncErr) {
        deps.log({
          timestamp: formatRfc3339Utc(new Date()),
          service: 'sync-service',
          endpoint: '/v1/payjp/webhook',
          result: 'failure',
          error: 'role_sync_failed_unknown_status',
          member_id: lockedMember.id as string,
          discord_user_id: lockedMember.discord_user_id as string,
          action: 'revoke',
          roleSyncError: roleSyncErr instanceof Error ? roleSyncErr.message : String(roleSyncErr),
        } as unknown as LogEntry);
      }
      return { status: 200, body: { ok: true } };
    }

    // REQ-SYNC-010: Status update (atomic with event insert)
    const newStatus = mapSubscriptionStatus(dataStatus)!;
    const oldStatus = lockedMember.subscription_status as string | null;
    const statusChanged = shouldSyncRole(oldStatus, newStatus);

    const updates: Record<string, unknown> = {
      last_payjp_event_created_at: event.created!,
      subscription_status: newStatus,
    };

    if (event.data?.plan?.id) {
      updates.payjp_plan_id = event.data.plan.id;
    }
    if (event.data?.current_period_end) {
      updates.access_end_at = new Date(event.data.current_period_end * 1000);
    }

    await updateMemberFromWebhook(deps.db, lockedMember.id as string, updates);
    await insertPayjpEvent(deps.db, {
      id: event.id!,
      event_type: event.type!,
      payload: event,
      processing_result: 'processed',
      member_id: lockedMember.id as string,
      data_metadata_operation_id: event.data?.metadata?.operation_id ?? null,
    });
    await deps.db.query('COMMIT');

    // REQ-SYNC-012: Role sync only on status change (outside transaction — best-effort)
    if (statusChanged) {
      const action = shouldGrantRole(newStatus) ? 'grant' : 'revoke';
      try {
        await deps.syncRole(lockedMember.discord_user_id as string, action);
      } catch (roleSyncErr) {
        deps.log({
          timestamp: formatRfc3339Utc(new Date()),
          service: 'sync-service',
          endpoint: '/v1/payjp/webhook',
          result: 'failure',
          error: 'role_sync_failed',
          member_id: lockedMember.id as string,
          discord_user_id: lockedMember.discord_user_id as string,
          action,
          roleSyncError: roleSyncErr instanceof Error ? roleSyncErr.message : String(roleSyncErr),
        } as unknown as LogEntry);
      }
    }
  } catch (err) {
    try {
      await deps.db.query('ROLLBACK');
    } catch {
      // ROLLBACK failure is not actionable beyond logging the original error
    }
    return handleDbError(err, deps);
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
    `INSERT INTO payjp_events (id, event_type, payload, processing_result, member_id, processed_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (id) DO NOTHING`,
    [event.id, event.event_type, JSON.stringify(enrichedPayload), event.processing_result, event.member_id ?? null],
  );
}

async function resolveMember(
  db: DbPool,
  discordUserId: string | undefined,
  subscriptionId: string,
): Promise<Record<string, unknown> | null> {
  let memberByDiscord: Record<string, unknown> | null = null;
  let memberBySub: Record<string, unknown> | null = null;

  if (discordUserId) {
    const res = await db.query('SELECT * FROM members WHERE discord_user_id = $1', [discordUserId]);
    memberByDiscord = (res.rows[0] as Record<string, unknown>) ?? null;
  }

  const res2 = await db.query('SELECT * FROM members WHERE payjp_subscription_id = $1', [subscriptionId]);
  memberBySub = (res2.rows[0] as Record<string, unknown>) ?? null;

  if (memberByDiscord && memberBySub) {
    if (memberByDiscord.id !== memberBySub.id) {
      throw new MemberResolutionConflictError();
    }
    return memberByDiscord;
  }

  return memberByDiscord ?? memberBySub;
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

  await db.query(`UPDATE members SET ${setClauses.join(', ')} WHERE id = $${i}`, values);
}

function handleDbError(err: unknown, deps: WebhookHandlerDeps): WebhookResponse {
  deps.log({
    timestamp: formatRfc3339Utc(new Date()),
    service: 'sync-service',
    endpoint: '/v1/payjp/webhook',
    result: 'error',
    error: 'db_error',
    errorMessage: err instanceof Error ? err.message : String(err),
    errorCode: (err as { code?: string })?.code,
  } as unknown as LogEntry);
  return { status: 503, body: { error: 'Service Unavailable' } };
}
