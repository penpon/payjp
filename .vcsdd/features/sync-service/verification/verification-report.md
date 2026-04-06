# sync-service Verification Report

**Phase**: 5 (Formal Hardening)
**Date**: 2026-04-06

## Property-Based Test Results (PROP-SYNC-001 to PROP-SYNC-020)

All 20 property tests PASS (65 test cases via fast-check).

| ID | Function | Result | Notes |
|----|----------|--------|-------|
| PROP-SYNC-001 | validateWebhookToken | PASS | Empty → false; equal → true; diff → false |
| PROP-SYNC-002 | isAllowedEventType | PASS | 7 allowlisted types exact |
| PROP-SYNC-003 | isEventStale | PASS | Same-second boundary correct |
| PROP-SYNC-004 | mapSubscriptionStatus | PASS | 5 known → non-null; others → null |
| PROP-SYNC-005 | shouldGrantRole | PASS | active/trial/canceled → true |
| PROP-SYNC-006 | validateCliArgs | PASS | Mutual exclusion verified |
| PROP-SYNC-007 | determineCliExitCode | PASS | Exit code mapping correct |
| PROP-SYNC-008 | evaluateChargeSearchResult | PASS | Fail-close boundaries exact |
| PROP-SYNC-009 | isAccessEndExpired | PASS | Boundary at exact time |
| PROP-SYNC-010 | calculateLastEventTimestamp | PASS | max(existing, resync) |
| PROP-SYNC-011 | maskSensitiveLogFields | PASS | 5 sensitive keys masked |
| PROP-SYNC-012 | buildChargeSearchParams | PASS | since/until/limit correct |
| PROP-SYNC-013 | validateRequiredFields | PASS | Conditional data.status |
| PROP-SYNC-014 | formatRfc3339Utc | PASS | RFC 3339 pattern match |
| PROP-SYNC-015 | determineIgnoreReason | PASS | Priority: livemode > type > object |
| PROP-SYNC-016 | canResolveInflightOperation | PASS | Null safety + ID matching |
| PROP-SYNC-017 | shouldSyncRole | PASS | Same → false; diff → true |
| PROP-SYNC-018 | isStatusUnknown | PASS | Known → false; null → false |
| PROP-SYNC-019 | evaluateSubscriptionSearchResult | PASS | Metadata + period_end fallback |
| PROP-SYNC-020 | isInflightOperationStale | PASS | Threshold boundary correct |

## Integration Test Results (INT-SYNC-001 to INT-SYNC-039)

42 integration tests PASS across webhook flow and resync/CLI flow.

### Webhook Flow (17 tests)
- INT-SYNC-001: Happy path ✓
- INT-SYNC-002: Idempotency ✓
- INT-SYNC-003: Stale event ✓
- INT-SYNC-004: Same-second ✓
- INT-SYNC-005: Token mismatch → 401 ✓
- INT-SYNC-006: Unknown status → failed + revoke ✓
- INT-SYNC-007: subscription.created → ignored ✓
- INT-SYNC-008: Member resolution conflict ✓
- INT-SYNC-009: Status unchanged plan update ✓
- INT-SYNC-025: Discord retry success ✓
- INT-SYNC-026: Discord retry all fail ✓
- INT-SYNC-027: Log security ✓
- INT-SYNC-028: operation_id preservation ✓
- INT-SYNC-036: Concurrent serialization ✓
- INT-SYNC-038: subscription.renewed ✓
- INT-SYNC-039: DB unavailability → 503 ✓

### Resync/CLI Flow (25 tests)
- INT-SYNC-010 to INT-SYNC-024: All ✓
- INT-SYNC-029 to INT-SYNC-035: All ✓
- INT-SYNC-037: Individual error handling ✓

## Total: 107 tests, 0 failures
