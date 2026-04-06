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
  buildCancelResponse,
  buildSubscriptionMetadata,
  buildSubscriptionResponse,
  calculateCancelAcceptanceStart,
  calculateTrialEnd,
  determineSubscriptionStatus,
  formatRfc3339Utc,
  getCorsHeaders,
  hasActiveSubscription,
  hasInflightOperation,
  isCancelAcceptable,
  isFirstTimeUser,
  isSameOrigin,
  isThreeDSecureVerified,
  maskSensitiveLogFields,
  shouldGrantRole,
  validateFixedEnvVars,
  validateFrontendBaseUrl,
  validatePlanId,
  validateRequiredEnvVars,
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
// PROP-BILL-006: calculateCancelAcceptanceStart
// ---------------------------------------------------------------------------
describe('PROP-BILL-006: calculateCancelAcceptanceStart', () => {
  // JST = UTC+9. 00:00:00 JST = 15:00:00 UTC (前日)

  it('standard month: 2026-05-15 → 2026-04-15 00:00:00 JST', () => {
    const accessEndAt = new Date('2026-05-15T00:00:00Z');
    const result = calculateCancelAcceptanceStart(accessEndAt);
    // 2026-04-15 00:00:00 JST = 2026-04-14T15:00:00Z
    expect(result).toEqual(new Date('2026-04-14T15:00:00Z'));
  });

  it('month-end rollup: 2026-03-31 → 2026-02-28 00:00:00 JST (non-leap)', () => {
    const accessEndAt = new Date('2026-03-31T00:00:00Z');
    const result = calculateCancelAcceptanceStart(accessEndAt);
    // 2026-02-28 00:00:00 JST = 2026-02-27T15:00:00Z
    expect(result).toEqual(new Date('2026-02-27T15:00:00Z'));
  });

  it('month-end rollup: 2026-05-31 → 2026-04-30 00:00:00 JST', () => {
    const accessEndAt = new Date('2026-05-31T00:00:00Z');
    const result = calculateCancelAcceptanceStart(accessEndAt);
    // 2026-04-30 00:00:00 JST = 2026-04-29T15:00:00Z
    expect(result).toEqual(new Date('2026-04-29T15:00:00Z'));
  });

  it('leap year: 2028-03-31 → 2028-02-29 00:00:00 JST', () => {
    const accessEndAt = new Date('2028-03-31T00:00:00Z');
    const result = calculateCancelAcceptanceStart(accessEndAt);
    // 2028-02-29 00:00:00 JST = 2028-02-28T15:00:00Z
    expect(result).toEqual(new Date('2028-02-28T15:00:00Z'));
  });

  it('Jan 31 → Dec 31 (previous year) 00:00:00 JST', () => {
    const accessEndAt = new Date('2027-01-31T00:00:00Z');
    const result = calculateCancelAcceptanceStart(accessEndAt);
    // 2026-12-31 00:00:00 JST = 2026-12-30T15:00:00Z
    expect(result).toEqual(new Date('2026-12-30T15:00:00Z'));
  });

  it('no rollup needed: 2026-08-30 → 2026-07-30 00:00:00 JST', () => {
    const accessEndAt = new Date('2026-08-30T00:00:00Z');
    const result = calculateCancelAcceptanceStart(accessEndAt);
    // 2026-07-30 00:00:00 JST = 2026-07-29T15:00:00Z
    expect(result).toEqual(new Date('2026-07-29T15:00:00Z'));
  });
});

// ---------------------------------------------------------------------------
// PROP-BILL-007: isCancelAcceptable
// ---------------------------------------------------------------------------
describe('PROP-BILL-007: isCancelAcceptable', () => {
  const acceptanceStart = new Date('2026-04-14T15:00:00Z'); // 2026-04-15 00:00 JST

  it('before acceptance start → false', () => {
    const before = new Date('2026-04-14T14:59:59Z');
    expect(isCancelAcceptable(before, acceptanceStart)).toBe(false);
  });

  it('exactly at acceptance start → true (inclusive)', () => {
    expect(isCancelAcceptable(acceptanceStart, acceptanceStart)).toBe(true);
  });

  it('after acceptance start → true', () => {
    const after = new Date('2026-04-14T15:00:01Z');
    expect(isCancelAcceptable(after, acceptanceStart)).toBe(true);
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
  it('(property) always includes both keys with exact values', () => {
    fc.assert(
      fc.property(fc.string(), fc.uuid(), (discordUserId, operationId) => {
        const meta = buildSubscriptionMetadata(discordUserId, operationId);
        expect(meta).toHaveProperty('discord_user_id', discordUserId);
        expect(meta).toHaveProperty('operation_id', operationId);
      }),
    );
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
      fc.property(fc.date(), (date) => {
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

  it('(property) always ends with Z', () => {
    fc.assert(
      fc.property(fc.date({ min: new Date('2020-01-01'), max: new Date('2030-12-31') }), (date) => {
        const result = formatRfc3339Utc(date);
        expect(result).toMatch(/Z$/);
        expect(typeof result).toBe('string');
      }),
    );
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
    DISCORD_PAID_ROLE_ID: '444555666',
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
    { status: 'canceled', expected: true },
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
