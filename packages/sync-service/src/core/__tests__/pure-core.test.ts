/**
 * sync-service Pure Core — Property-Based Tests (PROP-SYNC-001 to PROP-SYNC-020)
 * Phase 2a (Red): All tests should FAIL against stubs
 */

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  buildChargeSearchParams,
  calculateLastEventTimestamp,
  canResolveInflightOperation,
  determineCliExitCode,
  determineIgnoreReason,
  evaluateChargeSearchResult,
  evaluateSubscriptionSearchResult,
  formatRfc3339Utc,
  isAccessEndExpired,
  isAllowedEventType,
  isEventStale,
  isInflightOperationStale,
  isStatusUnknown,
  mapSubscriptionStatus,
  maskSensitiveLogFields,
  shouldGrantRole,
  shouldSyncRole,
  validateCliArgs,
  validateRequiredFields,
  validateWebhookToken,
} from '../index.js';

// PROP-SYNC-001: validateWebhookToken
describe('PROP-SYNC-001: validateWebhookToken', () => {
  it('equal non-empty strings → true', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (s) => {
        expect(validateWebhookToken(s, s)).toBe(true);
      }),
    );
  });

  it('different strings → false', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.string({ minLength: 1 }), (a, b) => {
        fc.pre(a !== b);
        expect(validateWebhookToken(a, b)).toBe(false);
      }),
    );
  });

  it('empty received → false', () => {
    expect(validateWebhookToken('', 'expected')).toBe(false);
  });

  it('empty expected → false', () => {
    expect(validateWebhookToken('received', '')).toBe(false);
  });

  it('both empty → false', () => {
    expect(validateWebhookToken('', '')).toBe(false);
  });
});

// PROP-SYNC-002: isAllowedEventType
describe('PROP-SYNC-002: isAllowedEventType', () => {
  const ALLOWED = [
    'subscription.created',
    'subscription.updated',
    'subscription.renewed',
    'subscription.canceled',
    'subscription.deleted',
    'subscription.paused',
    'subscription.resumed',
  ];

  it('all 7 allowlisted types → true', () => {
    for (const t of ALLOWED) {
      expect(isAllowedEventType(t)).toBe(true);
    }
  });

  it('arbitrary non-allowed strings → false', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        fc.pre(!ALLOWED.includes(s));
        expect(isAllowedEventType(s)).toBe(false);
      }),
    );
  });
});

// PROP-SYNC-003: isEventStale
describe('PROP-SYNC-003: isEventStale', () => {
  it('created < last → true (stale)', () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), (a, b) => {
        fc.pre(a < b);
        expect(isEventStale(a, b)).toBe(true);
      }),
    );
  });

  it('created == last → false (same-second rule)', () => {
    fc.assert(
      fc.property(fc.integer(), (n) => {
        expect(isEventStale(n, n)).toBe(false);
      }),
    );
  });

  it('created > last → false', () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), (a, b) => {
        fc.pre(a > b);
        expect(isEventStale(a, b)).toBe(false);
      }),
    );
  });

  it('last == null → false', () => {
    fc.assert(
      fc.property(fc.integer(), (n) => {
        expect(isEventStale(n, null)).toBe(false);
      }),
    );
  });
});

// PROP-SYNC-004: mapSubscriptionStatus
describe('PROP-SYNC-004: mapSubscriptionStatus', () => {
  const KNOWN = ['active', 'trial', 'canceled', 'paused', 'deleted'];

  it('known statuses → non-null', () => {
    for (const s of KNOWN) {
      expect(mapSubscriptionStatus(s)).not.toBeNull();
    }
  });

  it('unknown statuses → null', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        fc.pre(!KNOWN.includes(s));
        expect(mapSubscriptionStatus(s)).toBeNull();
      }),
    );
  });
});

// PROP-SYNC-005: shouldGrantRole
describe('PROP-SYNC-005: shouldGrantRole', () => {
  it('active/trial/canceled → true', () => {
    expect(shouldGrantRole('active')).toBe(true);
    expect(shouldGrantRole('trial')).toBe(true);
    expect(shouldGrantRole('canceled')).toBe(true);
  });

  it('paused/deleted/null → false', () => {
    expect(shouldGrantRole('paused')).toBe(false);
    expect(shouldGrantRole('deleted')).toBe(false);
    expect(shouldGrantRole(null)).toBe(false);
  });

  it('arbitrary other strings → false', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        fc.pre(!['active', 'trial', 'canceled'].includes(s));
        expect(shouldGrantRole(s)).toBe(false);
      }),
    );
  });
});

