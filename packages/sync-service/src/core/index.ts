/**
 * sync-service Pure Core — Phase 2b (Green)
 * No I/O or native module imports — fully deterministic
 */
import type { SubscriptionStatus } from '@hayane/shared';

// --- Types ---

export type PlanRoleMapping = Record<string, string>;

export interface RequiredFieldsResult {
  ok: boolean;
  missingFields: string[];
}

export interface WebhookEvent {
  id?: string;
  type?: string;
  created?: number;
  livemode?: boolean;
  data?: {
    id?: string;
    object?: string;
    status?: string;
    metadata?: Record<string, string>;
    plan?: { id?: string };
    current_period_end?: number;
  };
}

export interface TokenMismatchLog {
  event: unknown;
  received_at: string;
  remote_ip: string;
  reason: string;
}

export interface CliResultParams {
  mode: string;
  target: string;
  processedCount: number;
  succeededCount: number;
  failedCount: number;
  startedAt: Date;
  finishedAt: Date;
}

export interface CliResult {
  mode: string;
  target: string;
  processed_count: number;
  succeeded_count: number;
  failed_count: number;
  started_at: string;
  finished_at: string;
  duration_ms: number;
}

export interface CliArgsResult {
  ok: boolean;
  mode?: 'operation-id' | 'discord-user-id' | 'all';
  value?: string;
  error?: string;
}

export interface ChargeSearchParams {
  customer: string;
  since: number;
  until: number;
  limit: number;
}

export interface SubscriptionCandidate {
  id: string;
  status: string;
  metadata?: Record<string, string>;
  current_period_end?: number;
}

export interface EnvVarValidationResult {
  ok: boolean;
  missingVars?: string[];
}

// --- Constants ---

const ALLOWED_EVENT_TYPES = new Set([
  'subscription.created',
  'subscription.updated',
  'subscription.renewed',
  'subscription.canceled',
  'subscription.deleted',
  'subscription.paused',
  'subscription.resumed',
]);

const KNOWN_STATUSES: Set<string> = new Set(['active', 'trial', 'canceled', 'paused', 'deleted']);

const GRANT_STATUSES: Set<string> = new Set(['active', 'trial']);

const STATUS_NO_DATA_STATUS_REQUIRED = new Set(['subscription.created', 'subscription.deleted']);

const SENSITIVE_FIELD_PATTERN = /^(cookie|authorization|set-cookie|token|card)$/i;

const REQUIRED_ENV_VARS = [
  'PAYJP_WEBHOOK_TOKEN',
  'PAYJP_SECRET_KEY',
  'DATABASE_URL',
  'DISCORD_BOT_TOKEN',
  'DISCORD_GUILD_ID',
  'PAYJP_PLAN_IDS',
  'DISCORD_PLAN_ROLE_IDS',
  'DAILY_RESYNC_CRON',
  'PAYJP_LIVEMODE',
] as const;

// --- Pure Functions ---

// REQ-SYNC-001: PROP-SYNC-001
// Pure validation logic. Actual constant-time comparison delegated to shell via compareFn.
export function validateWebhookToken(
  received: string,
  expected: string,
  compareFn: (a: string, b: string) => boolean = (a, b) => a === b,
): boolean {
  if (received === '' || expected === '') return false;
  return compareFn(received, expected);
}

// REQ-SYNC-003: PROP-SYNC-002
export function isAllowedEventType(eventType: string): boolean {
  return ALLOWED_EVENT_TYPES.has(eventType);
}

// REQ-SYNC-004
export function isSubscriptionDataObject(dataObject: string | null): boolean {
  return dataObject === 'subscription';
}

// REQ-SYNC-002
export function isLivemodeMismatch(eventLivemode: boolean, expectedLivemode: boolean): boolean {
  return eventLivemode !== expectedLivemode;
}

// REQ-SYNC-005: PROP-SYNC-013
export function validateRequiredFields(event: WebhookEvent): RequiredFieldsResult {
  const missing: string[] = [];
  if (!event.id) missing.push('event.id');
  if (!event.type) missing.push('event.type');
  if (event.created === undefined || event.created === null) missing.push('event.created');
  if (!event.data?.id) missing.push('data.id');

  const needsDataStatus = event.type && !STATUS_NO_DATA_STATUS_REQUIRED.has(event.type);
  if (needsDataStatus && !event.data?.status) {
    missing.push('data.status');
  }

  return { ok: missing.length === 0, missingFields: missing };
}

// REQ-SYNC-006
export function isEventDuplicate(eventId: string, existingIds: Set<string>): boolean {
  return existingIds.has(eventId);
}

// REQ-SYNC-007: PROP-SYNC-003
export function isEventStale(eventCreated: number, lastEventCreated: number | null): boolean {
  if (lastEventCreated === null) return false;
  return eventCreated < lastEventCreated;
}

