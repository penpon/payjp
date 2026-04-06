# Sprint 1 Contract — billing-service

**Feature**: billing-service (R2–R5)
**Sprint**: 1
**Mode**: strict
**Status**: approved

---

## Scope

### Requirements
REQ-BILL-001 ~ REQ-BILL-035 (35 requirements), NFR-BILL-001 ~ NFR-BILL-004

### Artifact Set

| Layer | File | Purpose |
|-------|------|---------|
| Pure Core | `src/core/index.ts` | 19 pure functions + `linkSessionTokenHash` (platform crypto exception) |
| Pure Core | `src/core/env.ts` | EnvVarValidationResult type |
| Shell | `src/shell/types.ts` | DI interfaces: BillingDeps, DbClient, PayjpClient, DiscordClient |
| Shell | `src/shell/subscribe.ts` | handleSubscribe — 14-step orchestration |
| Shell | `src/shell/cancel.ts` | handleCancel — 12-step orchestration |
| Shell | `src/shell/errors.ts` | isUncertainError — failure classification |
| Shell | `src/shell/index.ts` | Shell layer exports |
| Shared | `packages/shared/src/types.ts` | Member, SubscriptionResponse, CancelResponse, FixedEnvVarValidationResult |

### Test Files

| File | Tests |
|------|-------|
| `src/core/__tests__/pure-core.test.ts` | 68 |
| `src/__tests__/integration/subscribe-flow.test.ts` | 37 |
| `src/__tests__/integration/cancel-flow.test.ts` | 19 |
| `src/__tests__/integration/failure-handling.test.ts` | 7 |
| `src/__tests__/integration/cross-cutting.test.ts` | 12 |
| **Total** | **143** |

---

## Binary Pass/Fail Criteria

### CRIT-001: Subscribe step ordering matches §5.1
**Dimension**: spec_fidelity
**Binary test**: PROP-BILL-062 passes — mock call-order recording verifies: (1) advisory lock before member lookup, (2) operationId before link session consumption, (3) link session consumption before PAY.JP token verification, (4) customer_id persistence before charge, (5) charge_id persistence before subscription, (6) subscription_id persistence before role sync.

### CRIT-002: Cancel step ordering matches §5.2
**Dimension**: spec_fidelity
**Binary test**: PROP-BILL-063 passes — link session validated early (before advisory lock), consumed after acceptance boundary, operationId before PAY.JP cancel.

### CRIT-003: Token used=false AND 3DS verified check
**Dimension**: spec_fidelity
**Binary test**: PayjpToken interface includes `used: boolean`. handleSubscribe rejects `used=true` with 422. PROP-BILL-029 covers non-verified 3DS statuses.

### CRIT-004: Fixed env var startup validation
**Dimension**: spec_fidelity
**Binary test**: PROP-BILL-067 passes — `BILLING_INTERVAL_MONTHS!=1`, `INITIAL_FREE_CYCLES!=2`, `CANCEL_NOTICE_CYCLES!=1` each cause validation failure.

### CRIT-005: initial_charge_paid_at persisted
**Dimension**: spec_fidelity
**Binary test**: updateMemberAfterSubscribe interface includes `initial_charge_paid_at: Date | null`. subscribe.ts sets it to `now` for first-time users with successful charge.

### CRIT-006: Property tests for pure core
**Dimension**: edge_case_coverage
**Binary test**: fast-check property tests pass for: validatePlanId, buildSubscriptionMetadata, formatRfc3339Utc, maskSensitiveLogFields, validateFrontendBaseUrl, buildSubscriptionResponse, buildCancelResponse.

### CRIT-007: Cancel boundary JST date rollup
**Dimension**: edge_case_coverage
**Binary test**: PROP-BILL-006 unit tests pass for month-end rollup (3/31→2/28, 5/31→4/30, leap year 2028), boundary ±1s (PROP-BILL-007).

### CRIT-008: 3DS exhaustive status table
**Dimension**: edge_case_coverage
**Binary test**: PROP-BILL-005 passes with case table: verified=true, attempted/failed/error/unverified/null/empty=false.

### CRIT-009: Concurrent subscribe guard
**Dimension**: edge_case_coverage
**Binary test**: PROP-BILL-023 passes — concurrent requests for same user serialized, exactly one succeeds.

### CRIT-010: Pure core no external I/O
**Dimension**: structural_integrity
**Binary test**: All 19 pure functions in core/index.ts have no async operations, no DB calls, no HTTP calls. Exception: `linkSessionTokenHash` uses `node:crypto` (deterministic platform crypto, documented here as acceptable exception).

### CRIT-011: Shell DI boundary
**Dimension**: structural_integrity
**Binary test**: handleSubscribe and handleCancel accept BillingDeps parameter. All external I/O goes through injected interfaces.

### CRIT-012: Uncertain failure retains inflight
**Dimension**: implementation_correctness
**Binary test**: PROP-BILL-051 passes — timeout during PAY.JP write → 503 + operationId, inflight_operation_* NOT cleared.

### CRIT-013: Definite failure before write clears inflight
**Dimension**: implementation_correctness
**Binary test**: PROP-BILL-052 passes — 3DS failure → inflight cleared, appropriate error code returned.

### CRIT-014: Post-write failure reconciliation
**Dimension**: implementation_correctness
**Binary test**: PROP-BILL-053a~053e pass — failure after customer/charge/subscription/cancel triggers re-fetch and reconciliation.

### CRIT-015: Role sync retry timing
**Dimension**: implementation_correctness
**Binary test**: PROP-BILL-039 passes — Discord 429/5xx triggers retry with delays (0s/1s/2s). PROP-BILL-040: final failure → 503 + operationId.

### CRIT-016: Cancel link session early validation
**Dimension**: implementation_correctness
**Binary test**: Link session validated before advisory lock in cancel flow. Invalid/expired/consumed sessions rejected with 401 before any DB member operations.

### CRIT-017: All tests GREEN
**Dimension**: verification_readiness
**Binary test**: `npm run test:billing` exits 0 with 143 tests passed.

### CRIT-018: Regression baseline
**Dimension**: verification_readiness
**Binary test**: `npm run test:auth` exits 0 with 102 tests passed (auth-service unchanged).

---

## Evidence
- Red phase: `evidence/sprint-1-red-phase.log`
- Green phase: `evidence/sprint-1-green-phase.log`
