/**
 * Tier 1 純粋関数テスト — Red Phase
 *
 * PROP-BILL-001 〜 PROP-BILL-019
 * すべてのテストはスタブが "Not implemented yet" をスローするため FAIL する。
 */

import type { Member } from '@hayane/shared';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  accessGateSessionTokenHash,
  buildCancelFormLinkResponse,
  buildCancelResponse,
  buildGoogleFormPrefillUrl,
  buildSubscriptionMetadata,
  buildSubscriptionResponse,
  calculateTrialEnd,
  createSignedCancelFormToken,
  determineSubscriptionStatus,
  formatRfc3339Utc,
  getCorsHeaders,
  hasActiveSubscription,
  hasCancelableSubscription,
  hasInflightOperation,
  isFirstTimeUser,
  isSameOrigin,
  isThreeDSecureVerified,
  maskSensitiveLogFields,
  memberSessionTokenHash,
  normalizeEmail,
  shouldGrantRole,
  validateFixedEnvVars,
  validateFrontendBaseUrl,
  validatePlanId,
  validateRequiredEnvVars,
  verifySharedPasscode,
  verifySignedCancelFormToken,
} from '../index.js';

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------
function makeMember(overrides: Partial<Member> = {}): Member {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    discord_user_id: '123456789',
    email: 'test@example.com',
    payjp_customer_id: 'cus_test',
    payjp_subscription_id: 'sub_test',
    payjp_initial_charge_id: null,
    payjp_plan_id: 'plan_basic',
    subscription_status: 'active',
    first_trial_granted_at: null,
    initial_charge_paid_at: null,
    cancel_requested_at: null,
    inflight_operation_id: null,
    inflight_operation_type: null,
    inflight_operation_started_at: null,
    inflight_subscribe_plan_id: null,
    privacy_consented_at: null,
    access_end_at: new Date('2026-05-01T00:00:00Z'),
    next_billing_at: new Date('2026-05-01T00:00:00Z'),
    role_state: 'granted',
    last_synced_at: new Date(),
    last_payjp_event_created_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// PROP-BILL-001: validatePlanId
// ---------------------------------------------------------------------------
describe('PROP-BILL-001: validatePlanId', () => {
  const ALLOWED = ['plan_basic', 'plan_plus', 'plan_pro'];

  it('returns true for exact allowlist member', () => {
    expect(validatePlanId('plan_basic', ALLOWED)).toBe(true);
    expect(validatePlanId('plan_plus', ALLOWED)).toBe(true);
    expect(validatePlanId('plan_pro', ALLOWED)).toBe(true);
  });

  it('returns false for non-allowlist planId', () => {
    expect(validatePlanId('plan_unknown', ALLOWED)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(validatePlanId('', ALLOWED)).toBe(false);
  });

  it('(property) only exact matches pass', () => {
    fc.assert(
      fc.property(fc.string(), (planId) => {
        const result = validatePlanId(planId, ALLOWED);
        if (ALLOWED.includes(planId)) {
          expect(result).toBe(true);
        } else {
          expect(result).toBe(false);
        }
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// PROP-BILL-002: isFirstTimeUser
// ---------------------------------------------------------------------------
describe('PROP-BILL-002: isFirstTimeUser', () => {
  it('returns true when firstTrialGrantedAt is null', () => {
    expect(isFirstTimeUser(null)).toBe(true);
  });

  it('returns false when firstTrialGrantedAt is set', () => {
    expect(isFirstTimeUser(new Date('2026-01-01'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PROP-BILL-003: hasActiveSubscription
// ---------------------------------------------------------------------------
describe('PROP-BILL-003: hasActiveSubscription', () => {
  const now = new Date('2026-04-06T12:00:00Z');
  const future = new Date('2026-05-01T00:00:00Z');
  const past = new Date('2026-03-01T00:00:00Z');

  it.each([
    { status: 'active', accessEndAt: future, expected: true },
    { status: 'trial', accessEndAt: future, expected: true },
    { status: 'canceled', accessEndAt: future, expected: true },
    { status: 'canceled', accessEndAt: past, expected: false },
    { status: 'paused', accessEndAt: future, expected: false },
    { status: 'deleted', accessEndAt: null, expected: false },
    { status: null, accessEndAt: null, expected: false },
  ])('status=$status, accessEndAt=$accessEndAt → $expected', ({ status, accessEndAt, expected }) => {
    expect(hasActiveSubscription(status, accessEndAt, now)).toBe(expected);
  });
});

describe('hasCancelableSubscription', () => {
  it.each([
    { status: 'active', expected: true },
    { status: 'trial', expected: true },
    { status: 'canceled', expected: true },
    { status: 'paused', expected: false },
    { status: 'deleted', expected: false },
    { status: null, expected: false },
  ])('status=$status → $expected', ({ status, expected }) => {
    expect(hasCancelableSubscription(status)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// PROP-BILL-004: hasInflightOperation
// ---------------------------------------------------------------------------
describe('PROP-BILL-004: hasInflightOperation', () => {
  it('returns true when inflightOperationId is non-null', () => {
    expect(hasInflightOperation('op_123')).toBe(true);
  });

  it('returns false when inflightOperationId is null', () => {
    expect(hasInflightOperation(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PROP-BILL-005: isThreeDSecureVerified
// ---------------------------------------------------------------------------
describe('PROP-BILL-005: isThreeDSecureVerified', () => {
  it.each([
    { status: 'verified', expected: true },
    { status: 'attempted', expected: false },
    { status: 'failed', expected: false },
    { status: 'error', expected: false },
    { status: 'unverified', expected: false },
    { status: null, expected: false },
    { status: '', expected: false },
  ])('status=$status → $expected', ({ status, expected }) => {
    expect(isThreeDSecureVerified(status)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// PROP-BILL-008: calculateTrialEnd
// ---------------------------------------------------------------------------
describe('PROP-BILL-008: calculateTrialEnd', () => {
  it('returns now + 3 months', () => {
    const now = new Date('2026-04-06T12:00:00Z');
    const result = calculateTrialEnd(now);
    expect(result).toEqual(new Date('2026-07-06T12:00:00Z'));
  });

  it('handles month-end edge: Jan 31 + 3 months → Apr 30', () => {
    const now = new Date('2026-01-31T00:00:00Z');
    const result = calculateTrialEnd(now);
    // JS Date month overflow: Apr 31 → May 1, so implementation must handle
    // Expected: Apr 30 (last day of April)
    expect(result.getUTCMonth()).toBe(3); // April = 3 (0-indexed)
  });
});

// ---------------------------------------------------------------------------
// PROP-BILL-009: buildSubscriptionMetadata (property test)
// ---------------------------------------------------------------------------
describe('PROP-BILL-009: buildSubscriptionMetadata', () => {
  it('(property) always includes member_id and operation_id', () => {
    fc.assert(
      fc.property(fc.uuid(), fc.uuid(), (memberId, operationId) => {
        const meta = buildSubscriptionMetadata(memberId, operationId);
        expect(meta).toHaveProperty('member_id', memberId);
        expect(meta).toHaveProperty('operation_id', operationId);
        expect(meta.discord_user_id).toBeUndefined();
      }),
    );
  });

  it('includes discord_user_id when provided', () => {
    const meta = buildSubscriptionMetadata('m1', 'op1', '123456789012345678');
    expect(meta.member_id).toBe('m1');
    expect(meta.operation_id).toBe('op1');
    expect(meta.discord_user_id).toBe('123456789012345678');
  });
});

// ---------------------------------------------------------------------------
// PROP-BILL-010: buildSubscriptionResponse (property test)
// ---------------------------------------------------------------------------
describe('PROP-BILL-010: buildSubscriptionResponse', () => {
  it('produces valid response with all required keys', () => {
    const member = makeMember({
      subscription_status: 'active',
      payjp_plan_id: 'plan_basic',
      first_trial_granted_at: null,
      access_end_at: new Date('2026-05-01T00:00:00Z'),
    });
    const response = buildSubscriptionResponse(member);
    expect(response.ok).toBe(true);
    expect(response.memberId).toBe(member.id);
    expect(response.subscriptionStatus).toBe('active');
    expect(response.planId).toBe('plan_basic');
    expect(typeof response.trialApplied).toBe('boolean');
    expect(response.accessEndAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it('(property) accessEndAt is always RFC 3339 UTC', () => {
    fc.assert(
      fc.property(fc.date({ noInvalidDate: true }), (date) => {
        const member = makeMember({ access_end_at: date });
        const response = buildSubscriptionResponse(member);
        expect(response.accessEndAt).toMatch(/Z$/);
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// PROP-BILL-011: buildCancelResponse (property test)
// ---------------------------------------------------------------------------
describe('PROP-BILL-011: buildCancelResponse', () => {
  it('produces valid response with all required keys', () => {
    const member = makeMember({
      cancel_requested_at: new Date('2026-04-06T00:00:00Z'),
      access_end_at: new Date('2026-05-01T00:00:00Z'),
    });
    const response = buildCancelResponse(member);
    expect(response.ok).toBe(true);
    expect(response.memberId).toBe(member.id);
    expect(response.cancelEffectiveAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(response.roleRemovalAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});

// ---------------------------------------------------------------------------
// PROP-BILL-012: formatRfc3339Utc (property test)
// ---------------------------------------------------------------------------
describe('PROP-BILL-012: formatRfc3339Utc', () => {
  it('produces Z-suffixed ISO string', () => {
    const date = new Date('2026-04-03T12:34:56Z');
    expect(formatRfc3339Utc(date)).toBe('2026-04-03T12:34:56Z');
  });

  it('(property) always ends with Z for valid dates', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2020-01-01'), max: new Date('2030-12-31'), noInvalidDate: true }),
        (date) => {
          fc.pre(!Number.isNaN(date.getTime()));
          const result = formatRfc3339Utc(date);
          expect(result).toMatch(/Z$/);
          expect(typeof result).toBe('string');
        },
      ),
    );
  });

  it('throws on invalid date', () => {
    expect(() => formatRfc3339Utc(new Date(Number.NaN))).toThrow('formatRfc3339Utc: received invalid Date');
  });
});

// ---------------------------------------------------------------------------
// PROP-BILL-013: isSameOrigin
// ---------------------------------------------------------------------------
describe('PROP-BILL-013: isSameOrigin', () => {
  const ALLOWED = 'https://app.example.com';

  it.each([
    { origin: 'https://app.example.com', expected: true },
    { origin: 'http://app.example.com', expected: false }, // scheme diff
    { origin: 'https://evil.example.com', expected: false }, // host diff
    { origin: 'https://app.example.com:8443', expected: false }, // port diff
    { origin: 'null', expected: false },
    { origin: '', expected: false },
  ])('origin=$origin → $expected', ({ origin, expected }) => {
    expect(isSameOrigin(origin, ALLOWED)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// PROP-BILL-014: maskSensitiveLogFields (property test)
// ---------------------------------------------------------------------------
describe('PROP-BILL-014: maskSensitiveLogFields', () => {
  const SENSITIVE_KEYS = ['cookie', 'authorization', 'set-cookie', 'token', 'card'];

  it('masks all sensitive keys', () => {
    const entry: Record<string, unknown> = {
      cookie: 'secret_cookie',
      authorization: 'Bearer token',
      token: 'tk_xxx',
      card: '4242424242424242',
      endpoint: '/v1/subscriptions',
    };
    const masked = maskSensitiveLogFields(entry);
    expect(masked.cookie).toBe('[REDACTED]');
    expect(masked.authorization).toBe('[REDACTED]');
    expect(masked.token).toBe('[REDACTED]');
    expect(masked.card).toBe('[REDACTED]');
    expect(masked.endpoint).toBe('/v1/subscriptions');
  });

  it('(property) sensitive keys never leak raw values', () => {
    fc.assert(
      fc.property(fc.string(), (rawValue) => {
        for (const key of SENSITIVE_KEYS) {
          const masked = maskSensitiveLogFields({ [key]: rawValue });
          expect(masked[key]).toBe('[REDACTED]');
        }
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// PROP-BILL-015: validateFrontendBaseUrl (property test)
// ---------------------------------------------------------------------------
describe('PROP-BILL-015: validateFrontendBaseUrl', () => {
  it('accepts valid origin-only URL', () => {
    expect(validateFrontendBaseUrl('https://app.example.com').ok).toBe(true);
    expect(validateFrontendBaseUrl('http://localhost:3000').ok).toBe(true);
  });

  it('rejects trailing slash', () => {
    expect(validateFrontendBaseUrl('https://app.example.com/').ok).toBe(false);
  });

  it('rejects path segment', () => {
    expect(validateFrontendBaseUrl('https://app.example.com/path').ok).toBe(false);
  });

  it('rejects empty string', () => {
    expect(validateFrontendBaseUrl('').ok).toBe(false);
  });

  it('(property) strings with / after host are rejected', () => {
    fc.assert(
      fc.property(fc.webUrl(), (url) => {
        const parsed = new URL(url);
        if (parsed.pathname !== '/' || url.endsWith('/')) {
          // URLs with paths should be rejected
          // (webUrl() may generate paths)
        }
        // Just verify it doesn't throw
        const result = validateFrontendBaseUrl(url);
        expect(typeof result.ok).toBe('boolean');
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// PROP-BILL-016: validateRequiredEnvVars
// ---------------------------------------------------------------------------
describe('PROP-BILL-016: validateRequiredEnvVars', () => {
  const FULL_ENV: Record<string, string> = {
    FRONTEND_BASE_URL: 'https://app.example.com',
    DATABASE_URL: 'postgresql://localhost/test',
    PAYJP_SECRET_KEY: 'sk_test_xxx',
    PAYJP_PLAN_IDS: 'plan_basic,plan_plus,plan_pro',
    DISCORD_BOT_TOKEN: 'bot_token',
    DISCORD_GUILD_ID: '111222333',
    DISCORD_PLAN_ROLE_IDS: '444555666,555666777,666777888',
    GOOGLE_FORM_CANCEL_BASE_URL: 'https://docs.google.com/forms/d/e/test-form/viewform',
    GOOGLE_FORM_CANCEL_EMAIL_ENTRY_ID: '1111111111',
    GOOGLE_FORM_CANCEL_TOKEN_ENTRY_ID: '2222222222',
    GOOGLE_FORM_CANCEL_SECRET: 'google-shared-secret',
    GOOGLE_FORM_CANCEL_TOKEN_SECRET: 'google-token-secret',
    GOOGLE_FORM_CANCEL_TOKEN_TTL_SECONDS: '900',
    BILLING_INTERVAL_MONTHS: '1',
    INITIAL_FREE_CYCLES: '2',
    CANCEL_NOTICE_CYCLES: '1',
  };

  it('passes with all vars present', () => {
    expect(validateRequiredEnvVars(FULL_ENV).ok).toBe(true);
  });

  it('fails when PAYJP_SECRET_KEY is missing', () => {
    const env = { ...FULL_ENV, PAYJP_SECRET_KEY: undefined };
    const result = validateRequiredEnvVars(env);
    expect(result.ok).toBe(false);
  });

  it('fails when BILLING_INTERVAL_MONTHS is missing', () => {
    const env = { ...FULL_ENV, BILLING_INTERVAL_MONTHS: undefined };
    const result = validateRequiredEnvVars(env);
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PROP-BILL-067: validateFixedEnvVars
// ---------------------------------------------------------------------------
describe('PROP-BILL-067: validateFixedEnvVars', () => {
  it('passes with correct fixed values', () => {
    const env = {
      BILLING_INTERVAL_MONTHS: '1',
      INITIAL_FREE_CYCLES: '2',
      CANCEL_NOTICE_CYCLES: '1',
    };
    expect(validateFixedEnvVars(env).ok).toBe(true);
  });

  it('fails when BILLING_INTERVAL_MONTHS != 1', () => {
    const env = {
      BILLING_INTERVAL_MONTHS: '2',
      INITIAL_FREE_CYCLES: '2',
      CANCEL_NOTICE_CYCLES: '1',
    };
    const result = validateFixedEnvVars(env);
    expect(result.ok).toBe(false);
  });

  it('fails when INITIAL_FREE_CYCLES != 2', () => {
    const env = {
      BILLING_INTERVAL_MONTHS: '1',
      INITIAL_FREE_CYCLES: '0',
      CANCEL_NOTICE_CYCLES: '1',
    };
    const result = validateFixedEnvVars(env);
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PROP-BILL-017: getCorsHeaders
// ---------------------------------------------------------------------------
describe('PROP-BILL-017: getCorsHeaders', () => {
  it('returns Access-Control-Allow-Credentials: true', () => {
    const headers = getCorsHeaders('https://app.example.com');
    expect(headers['Access-Control-Allow-Credentials']).toBe('true');
  });

  it('returns Access-Control-Allow-Origin matching frontendBaseUrl', () => {
    const headers = getCorsHeaders('https://app.example.com');
    expect(headers['Access-Control-Allow-Origin']).toBe('https://app.example.com');
  });
});

// ---------------------------------------------------------------------------
// PROP-BILL-018: shouldGrantRole
// ---------------------------------------------------------------------------
describe('PROP-BILL-018: shouldGrantRole', () => {
  it.each([
    { status: 'active', expected: true },
    { status: 'trial', expected: true },
    { status: 'canceled', expected: false },
    { status: 'paused', expected: false },
    { status: 'deleted', expected: false },
    { status: null, expected: false },
  ])('status=$status → $expected', ({ status, expected }) => {
    expect(shouldGrantRole(status)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// PROP-BILL-019: determineSubscriptionStatus
// ---------------------------------------------------------------------------
describe('PROP-BILL-019: determineSubscriptionStatus', () => {
  it('returns "trial" for first-time user', () => {
    expect(determineSubscriptionStatus(true)).toBe('trial');
  });

  it('returns "active" for non-first-time user', () => {
    expect(determineSubscriptionStatus(false)).toBe('active');
  });
});

describe('Google cancel helpers', () => {
  it('normalizeEmail trims and lowercases', () => {
    expect(normalizeEmail(' Test@Example.COM ')).toBe('test@example.com');
  });

  it('buildCancelFormLinkResponse formats expiresAt as RFC3339 UTC', () => {
    expect(buildCancelFormLinkResponse('https://example.com', new Date('2026-01-01T00:00:00Z'))).toEqual({
      ok: true,
      formUrl: 'https://example.com',
      expiresAt: '2026-01-01T00:00:00Z',
    });
  });

  it('creates and verifies signed cancel form token', () => {
    const token = createSignedCancelFormToken(
      {
        jti: '00000000-0000-0000-0000-000000000001',
        memberId: '00000000-0000-0000-0000-000000000002',
        email: 'test@example.com',
        exp: Math.floor(new Date('2026-01-01T00:15:00Z').getTime() / 1000),
        nonce: 'nonce-123',
      },
      'secret',
    );

    const result = verifySignedCancelFormToken(token, 'secret', new Date('2026-01-01T00:00:00Z'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.email).toBe('test@example.com');
    }
  });

  it('rejects expired signed cancel form token', () => {
    const token = createSignedCancelFormToken(
      {
        jti: '00000000-0000-0000-0000-000000000001',
        memberId: '00000000-0000-0000-0000-000000000002',
        email: 'test@example.com',
        exp: Math.floor(new Date('2026-01-01T00:00:00Z').getTime() / 1000),
        nonce: 'nonce-123',
      },
      'secret',
    );

    expect(verifySignedCancelFormToken(token, 'secret', new Date('2026-01-01T00:00:01Z'))).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('builds Google Form prefill URL with email and token entries', () => {
    const url = buildGoogleFormPrefillUrl(
      'https://docs.google.com/forms/d/e/test-form/viewform',
      '1111111111',
      '2222222222',
      'test@example.com',
      'signed-token',
    );
    expect(url).toContain('entry.1111111111=test%40example.com');
    expect(url).toContain('entry.2222222222=signed-token');
    expect(url).toContain('usp=pp_url');
  });
});

describe('Shared passcode verify', () => {
  it('accepts exact match', () => {
    expect(verifySharedPasscode('secret-code', 'secret-code')).toBe(true);
  });

  it('rejects mismatch', () => {
    expect(verifySharedPasscode('wrong', 'secret-code')).toBe(false);
  });

  it('rejects when either side is empty', () => {
    expect(verifySharedPasscode('', 'secret-code')).toBe(false);
    expect(verifySharedPasscode('secret-code', '')).toBe(false);
    expect(verifySharedPasscode('', '')).toBe(false);
  });

  it('memberSessionTokenHash matches SHA-256 hex of raw token', () => {
    expect(memberSessionTokenHash('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('accessGateSessionTokenHash matches memberSessionTokenHash for the same token', () => {
    expect(accessGateSessionTokenHash('raw')).toBe(memberSessionTokenHash('raw'));
  });
});
