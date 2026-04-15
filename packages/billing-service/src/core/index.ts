/**
 * billing-service Pure Core — Phase 2b (Green)
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type {
  CancelFormLinkResponse,
  CancelResponse,
  FixedEnvVarValidationResult,
  Member,
  SubscriptionResponse,
  ValidationResult,
} from '@hayane/shared';

export type { EnvVarValidationResult } from './env.js';

export interface CancelFormTokenPayload {
  jti: string;
  memberId: string;
  email: string;
  exp: number;
  nonce: string;
}

export type CancelFormTokenVerificationResult =
  | { ok: true; payload: CancelFormTokenPayload }
  | { ok: false; reason: 'malformed' | 'invalid_signature' | 'expired' };

// PROP-BILL-001: REQ-BILL-003
export function validatePlanId(planId: string, allowedPlanIds: string[]): boolean {
  return planId !== '' && allowedPlanIds.includes(planId);
}

// PROP-BILL-002: REQ-BILL-013
export function isFirstTimeUser(firstTrialGrantedAt: Date | null): boolean {
  return firstTrialGrantedAt === null;
}

// PROP-BILL-003: REQ-BILL-007
/** True if the member still has paid entitlement (active/trial, or canceled until current period end). */
export function hasActiveSubscription(status: string | null, accessEndAt: Date | null, now: Date): boolean {
  if (status === 'active' || status === 'trial') return true;
  if (status === 'canceled' && accessEndAt !== null && accessEndAt > now) return true;
  return false;
}

