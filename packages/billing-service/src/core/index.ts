/**
 * billing-service Pure Core — Phase 2b (Green)
 */
import { createHash } from 'node:crypto';
import type {
  CancelResponse,
  FixedEnvVarValidationResult,
  Member,
  SubscriptionResponse,
  ValidationResult,
} from '@hayane/shared';

export type { EnvVarValidationResult } from './env.js';

// PROP-BILL-001: REQ-BILL-003
export function validatePlanId(planId: string, allowedPlanIds: string[]): boolean {
  return planId !== '' && allowedPlanIds.includes(planId);
}

// PROP-BILL-002: REQ-BILL-013
export function isFirstTimeUser(firstTrialGrantedAt: Date | null): boolean {
  return firstTrialGrantedAt === null;
}

// PROP-BILL-003: REQ-BILL-007
export function hasActiveSubscription(status: string | null, accessEndAt: Date | null, now: Date): boolean {
  if (status === 'active' || status === 'trial') return true;
  if (status === 'canceled' && accessEndAt !== null && accessEndAt > now) return true;
  return false;
}

// PROP-BILL-004: REQ-BILL-006
export function hasInflightOperation(inflightOperationId: string | null): inflightOperationId is string {
  return inflightOperationId !== null;
}

// PROP-BILL-005: REQ-BILL-009
export function isThreeDSecureVerified(threeDSecureStatus: string | null): boolean {
  return threeDSecureStatus === 'verified';
}

// PROP-BILL-006: REQ-BILL-020
export function calculateCancelAcceptanceStart(accessEndAt: Date, jstOffsetMinutes: number = 540): Date {
  // Convert accessEndAt to JST
  const jstMs = accessEndAt.getTime() + jstOffsetMinutes * 60 * 1000;
  const jst = new Date(jstMs);

  // Subtract 1 month in JST
  let year = jst.getUTCFullYear();
  let month = jst.getUTCMonth() - 1; // 0-indexed
  const day = jst.getUTCDate();

  if (month < 0) {
    month = 11;
    year -= 1;
  }

  // Month-end rollup: clamp day to last day of target month
  const lastDayOfTargetMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const clampedDay = Math.min(day, lastDayOfTargetMonth);

  // Build result as 00:00:00 JST on the target date, then convert back to UTC
  const jstResult = Date.UTC(year, month, clampedDay, 0, 0, 0, 0);
  return new Date(jstResult - jstOffsetMinutes * 60 * 1000);
}

// PROP-BILL-007: REQ-BILL-020
export function isCancelAcceptable(nowJst: Date, acceptanceStartJst: Date): boolean {
  return nowJst >= acceptanceStartJst;
}

// PROP-BILL-008: REQ-BILL-013
export function calculateTrialEnd(now: Date): Date {
  const result = new Date(now);
  const targetMonth = result.getUTCMonth() + 3;
  const originalDay = result.getUTCDate();

  result.setUTCMonth(targetMonth);

  // Handle month overflow (e.g., Jan 31 + 3 months → Apr 30, not May 1)
  if (result.getUTCDate() !== originalDay) {
    // Overflowed — go back to last day of previous month
    result.setUTCDate(0);
  }

  return result;
}

// PROP-BILL-009: REQ-BILL-013, REQ-BILL-014
export function buildSubscriptionMetadata(
  discordUserId: string,
  operationId: string,
): { discord_user_id: string; operation_id: string } {
  return { discord_user_id: discordUserId, operation_id: operationId };
}

// PROP-BILL-010: REQ-BILL-016
export function buildSubscriptionResponse(member: Member): SubscriptionResponse {
  if (!member.subscription_status || !member.payjp_plan_id || !member.access_end_at) {
    throw new Error('buildSubscriptionResponse: required fields are null');
  }
  return {
    ok: true,
    memberId: member.id,
    subscriptionStatus: member.subscription_status,
    planId: member.payjp_plan_id,
    trialApplied: member.first_trial_granted_at !== null && member.subscription_status === 'trial',
    accessEndAt: formatRfc3339Utc(member.access_end_at),
  };
}

// PROP-BILL-011: REQ-BILL-025
export function buildCancelResponse(member: Member): CancelResponse {
  if (!member.cancel_requested_at || !member.access_end_at) {
    throw new Error('buildCancelResponse: required fields are null');
  }
  return {
    ok: true,
    memberId: member.id,
    cancelEffectiveAt: formatRfc3339Utc(member.cancel_requested_at),
    roleRemovalAt: formatRfc3339Utc(member.access_end_at),
  };
}

