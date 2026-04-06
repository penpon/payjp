# Verification Report

## Feature: auth-service | Sprint: 1 | Date: 2026-04-06

---

## Proof Obligations

| ID | Tier | Required | Status | Tool | Coverage |
|----|------|----------|--------|------|---------|
| PROP-AUTH-001 | 1 | true | proved | Vitest + fast-check | pure-core.test.ts |
| PROP-AUTH-002 | 1 | true | proved | Vitest | pure-core.test.ts |
| PROP-AUTH-003 | 1 | true | proved | Vitest + fast-check | pure-core.test.ts |
| PROP-AUTH-004 | 1 | true | proved | Vitest | pure-core.test.ts |
| PROP-AUTH-005 | 1 | true | proved | Vitest + fast-check | pure-core.test.ts |
| PROP-AUTH-006 | 1 | true | proved | Vitest | pure-core.test.ts |
| PROP-AUTH-007 | 1 | true | proved | Vitest | pure-core.test.ts |
| PROP-AUTH-008 | 1 | true | proved | Vitest | pure-core.test.ts |
| PROP-AUTH-009 | 1 | true | proved | Vitest + fast-check | pure-core.test.ts |
| PROP-AUTH-010 | 2 | true | proved | Vitest (in-memory store) | auth-flow.test.ts |
| PROP-AUTH-011 | 2 | true | proved | Vitest | auth-flow.test.ts |
| PROP-AUTH-012 | 2 | true | proved | Vitest | auth-flow.test.ts |
| PROP-AUTH-013 | 2 | true | proved | Vitest | auth-flow.test.ts |
| PROP-AUTH-014 | 2 | true | proved | Vitest | auth-flow.test.ts |
| PROP-AUTH-015 | 2 | true | proved | Vitest | auth-flow.test.ts |
| PROP-AUTH-016 | 2 | true | proved | Vitest | auth-flow.test.ts |
| PROP-AUTH-017 | 2 | true | proved | Vitest | auth-flow.test.ts |
| PROP-AUTH-018 | 2 | true | proved | Vitest | auth-flow.test.ts |
| PROP-AUTH-019 | 2 | true | proved | Vitest | auth-flow.test.ts |
| PROP-AUTH-020 | 2 | true | proved | Vitest | auth-flow.test.ts |
| PROP-AUTH-021 | 2 | true | proved | Vitest | auth-flow.test.ts |
| PROP-AUTH-022 | 2 | true | proved | Vitest | auth-flow.test.ts |
| PROP-AUTH-023 | 2 | true | proved | Vitest | auth-flow.test.ts |
| PROP-AUTH-024 | 2 | true | proved | Vitest | auth-flow.test.ts |
| PROP-AUTH-025 | 3 | true | skipped | Manual validation required | Staging environment |
| PROP-AUTH-026 | 3 | false | skipped | Manual / E2E smoke test | Not required for Phase 6 |
| PROP-AUTH-027 | 1 | true | proved | Vitest | pure-core.test.ts |
| PROP-AUTH-028 | 1 | true | proved | Vitest + fast-check | pure-core.test.ts |
| PROP-AUTH-029 | 2 | true | proved | Vitest | auth-flow.test.ts |
| PROP-AUTH-030 | 3 | false | skipped | Performance benchmark (k6/autocannon) | Not required for Phase 6 |

**Note**: PROP-AUTH-031 through PROP-AUTH-036 are defined in verification-architecture.md but not listed in state.json proofObligations. They are covered by tests in pure-core.test.ts (031-034) and auth-flow.test.ts (035-036).

---

## Results

### Tier 1 — Vitest + fast-check (property tests)

**Command**: `npm run test --workspace=packages/auth-service`

**Output**:
```
 RUN  v3.2.4 /Users/nana/workspace/hayane_payjp/packages/auth-service
 ✓ src/__tests__/integration/auth-flow.test.ts (38 tests) 16ms
 ✓ src/core/__tests__/pure-core.test.ts (64 tests) 672ms
 Test Files  2 passed (2)
      Tests  102 passed (102)
   Start at  10:42:13
   Duration  1.47s
```

**Test distribution**:
- `pure-core.test.ts`: 64 tests covering PROP-AUTH-001 through PROP-AUTH-009, PROP-AUTH-027, PROP-AUTH-028, and supplementary tests for PROP-AUTH-031 through PROP-AUTH-034
- `auth-flow.test.ts`: 38 tests covering PROP-AUTH-010 through PROP-AUTH-024, PROP-AUTH-029, PROP-AUTH-036

### fast-check property tests confirmed

- **PROP-AUTH-001**: 100 runs, arbitrary `clientId × redirectUri × state` — scope always `identify`
- **PROP-AUTH-003**: 50 runs, arbitrary valid OAuth state records — always `ok: true`
- **PROP-AUTH-005**: 50 runs, arbitrary strings for sensitive log keys — always `[REDACTED]`
- **PROP-AUTH-009**: 50 runs, arbitrary URLs with trailing slash — always rejected
- **PROP-AUTH-028**: 50 runs, arbitrary valid link session records — always `ok: true`

### PROP-AUTH-025 — Manual Validation Required

- **Tier**: 3
- **Required**: true
- **Status**: skipped
- **Reason**: Requires staging environment deployment. The `validateStartupConfig` function (tested via PROP-AUTH-020) correctly rejects trailing-slash `FRONTEND_BASE_URL`. The underlying logic is proved at Tier 1/2. The Tier 3 obligation requires confirming process exit behavior in a staging deploy.
- **Action required before Go-Live**: Deploy to staging with `FRONTEND_BASE_URL=https://frontend.example.com/` and confirm process exits non-zero.

### Degradation Notice — PROP-AUTH-025

PROP-AUTH-025 is `required: true` with `tier: 3`. Tier 3 tooling (live staging deploy) is not executable in this automated phase. The underlying property (startup config validation) is proved at Tier 2 via PROP-AUTH-020. This obligation remains `skipped` and must be resolved manually before Phase 6 convergence.

**BLOCKING**: Phase 6 will not accept `status: "skipped"` for `required: true` obligations. PROP-AUTH-025 must be promoted to `proved` via manual staging validation before final convergence.

---

## Summary

- Required obligations: 28
- Proved: 27
- Failed: 0
- Skipped (required): 1 — PROP-AUTH-025 (manual staging validation pending)
- Skipped (not required): 2 — PROP-AUTH-026, PROP-AUTH-030
- Total tests passing: 102 / 102