// PROP-SYNC-006: validateCliArgs
describe('PROP-SYNC-006: validateCliArgs', () => {
  it('--operation-id with value → valid', () => {
    const result = validateCliArgs(['--operation-id', 'op-123']);
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('operation-id');
    expect(result.value).toBe('op-123');
  });

  it('--discord-user-id with value → valid', () => {
    const result = validateCliArgs(['--discord-user-id', 'user-456']);
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('discord-user-id');
    expect(result.value).toBe('user-456');
  });

  it('--all → valid', () => {
    const result = validateCliArgs(['--all']);
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('all');
  });

  it('0 args → invalid', () => {
    expect(validateCliArgs([]).ok).toBe(false);
  });

  it('2+ modes → invalid', () => {
    expect(validateCliArgs(['--all', '--discord-user-id', 'x']).ok).toBe(false);
  });

  it('unknown arg → invalid', () => {
    expect(validateCliArgs(['--unknown']).ok).toBe(false);
  });
});

// PROP-SYNC-007: determineCliExitCode
describe('PROP-SYNC-007: determineCliExitCode', () => {
  it('cliError → 1 (regardless of failedCount)', () => {
    fc.assert(
      fc.property(fc.nat(), (n) => {
        expect(determineCliExitCode(n, true)).toBe(1);
      }),
    );
  });

  it('no error, failedCount > 0 → 2', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1 }), (n) => {
        expect(determineCliExitCode(n, false)).toBe(2);
      }),
    );
  });

  it('no error, failedCount == 0 → 0', () => {
    expect(determineCliExitCode(0, false)).toBe(0);
  });
});

// PROP-SYNC-008: evaluateChargeSearchResult
describe('PROP-SYNC-008: evaluateChargeSearchResult', () => {
  it('0 matches, no hasMore → proceed', () => {
    expect(evaluateChargeSearchResult(0, false)).toBe('proceed');
  });

  it('1 match, no hasMore → existing', () => {
    expect(evaluateChargeSearchResult(1, false)).toBe('existing');
  });

  it('2+ matches → fail-close', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 100 }), (n) => {
        expect(evaluateChargeSearchResult(n, false)).toBe('fail-close');
      }),
    );
  });

  it('hasMoreAtLimit → fail-close (regardless of matches)', () => {
    fc.assert(
      fc.property(fc.nat({ max: 100 }), (n) => {
        expect(evaluateChargeSearchResult(n, true)).toBe('fail-close');
      }),
    );
  });
});

// PROP-SYNC-009: isAccessEndExpired
describe('PROP-SYNC-009: isAccessEndExpired', () => {
  it('null → false', () => {
    expect(isAccessEndExpired(null, new Date())).toBe(false);
  });

  it('future date → false', () => {
    const now = new Date('2026-04-06T12:00:00Z');
    const future = new Date('2026-04-07T12:00:00Z');
    expect(isAccessEndExpired(future, now)).toBe(false);
  });

  it('past date → true', () => {
    const now = new Date('2026-04-06T12:00:00Z');
    const past = new Date('2026-04-05T12:00:00Z');
    expect(isAccessEndExpired(past, now)).toBe(true);
  });

  it('exact same time → true (expired at boundary)', () => {
    const now = new Date('2026-04-06T12:00:00Z');
    expect(isAccessEndExpired(new Date(now), now)).toBe(true);
  });
});

// PROP-SYNC-010: calculateLastEventTimestamp
describe('PROP-SYNC-010: calculateLastEventTimestamp', () => {
  it('result ≥ both inputs', () => {
    fc.assert(
      fc.property(fc.option(fc.integer(), { nil: null }), fc.integer(), (existing, resync) => {
        const result = calculateLastEventTimestamp(existing, resync);
        expect(result).toBeGreaterThanOrEqual(resync);
        if (existing !== null) {
          expect(result).toBeGreaterThanOrEqual(existing);
        }
      }),
    );
  });

  it('null existing → returns resyncStartUnix', () => {
    expect(calculateLastEventTimestamp(null, 100)).toBe(100);
  });
});