// REQ-SYNC-008
export function isSubscriptionCreatedEvent(eventType: string): boolean {
  return eventType === 'subscription.created';
}

// REQ-SYNC-002/003/004: PROP-SYNC-015
export function determineIgnoreReason(event: WebhookEvent, expectedLivemode: boolean): string | null {
  if (event.livemode !== undefined && isLivemodeMismatch(event.livemode, expectedLivemode)) {
    return 'livemode_mismatch';
  }
  if (event.type && !isAllowedEventType(event.type)) {
    return 'disallowed_event_type';
  }
  if (event.data && !isSubscriptionDataObject(event.data.object ?? null)) {
    return 'invalid_data_object';
  }
  return null;
}

// REQ-SYNC-010: PROP-SYNC-004
export function mapSubscriptionStatus(payjpStatus: string): SubscriptionStatus | null {
  if (KNOWN_STATUSES.has(payjpStatus)) return payjpStatus as SubscriptionStatus;
  return null;
}

// REQ-SYNC-012: PROP-SYNC-005
export function shouldGrantRole(status: string | null): boolean {
  if (status === null) return false;
  return GRANT_STATUSES.has(status);
}

/** Epoch ms for access end, or null if unknown / invalid (supports ISO strings from some PG drivers). */
function accessEndToEpochMs(accessEndAt: Date | string | null): number | null {
  if (accessEndAt === null) return null;
  if (accessEndAt instanceof Date) {
    const t = accessEndAt.getTime();
    return Number.isNaN(t) ? null : t;
  }
  if (typeof accessEndAt === 'string') {
    const t = Date.parse(accessEndAt);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

/** Paid Discord role should be present: active/trial, or canceled until access_end_at (current period end). */
export function shouldGrantPaidDiscordAccess(
  status: string | null,
  accessEndAt: Date | string | null,
  now: Date,
): boolean {
  if (status === null) return false;
  if (status === 'active' || status === 'trial') return true;
  if (status === 'canceled') {
    const endMs = accessEndToEpochMs(accessEndAt);
    if (endMs === null) return false;
    return endMs > now.getTime();
  }
  return false;
}

// REQ-SYNC-010: PROP-SYNC-017
export function shouldSyncRole(oldStatus: string | null, newStatus: string | null): boolean {
  return oldStatus !== newStatus;
}

export function resolveRoleIdForPlan(planId: string | null, mapping: PlanRoleMapping): string | null {
  if (planId === null) return null;
  return mapping[planId] ?? null;
}

export function shouldSwapRole(oldPlanId: string | null, newPlanId: string | null): boolean {
  if (oldPlanId === null || newPlanId === null) return false;
  return oldPlanId !== newPlanId;
}

// REQ-SYNC-011: PROP-SYNC-018
export function isStatusUnknown(status: string | null): boolean {
  if (status === null) return false;
  return !KNOWN_STATUSES.has(status);
}

/**
 * `subscription.deleted` の Webhook では PAY.JP が `data.status` を省略することがある。
 * 仕様（2weeks-spec）では event.type のみで扱い、常に canonical な `deleted` とする（payload の status は無視）。
 */
export function resolveEffectiveSubscriptionStatus(eventType: string, dataStatus: string | undefined): string {
  if (eventType === 'subscription.deleted') return 'deleted';
  return dataStatus ?? '';
}

// REQ-SYNC-015: PROP-SYNC-011
export function maskSensitiveLogFields(entry: Record<string, unknown>): Record<string, unknown> {
  const masked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    masked[key] = SENSITIVE_FIELD_PATTERN.test(key) ? '[REDACTED]' : value;
  }
  return masked;
}

// REQ-SYNC-001
export function buildTokenMismatchLog(
  event: unknown,
  receivedAt: string,
  remoteIp: string,
  reason: string,
): TokenMismatchLog {
  return { event, received_at: receivedAt, remote_ip: remoteIp, reason };
}

// REQ-SYNC-018: PROP-SYNC-014
export function formatRfc3339Utc(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// REQ-SYNC-018
export function buildCliResult(params: CliResultParams): CliResult {
  const durationMs = params.finishedAt.getTime() - params.startedAt.getTime();
  return {
    mode: params.mode,
    target: params.target,
    processed_count: params.processedCount,
    succeeded_count: params.succeededCount,
    failed_count: params.failedCount,
    started_at: formatRfc3339Utc(params.startedAt),
    finished_at: formatRfc3339Utc(params.finishedAt),
    duration_ms: durationMs,
  };
}

// REQ-SYNC-018: PROP-SYNC-007
export function determineCliExitCode(failedCount: number, cliError: boolean): 0 | 1 | 2 {
  if (cliError) return 1;
  if (failedCount > 0) return 2;
  return 0;
}

// REQ-SYNC-017: PROP-SYNC-006
export function validateCliArgs(args: string[]): CliArgsResult {
  if (args.length === 0) return { ok: false, error: 'No arguments provided' };

  let mode: CliArgsResult['mode'];
  let value: string | undefined;
  const modes: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--operation-id') {
      modes.push('operation-id');
      mode = 'operation-id';
      value = args[++i];
    } else if (args[i] === '--discord-user-id') {
      modes.push('discord-user-id');
      mode = 'discord-user-id';
      value = args[++i];
    } else if (args[i] === '--all') {
      modes.push('all');
      mode = 'all';
    } else {
      return { ok: false, error: `Unknown argument: ${args[i]}` };
    }
  }

  if (modes.length !== 1) {
    return { ok: false, error: 'Exactly one of --operation-id, --discord-user-id, --all required' };
  }

  if (mode !== 'all' && !value) {
    return { ok: false, error: `Missing value for --${mode}` };
  }

  return { ok: true, mode, value };
}

