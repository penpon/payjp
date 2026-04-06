# sync-service Purity Audit

**Phase**: 5 (Formal Hardening)
**Date**: 2026-04-06

## Pure Core Boundary Compliance

### Import Analysis
- `packages/sync-service/src/core/index.ts` imports:
  - `type { SubscriptionStatus } from '@hayane/shared'` — TYPE-ONLY (no runtime dependency)
- **No I/O imports**: No `node:crypto`, `node:fs`, `node:http`, `pg`, or network modules
- **No side effects**: All functions are pure input→output with no global state mutation

### Function-by-Function Audit

| Function | Pure? | Notes |
|----------|-------|-------|
| validateWebhookToken | ✓ | compareFn injected from shell (default: string equality) |
| isAllowedEventType | ✓ | Set.has on module-level constant |
| isSubscriptionDataObject | ✓ | String comparison |
| isLivemodeMismatch | ✓ | Boolean comparison |
| validateRequiredFields | ✓ | Object property checks |
| isEventDuplicate | ✓ | Set.has |
| isEventStale | ✓ | Number comparison |
| isSubscriptionCreatedEvent | ✓ | String comparison |
| determineIgnoreReason | ✓ | Composed from other pure functions |
| mapSubscriptionStatus | ✓ | Set.has + cast |
| shouldGrantRole | ✓ | Set.has |
| shouldSyncRole | ✓ | Inequality check |
| isStatusUnknown | ✓ | Null check + Set.has |
| maskSensitiveLogFields | ✓ | RegExp.test on keys, new object creation |
| buildTokenMismatchLog | ✓ | Object construction |
| formatRfc3339Utc | ✓ | Date.toISOString + regex replace |
| buildCliResult | ✓ | Object construction + Date.getTime arithmetic |
| determineCliExitCode | ✓ | Conditional returns |
| validateCliArgs | ✓ | Array iteration + string matching |
| isAccessEndExpired | ✓ | Date comparison |
| calculateLastEventTimestamp | ✓ | Math.max |
| isInflightOperationStale | ✓ | Date arithmetic |
| canResolveInflightOperation | ✓ | Null checks + string equality |
| buildChargeSearchParams | ✓ | Arithmetic + object construction |
| evaluateChargeSearchResult | ✓ | Number comparison |
| evaluateSubscriptionSearchResult | ✓ | Array/object inspection |
| validateWebhookRequiredEnvVars | ✓ | Array filter on constants |

### Shell Boundary

All I/O operations (DB queries, HTTP requests, Discord API calls, log writes) are confined to:
- `packages/sync-service/src/shell/webhook.ts`
- `packages/sync-service/src/shell/cli.ts`

The `node:crypto` import for `timingSafeEqual` is in the shell layer only (`webhook.ts`).

## Verdict: PASS — All 27 pure core functions are side-effect-free