// PROP-SYNC-011: maskSensitiveLogFields
describe('PROP-SYNC-011: maskSensitiveLogFields', () => {
  const SENSITIVE_KEYS = ['card', 'token', 'authorization', 'cookie', 'set-cookie'];

  it('sensitive keys are masked', () => {
    for (const key of SENSITIVE_KEYS) {
      const result = maskSensitiveLogFields({ [key]: 'secret-value' });
      expect(result[key]).toBe('[REDACTED]');
    }
  });

  it('non-sensitive keys are preserved', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (key, value) => {
        fc.pre(!SENSITIVE_KEYS.includes(key.toLowerCase()));
        const result = maskSensitiveLogFields({ [key]: value });
        expect(result[key]).toBe(value);
      }),
    );
  });
});

// PROP-SYNC-012: buildChargeSearchParams
describe('PROP-SYNC-012: buildChargeSearchParams', () => {
  it('since = input - 3600, until = input + 604800, limit = 100', () => {
    fc.assert(
      fc.property(fc.integer({ min: 10000, max: 2000000000 }), (ts) => {
        const result = buildChargeSearchParams('cust_xxx', ts);
        expect(result.since).toBe(ts - 3600);
        expect(result.until).toBe(ts + 604800);
        expect(result.limit).toBe(100);
        expect(result.customer).toBe('cust_xxx');
      }),
    );
  });
});

// PROP-SYNC-013: validateRequiredFields
describe('PROP-SYNC-013: validateRequiredFields', () => {
  it('all fields present for non-created/deleted → ok', () => {
    const event = {
      id: 'evt_1',
      type: 'subscription.updated',
      created: 1000,
      data: { id: 'sub_1', status: 'active' },
    };
    expect(validateRequiredFields(event).ok).toBe(true);
  });

  it('missing event.id → not ok', () => {
    const event = {
      type: 'subscription.updated',
      created: 1000,
      data: { id: 'sub_1', status: 'active' },
    };
    const result = validateRequiredFields(event);
    expect(result.ok).toBe(false);
    expect(result.missingFields).toContain('event.id');
  });

  it('created/deleted events do not require data.status', () => {
    const event = {
      id: 'evt_1',
      type: 'subscription.created',
      created: 1000,
      data: { id: 'sub_1' },
    };
    expect(validateRequiredFields(event).ok).toBe(true);
  });

  it('non-created/deleted without data.status → not ok', () => {
    const event = {
      id: 'evt_1',
      type: 'subscription.updated',
      created: 1000,
      data: { id: 'sub_1' },
    };
    const result = validateRequiredFields(event);
    expect(result.ok).toBe(false);
    expect(result.missingFields).toContain('data.status');
  });
});

// PROP-SYNC-014: formatRfc3339Utc
describe('PROP-SYNC-014: formatRfc3339Utc', () => {
  it('output matches RFC 3339 UTC pattern', () => {
    fc.assert(
      fc.property(fc.date({ min: new Date('2000-01-01'), max: new Date('2099-12-31'), noInvalidDate: true }), (d) => {
        const result = formatRfc3339Utc(d);
        expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      }),
    );
  });
});

// PROP-SYNC-015: determineIgnoreReason
describe('PROP-SYNC-015: determineIgnoreReason', () => {
  it('livemode mismatch has highest priority', () => {
    const event = {
      id: 'evt_1',
      type: 'unknown.type',
      livemode: false,
      data: { object: 'charge' },
    };
    const reason = determineIgnoreReason(event, true);
    expect(reason).toContain('livemode');
  });

  it('type not in allowlist (livemode ok) → type reason', () => {
    const event = {
      id: 'evt_1',
      type: 'charge.succeeded',
      livemode: true,
      data: { object: 'subscription' },
    };
    const reason = determineIgnoreReason(event, true);
    expect(reason).toContain('type');
  });

  it('data.object mismatch (livemode ok, type ok) → object reason', () => {
    const event = {
      id: 'evt_1',
      type: 'subscription.updated',
      livemode: true,
      data: { object: 'charge' },
    };
    const reason = determineIgnoreReason(event, true);
    expect(reason).toContain('object');
  });

  it('all valid → null', () => {
    const event = {
      id: 'evt_1',
      type: 'subscription.updated',
      livemode: true,
      data: { object: 'subscription' },
    };
    expect(determineIgnoreReason(event, true)).toBeNull();
  });
});

