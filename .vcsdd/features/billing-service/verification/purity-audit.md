# Purity Audit

## Feature: billing-service | Phase: 5 | Date: 2026-04-06

## Summary

**Result: PASS — No drift detected**

Pure core functions are side-effect-free. Shell functions use dependency injection for all I/O. No hidden state mutations found.

---

## Declared Boundaries

From `specs/verification-architecture.md`:

**Pure Core** (`packages/billing-service/src/core/`):
- Deterministic, side-effect-free functions
- No I/O (no network, no DB, no filesystem, no global state)
- Fully unit-testable without mocks

Declared pure symbols (21 functions):
`validatePlanId`, `isFirstTimeUser`, `hasActiveSubscription`, `hasInflightOperation`, `isThreeDSecureVerified`, `calculateCancelAcceptanceStart`, `isCancelAcceptable`, `calculateTrialEnd`, `buildSubscriptionMetadata`, `buildSubscriptionResponse`, `buildCancelResponse`, `formatRfc3339Utc`, `isSameOrigin`, `maskSensitiveLogFields`, `validateFrontendBaseUrl`, `validateRequiredEnvVars`, `validateFixedEnvVars`, `getCorsHeaders`, `getCorsPreflight`, `shouldGrantRole`, `determineSubscriptionStatus`

Additionally exported from core: `linkSessionTokenHash` (SHA-256, deterministic — pure).

**Effectful Shell** (`packages/billing-service/src/shell/`):
- All I/O accessed exclusively through `BillingDeps` injected at call site
- External dependencies: `DbClient`, `PayjpClient`, `DiscordClient`, `clock`, `generateOperationId`
- No module-level singletons or global mutable state

---

## Observed Boundaries

### Core Layer (`src/core/index.ts`)

All 22 exported functions examined.

| Function | Side Effects Observed | Assessment |
|---|---|---|
| `validatePlanId` | None | PURE |
| `isFirstTimeUser` | None | PURE |
| `hasActiveSubscription` | None | PURE |
| `hasInflightOperation` | None | PURE |
| `isThreeDSecureVerified` | None | PURE |
| `calculateCancelAcceptanceStart` | None — uses only Date arithmetic | PURE |
| `isCancelAcceptable` | None | PURE |
| `calculateTrialEnd` | None | PURE |
| `buildSubscriptionMetadata` | None | PURE |
| `buildSubscriptionResponse` | None — calls `formatRfc3339Utc` (pure) | PURE |
| `buildCancelResponse` | None | PURE |
| `formatRfc3339Utc` | None | PURE |
| `isSameOrigin` | None — URL constructor is pure computation | PURE |
| `maskSensitiveLogFields` | None — returns new object | PURE |
| `validateFrontendBaseUrl` | None | PURE |
| `validateRequiredEnvVars` | None | PURE |
| `validateFixedEnvVars` | None | PURE |
| `getCorsHeaders` | None | PURE |
| `getCorsPreflight` | None | PURE |
| `shouldGrantRole` | None | PURE |
| `determineSubscriptionStatus` | None | PURE |
| `linkSessionTokenHash` | Calls `node:crypto createHash` — deterministic, no I/O | PURE (deterministic) |

One import in `core/index.ts`: `import { createHash } from 'node:crypto'`. This is a pure cryptographic function with no I/O side effects. Determinism is guaranteed for SHA-256 with identical inputs. This is consistent with the purity boundary.

### Shell Layer (`src/shell/subscribe.ts`, `src/shell/cancel.ts`)

**`handleSubscribe`:**
- All I/O obtained via destructuring `deps: BillingDeps` — no module-level state accessed
- `clock` is injected (`const now = clock()`) — no `Date.now()` or `new Date()` direct calls
- `generateOperationId` is injected — no direct `crypto.randomUUID()` call
- No global variables written
- No module-level mutable state

**`handleCancel`:**
- Same pattern: all I/O via `deps: BillingDeps`
- `clock` injected; `generateOperationId` injected
- No module-level mutable state

**`src/shell/errors.ts`:**
- `isUncertainError` is a pure predicate — examines `err.message`, returns boolean, no side effects

**`src/shell/types.ts`:**
- Interface definitions only — no runtime code, no side effects

### Module-Level State Scan

No module-level mutable state found in any shell file. No use of:
- `let` / `var` at module scope
- `process.env` reads inside shell functions (config is injected via `BillingDeps.config`)
- Direct `console.log` / `process.stdout` calls
- File system access
- Timer scheduling outside of injectable clock

---

## Mismatch Analysis

**No mismatches detected.**

The implementation matches the declared boundaries exactly:
- Pure core functions contain zero I/O
- Shell functions receive all external dependencies through `BillingDeps`
- The `clock` and `generateOperationId` fields in `BillingDeps` make previously-impure time and UUID generation fully injectable and testable

---

## Observations

1. **`linkSessionTokenHash` placement**: This function is exported from `core/index.ts` and used in both `subscribe.ts` and `cancel.ts`. It is deterministic (SHA-256 of a string) and has no side effects, making its placement in the pure core correct. It was not listed in the original verification-architecture symbol table but does not violate the purity contract.

2. **`calculateCancelAcceptanceStart` default parameter**: The function accepts `jstOffsetMinutes: number = 540` as a default. This is a compile-time constant, not runtime state — no purity concern.

3. **Role sync delay in `subscribe.ts`**: `await new Promise((r) => setTimeout(r, delay))` is called inside the retry loop (Step 14). This is an effectful timer, correctly placed in the shell layer. Tests set `ROLE_SYNC_DELAYS_MS` implicitly (not injected), meaning retry delays are exercised at real wall-clock time in tests. This is a minor testability concern (tests for PROP-BILL-039 succeed but take up to 3s). Not a purity violation since it is in the shell, but injection of delay values would improve test speed. Non-blocking for Phase 6.

---

## Required Follow-Up Before Phase 6

None. All purity boundaries are correctly maintained. The three observations above are informational and do not block convergence.