// REQ-SYNC-026: PROP-SYNC-009
export function isAccessEndExpired(accessEndAt: Date | null, now: Date): boolean {
  if (accessEndAt === null) return false;
  return accessEndAt <= now;
}

// REQ-SYNC-019: PROP-SYNC-010
/** Coerces DB BIGINT (number | bigint | string from node-pg) before Math.max — mixing bigint and number throws. */
export function calculateLastEventTimestamp(
  existing: number | bigint | string | null,
  resyncStartUnix: number,
): number {
  const existingNum = existing == null ? 0 : Number(existing);
  const safeExisting = Number.isFinite(existingNum) ? existingNum : 0;
  return Math.max(safeExisting, resyncStartUnix);
}

// REQ-SYNC-024: PROP-SYNC-020
export function isInflightOperationStale(startedAt: Date | null, now: Date, thresholdMinutes: number): boolean {
  if (startedAt === null) return false;
  const diffMs = now.getTime() - startedAt.getTime();
  return diffMs > thresholdMinutes * 60 * 1000;
}

// REQ-SYNC-019: PROP-SYNC-016
export function canResolveInflightOperation(
  payjpSubscriptionStatus: string | null,
  payjpSubscriptionId: string | null,
  memberPayjpSubscriptionId: string | null,
  memberPayjpCustomerId: string | null,
): boolean {
  if (memberPayjpCustomerId === null) return false;
  if (payjpSubscriptionStatus === null) return false;
  if (payjpSubscriptionId !== null && memberPayjpSubscriptionId !== null) {
    if (payjpSubscriptionId !== memberPayjpSubscriptionId) return false;
  }
  return true;
}

// REQ-SYNC-019: PROP-SYNC-012
export function buildChargeSearchParams(customerIdPayjp: string, inflightStartedAtUnix: number): ChargeSearchParams {
  return {
    customer: customerIdPayjp,
    since: inflightStartedAtUnix - 3600,
    until: inflightStartedAtUnix + 604800,
    limit: 100,
  };
}

// REQ-SYNC-019: PROP-SYNC-008
export function evaluateChargeSearchResult(
  matches: number,
  hasMoreAtLimit: boolean,
): 'proceed' | 'existing' | 'fail-close' {
  if (hasMoreAtLimit) return 'fail-close';
  if (matches === 0) return 'proceed';
  if (matches === 1) return 'existing';
  return 'fail-close';
}

// REQ-SYNC-020: PROP-SYNC-019
export function evaluateSubscriptionSearchResult(
  candidates: SubscriptionCandidate[],
  discordUserId: string,
  nextBillingAtUnix: number | null,
  memberId?: string,
): 'single-match' | 'fail-close' {
  if (candidates.length === 0) return 'fail-close';
  if (candidates.length > 1) return 'fail-close';

  const candidate = candidates[0];

  // Check metadata match
  if (candidate.metadata?.discord_user_id === discordUserId && discordUserId !== '') {
    return 'single-match';
  }

  if (memberId && candidate.metadata?.member_id === memberId) {
    return 'single-match';
  }

  // Fallback: no metadata match, check period_end
  if (nextBillingAtUnix === null) return 'fail-close';
  if (candidate.current_period_end === nextBillingAtUnix) {
    return 'single-match';
  }

  return 'fail-close';
}

// REQ-SYNC-028
export function validateWebhookRequiredEnvVars(env: Record<string, string | undefined>): EnvVarValidationResult {
  const missing = REQUIRED_ENV_VARS.filter((name) => !env[name] || env[name] === '');
  if (missing.length > 0) return { ok: false, missingVars: [...missing] };
  return { ok: true };
}