// PROP-SYNC-016: canResolveInflightOperation
describe('PROP-SYNC-016: canResolveInflightOperation', () => {
  it('all valid → true', () => {
    expect(canResolveInflightOperation('active', 'sub_1', 'sub_1', 'cust_1')).toBe(true);
  });

  it('null customerID → false', () => {
    expect(canResolveInflightOperation('active', 'sub_1', 'sub_1', null)).toBe(false);
  });

  it('null status → false', () => {
    expect(canResolveInflightOperation(null, 'sub_1', 'sub_1', 'cust_1')).toBe(false);
  });

  it('mismatched subscription IDs → false', () => {
    expect(canResolveInflightOperation('active', 'sub_1', 'sub_2', 'cust_1')).toBe(false);
  });
});

// PROP-SYNC-017: shouldSyncRole
describe('PROP-SYNC-017: shouldSyncRole', () => {
  it('same status → false', () => {
    fc.assert(
      fc.property(fc.constantFrom('active', 'trial', 'canceled', 'paused', 'deleted', null), (s) => {
        expect(shouldSyncRole(s, s)).toBe(false);
      }),
    );
  });

  it('different statuses → true', () => {
    expect(shouldSyncRole('active', 'canceled')).toBe(true);
    expect(shouldSyncRole(null, 'active')).toBe(true);
    expect(shouldSyncRole('trial', 'paused')).toBe(true);
  });
});

// PROP-SYNC-018: isStatusUnknown
describe('PROP-SYNC-018: isStatusUnknown', () => {
  const KNOWN = ['active', 'trial', 'canceled', 'paused', 'deleted'];

  it('known statuses → false', () => {
    for (const s of KNOWN) {
      expect(isStatusUnknown(s)).toBe(false);
    }
  });

  it('null → false (null is a known absence, not unknown)', () => {
    expect(isStatusUnknown(null)).toBe(false);
  });

  it('arbitrary unknown strings → true', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (s) => {
        fc.pre(!KNOWN.includes(s));
        expect(isStatusUnknown(s)).toBe(true);
      }),
    );
  });
});

// PROP-SYNC-019: evaluateSubscriptionSearchResult
describe('PROP-SYNC-019: evaluateSubscriptionSearchResult', () => {
  it('0 candidates → fail-close', () => {
    expect(evaluateSubscriptionSearchResult([], 'user_1', 1000)).toBe('fail-close');
  });

  it('1 candidate with metadata match → single-match', () => {
    const candidates = [{ id: 'sub_1', status: 'active', metadata: { discord_user_id: 'user_1' } }];
    expect(evaluateSubscriptionSearchResult(candidates, 'user_1', 1000)).toBe('single-match');
  });

  it('2+ candidates → fail-close', () => {
    const candidates = [
      { id: 'sub_1', status: 'active', metadata: { discord_user_id: 'user_1' } },
      { id: 'sub_2', status: 'trial', metadata: { discord_user_id: 'user_1' } },
    ];
    expect(evaluateSubscriptionSearchResult(candidates, 'user_1', 1000)).toBe('fail-close');
  });

  it('1 candidate without metadata but period_end matches → single-match', () => {
    const candidates = [{ id: 'sub_1', status: 'active', current_period_end: 1000 }];
    expect(evaluateSubscriptionSearchResult(candidates, 'user_1', 1000)).toBe('single-match');
  });

  it('1 candidate without metadata and period_end mismatch → fail-close', () => {
    const candidates = [{ id: 'sub_1', status: 'active', current_period_end: 9999 }];
    expect(evaluateSubscriptionSearchResult(candidates, 'user_1', 1000)).toBe('fail-close');
  });

  it('null accessEndAtUnix → fail-close', () => {
    const candidates = [{ id: 'sub_1', status: 'active' }];
    expect(evaluateSubscriptionSearchResult(candidates, 'user_1', null)).toBe('fail-close');
  });
});

// PROP-SYNC-020: isInflightOperationStale
describe('PROP-SYNC-020: isInflightOperationStale', () => {
  it('null startedAt → false', () => {
    expect(isInflightOperationStale(null, new Date(), 30)).toBe(false);
  });

  it('within threshold → false', () => {
    const now = new Date('2026-04-06T12:30:00Z');
    const started = new Date('2026-04-06T12:10:00Z'); // 20 min ago
    expect(isInflightOperationStale(started, now, 30)).toBe(false);
  });

  it('beyond threshold → true', () => {
    const now = new Date('2026-04-06T12:31:00Z');
    const started = new Date('2026-04-06T12:00:00Z'); // 31 min ago
    expect(isInflightOperationStale(started, now, 30)).toBe(true);
  });
});