// PROP-BILL-012: REQ-BILL-016, REQ-BILL-025
export function formatRfc3339Utc(date: Date): string {
  if (Number.isNaN(date.getTime())) {
    throw new Error('formatRfc3339Utc: received invalid Date');
  }
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// PROP-BILL-013: REQ-BILL-001
export function isSameOrigin(requestOrigin: string, allowedOrigin: string): boolean {
  if (requestOrigin === 'null' || requestOrigin === '') return false;
  if (requestOrigin.endsWith('/')) return false;
  try {
    const req = new URL(requestOrigin);
    const allowed = new URL(allowedOrigin);
    if (req.protocol !== allowed.protocol) return false;
    if (req.hostname.toLowerCase() !== allowed.hostname.toLowerCase()) return false;
    const normalizePort = (url: URL): string => {
      if (url.port !== '') return url.port;
      if (url.protocol === 'https:') return '443';
      if (url.protocol === 'http:') return '80';
      return '';
    };
    return normalizePort(req) === normalizePort(allowed);
  } catch {
    return false;
  }
}

// PROP-BILL-014: REQ-BILL-030
const SENSITIVE_FIELD_PATTERN = /^(cookie|authorization|set-cookie|token|card)$/i;

export function maskSensitiveLogFields(logEntry: Record<string, unknown>): Record<string, unknown> {
  const masked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(logEntry)) {
    masked[key] = SENSITIVE_FIELD_PATTERN.test(key) ? '[REDACTED]' : value;
  }
  return masked;
}

// PROP-BILL-015: REQ-BILL-031
const FRONTEND_BASE_URL_PATTERN = /^https?:\/\/[^/]+$/;

export function validateFrontendBaseUrl(raw: string): ValidationResult {
  if (!FRONTEND_BASE_URL_PATTERN.test(raw)) {
    return { ok: false, reason: 'FRONTEND_BASE_URL must be origin-only (no path or trailing slash)' };
  }
  return { ok: true };
}

// PROP-BILL-016: REQ-BILL-031
const REQUIRED_ENV_VAR_NAMES = [
  'FRONTEND_BASE_URL',
  'DATABASE_URL',
  'PAYJP_SECRET_KEY',
  'PAYJP_PLAN_IDS',
  'DISCORD_BOT_TOKEN',
  'DISCORD_GUILD_ID',
  'DISCORD_PAID_ROLE_ID',
  'BILLING_INTERVAL_MONTHS',
  'INITIAL_FREE_CYCLES',
  'CANCEL_NOTICE_CYCLES',
] as const;

export function validateRequiredEnvVars(
  env: Record<string, string | undefined>,
): import('./env.js').EnvVarValidationResult {
  const missingVars = REQUIRED_ENV_VAR_NAMES.filter((name) => !env[name] || env[name] === '');
  if (missingVars.length > 0) return { ok: false, missingVars: [...missingVars] };
  return { ok: true };
}

// REQ-BILL-031: fixed-value env var validation
const FIXED_ENV_VARS: Array<{ name: string; expected: string }> = [
  { name: 'BILLING_INTERVAL_MONTHS', expected: '1' },
  { name: 'INITIAL_FREE_CYCLES', expected: '2' },
  { name: 'CANCEL_NOTICE_CYCLES', expected: '1' },
];

export function validateFixedEnvVars(env: Record<string, string | undefined>): FixedEnvVarValidationResult {
  const invalidVars = FIXED_ENV_VARS.filter(({ name, expected }) => env[name] !== expected).map(
    ({ name, expected }) => ({ name, expected, actual: env[name] }),
  );
  if (invalidVars.length > 0) return { ok: false, invalidVars };
  return { ok: true };
}

// PROP-BILL-017: REQ-BILL-029
export function getCorsHeaders(frontendBaseUrl: string): Record<string, string> {
  return {
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Origin': frontendBaseUrl,
  };
}

// CORS preflight
export function getCorsPreflight(frontendBaseUrl: string): Record<string, string> {
  return {
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Origin': frontendBaseUrl,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

// PROP-BILL-018: REQ-BILL-015
export function shouldGrantRole(status: string | null): boolean {
  return status === 'active' || status === 'trial' || status === 'canceled';
}

// PROP-BILL-019: REQ-BILL-014
export function determineSubscriptionStatus(isFirstTime: boolean): 'trial' | 'active' {
  return isFirstTime ? 'trial' : 'active';
}

// link session token hash (SHA-256, deterministic)
export function linkSessionTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