export function hasCancelableSubscription(status: string | null): boolean {
  return status === 'active' || status === 'trial' || status === 'canceled';
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// PROP-BILL-004: REQ-BILL-006
export function hasInflightOperation(inflightOperationId: string | null): inflightOperationId is string {
  return inflightOperationId !== null;
}

// PROP-BILL-005: REQ-BILL-009
export function isThreeDSecureVerified(threeDSecureStatus: string | null): boolean {
  return threeDSecureStatus === 'verified';
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
// PAY.JP metadata: member_id + operation_id; discord_user_id when linked (sync/CLI compatibility).
export function buildSubscriptionMetadata(
  memberId: string,
  operationId: string,
  discordUserId?: string | null,
): Record<string, string> {
  const meta: Record<string, string> = {
    member_id: memberId,
    operation_id: operationId,
  };
  if (discordUserId) {
    meta.discord_user_id = discordUserId;
  }
  return meta;
}

// member session token hash (SHA-256, deterministic)
export function memberSessionTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Same digest as `memberSessionTokenHash`; use for `__Host-access_gate` rows only (clarity at call sites). */
export function accessGateSessionTokenHash(token: string): string {
  return memberSessionTokenHash(token);
}

/**
 * Compare shared passcode to configured value without leaking length via early exit on `timingSafeEqual`.
 * Uses SHA-256 digests (fixed 32 bytes) before constant-time comparison.
 * Empty `expected` or `submitted` always yields false (misuse / no gate configured).
 */
export function verifySharedPasscode(submitted: string, expected: string): boolean {
  if (expected.length === 0 || submitted.length === 0) {
    return false;
  }
  const h1 = createHash('sha256').update(submitted, 'utf8').digest();
  const h2 = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(h1, h2);
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
export function buildCancelResponse(member: Member, roleRemovalAt?: Date): CancelResponse {
  if (!member.cancel_requested_at || !member.access_end_at) {
    throw new Error('buildCancelResponse: required fields are null');
  }
  const removalAt = roleRemovalAt ?? member.access_end_at;
  return {
    ok: true,
    memberId: member.id,
    cancelEffectiveAt: formatRfc3339Utc(member.cancel_requested_at),
    roleRemovalAt: formatRfc3339Utc(removalAt),
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
// 実装は @hayane/shared に移動済み。後方互換性のため re-export。
export { isSameOrigin } from '@hayane/shared';

// PROP-BILL-014: REQ-BILL-030
const SENSITIVE_FIELD_PATTERN = /^(cookie|authorization|set-cookie|token|card|email)$/i;

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
  'DISCORD_PLAN_ROLE_IDS',
  'GOOGLE_FORM_CANCEL_BASE_URL',
  'GOOGLE_FORM_CANCEL_EMAIL_ENTRY_ID',
  'GOOGLE_FORM_CANCEL_TOKEN_ENTRY_ID',
  'GOOGLE_FORM_CANCEL_SECRET',
  'GOOGLE_FORM_CANCEL_TOKEN_SECRET',
  'GOOGLE_FORM_CANCEL_TOKEN_TTL_SECONDS',
  'BILLING_INTERVAL_MONTHS',
  'INITIAL_FREE_CYCLES',
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
  if (status === null) return false;
  return status === 'active' || status === 'trial';
}

// PROP-BILL-019: REQ-BILL-014
export function determineSubscriptionStatus(isFirstTime: boolean): 'trial' | 'active' {
  return isFirstTime ? 'trial' : 'active';
}

// link session token hash (SHA-256, deterministic)
export function linkSessionTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function buildCancelFormLinkResponse(formUrl: string, expiresAt: Date): CancelFormLinkResponse {
  return {
    ok: true,
    formUrl,
    expiresAt: formatRfc3339Utc(expiresAt),
  };
}

function encodeBase64Url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

function decodeBase64Url(input: string): string {
  return Buffer.from(input, 'base64url').toString('utf8');
}

function compareSignatures(actual: string, expected: string): boolean {
  const actualDigest = createHash('sha256').update(actual).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

export function createSignedCancelFormToken(payload: CancelFormTokenPayload, secret: string): string {
  const payloadEncoded = encodeBase64Url(JSON.stringify(payload));
  const signature = createHmac('sha256', secret).update(payloadEncoded).digest('base64url');
  return `${payloadEncoded}.${signature}`;
}

export function verifySignedCancelFormToken(
  token: string,
  secret: string,
  now: Date,
): CancelFormTokenVerificationResult {
  const segments = token.split('.');
  if (segments.length !== 2 || !segments[0] || !segments[1]) {
    return { ok: false, reason: 'malformed' };
  }

  const [payloadEncoded, signature] = segments;
  const expectedSignature = createHmac('sha256', secret).update(payloadEncoded).digest('base64url');
  if (!compareSignatures(signature, expectedSignature)) {
    return { ok: false, reason: 'invalid_signature' };
  }

  try {
    const raw = JSON.parse(decodeBase64Url(payloadEncoded)) as Record<string, unknown>;
    const payload: CancelFormTokenPayload = {
      jti: typeof raw.jti === 'string' ? raw.jti : '',
      memberId: typeof raw.memberId === 'string' ? raw.memberId : '',
      email: typeof raw.email === 'string' ? normalizeEmail(raw.email) : '',
      exp: typeof raw.exp === 'number' ? raw.exp : Number.NaN,
      nonce: typeof raw.nonce === 'string' ? raw.nonce : '',
    };
    if (!payload.jti || !payload.memberId || !payload.email || !payload.nonce || !Number.isFinite(payload.exp)) {
      return { ok: false, reason: 'malformed' };
    }
    if (payload.exp <= Math.floor(now.getTime() / 1000)) {
      return { ok: false, reason: 'expired' };
    }
    return { ok: true, payload };
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}

/**
 * google-submit per-request signature canonical form: `${normalizedEmail}\n${token}`.
 * Excludes name/reason: those are user-visible in the GAS submit log, so they
 * must not be signed material (an attacker reading the log would otherwise
 * know both the signature material AND the signature itself).
 * email is normalized (lowercase+trim) — must match server-side normalization
 * or the HMAC diverges.
 */
function googleCancelSubmitHmacMessage(email: string, token: string): string {
  return `${normalizeEmail(email)}\n${token}`;
}

export function computeGoogleCancelSubmitSignature(secret: string, params: { email: string; token: string }): string {
  return createHmac('sha256', secret).update(googleCancelSubmitHmacMessage(params.email, params.token)).digest('hex');
}

export function verifyGoogleCancelSubmitSignature(
  providedSignatureHex: string,
  secret: string,
  params: { email: string; token: string },
): boolean {
  const expectedHex = computeGoogleCancelSubmitSignature(secret, params);
  if (providedSignatureHex.length !== expectedHex.length) return false;
  try {
    return timingSafeEqual(Buffer.from(providedSignatureHex, 'hex'), Buffer.from(expectedHex, 'hex'));
  } catch {
    return false;
  }
}

export function buildGoogleFormPrefillUrl(
  baseUrl: string,
  emailEntryId: string,
  tokenEntryId: string,
  email: string,
  token: string,
): string {
  const url = new URL(baseUrl);
  url.searchParams.set('usp', 'pp_url');
  url.searchParams.set(`entry.${emailEntryId}`, normalizeEmail(email));
  url.searchParams.set(`entry.${tokenEntryId}`, token);
  return url.toString();
}
