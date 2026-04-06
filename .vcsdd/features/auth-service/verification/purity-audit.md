# Purity Audit

## Feature: auth-service | Date: 2026-04-06

---

## Declared Boundaries

From `specs/verification-architecture.md` (Phase 1b):

### Pure Core — declared
File: `packages/auth-service/src/core/index.ts`

All symbols must be: deterministic, side-effect-free, no I/O, no crypto imports, no network calls. Fully unit-testable without mocks.

| Symbol | Declared Pure |
|--------|--------------|
| `buildDiscordAuthorizationUrl` | yes |
| `isExpired` | yes |
| `isUsed` | yes |
| `validateOAuthStateRecord` | yes |
| `validateLinkSessionRecord` | yes |
| `buildCookieAttributes` | yes |
| `serializeCookieAttributes` | yes |
| `maskSensitiveLogFields` | yes |
| `isSameOrigin` | yes |
| `validateFrontendBaseUrl` | yes |
| `buildCallbackRedirectUrl` | yes |
| `getSecurityHeaders` | yes |
| `getCorsHeaders` | yes |
| `validateRequiredEnvVars` | yes |

Note: `stateHash`, `oauthSessionHash`, `linkSessionTokenHash` were initially listed as pure core in the purity boundary map, but the spec explicitly notes they were "moved from pure core; deterministic but uses platform crypto — Shell unit: verified via integration paths". Their presence in the shell is correct per the spec.

### Effectful Shell — declared
File: `packages/auth-service/src/shell/index.ts`

All I/O, crypto, DB, and HTTP calls must live here.

| Symbol | Declared Side Effect |
|--------|---------------------|
| `stateHash` | `crypto.createHash` |
| `oauthSessionHash` | `crypto.createHash` |
| `linkSessionTokenHash` | `crypto.createHash` |
| `generateSecureRandomToken` | `crypto.randomBytes` |
| `saveOAuthState` | DB INSERT (in-memory store in Green phase) |
| `consumeOAuthState` | DB SELECT + UPDATE (in-memory store) |
| `saveDiscordLinkSession` | DB INSERT (in-memory store) |
| `exchangeDiscordCode` | HTTP POST to Discord |
| `fetchDiscordUserId` | HTTP GET to Discord |
| `structuredLog` | Write to log sink |
| `handleAuthRequest` | Orchestrates all shell I/O |
| `checkHealth` | Calls injectable health check function |

---

## Observed Boundaries

Verified by reading actual implementation files.

### `packages/auth-service/src/core/index.ts` — observed

Imports present:
```typescript
import type { OAuthStateRecord, LinkSessionRecord, ValidationResult, CookieName, CookieAttributes } from '@hayane/shared';
```

- No `import` from `node:crypto`, `node:fs`, `node:http`, or any runtime I/O module.
- No `fetch`, `axios`, `pg`, or database client imports.
- All 14 declared pure symbols are implemented as stateless, deterministic functions.
- `maskSensitiveLogFields` uses only a `RegExp` literal and plain object iteration — no I/O.
- `isSameOrigin` uses `new URL()` — a pure, deterministic WHATWG URL parser (no I/O).
- `validateFrontendBaseUrl` uses a `RegExp` literal — pure.
- `validateStartupConfig` is an additional composite function (not in the original boundary map) that chains `validateRequiredEnvVars` and `validateFrontendBaseUrl` — pure.

**Result**: Core boundary is clean. No I/O imports detected.

### `packages/auth-service/src/shell/index.ts` — observed

Imports present:
```typescript
import { randomBytes, createHash } from 'node:crypto';
import { maskSensitiveLogFields, validateOAuthStateRecord, validateLinkSessionRecord, getSecurityHeaders, getCorsHeaders, buildCallbackRedirectUrl, buildCookieAttributes, buildDiscordAuthorizationUrl, isSameOrigin, serializeCookieAttributes } from '../core/index.js';
import { getOAuthStore, getLinkSessionStore } from './store.js';
```

- `node:crypto` is imported — consistent with declared shell boundary.
- All pure core functions are imported from `../core/index.js` — no re-implementation in shell.
- `exchangeDiscordCode` and `fetchDiscordUserId` are currently mock implementations (Green phase). They return deterministic mock values and do not perform actual HTTP calls. This is documented in the source with comments indicating replacement in E2E phase.
- `handleAuthRequest` contains inline uses of `randomBytes` and `createHash` directly (not via exported shell functions). This is a minor coupling concern — see Mismatch #1 below.
- `console.log` is called inside `structuredLog` — consistent with declared "Write to log sink" side effect.

---

## Mismatches and Findings

### Mismatch #1: Inline crypto usage inside `handleAuthRequest`

**Observation**: `handleAuthRequest` (both `handleLegacyAuthRequest` and `handleStructuredAuthRequest`) calls `randomBytes` and `createHash` directly rather than delegating to `generateSecureRandomToken`, `stateHash`, and `oauthSessionHash`.

**Example** (line ~231 in shell/index.ts):
```typescript
const stateToken = randomBytes(32).toString('hex');
const sessionToken = randomBytes(32).toString('hex');
const stateHashVal = createHash('sha256').update(stateToken).digest('hex');
```

**Assessment**: This is a structural coupling issue, not a purity violation (crypto is correctly in the shell). However, bypassing the named shell functions reduces testability and creates duplicated crypto logic. The `generateSecureRandomToken` function already exists and uses identical logic.

**Severity**: Low — not a purity boundary violation. Refactoring to use named shell functions would improve cohesion but does not block Phase 6.

**Recommended action**: In a future refactor sprint, replace inline `randomBytes`/`createHash` calls inside `handleAuthRequest` with calls to `generateSecureRandomToken`, `stateHash`, and `oauthSessionHash`.

### Mismatch #2: `validateStartupConfig` not in original boundary map

**Observation**: `validateStartupConfig` exists in `core/index.ts` but is not listed in the purity boundary map in `verification-architecture.md`. It was added during implementation (referenced in FIND-005 comment).

**Assessment**: The function is pure (no I/O, deterministic). Its presence in core is correct. The boundary map is simply incomplete — not a violation.

**Severity**: Informational only. No action required for Phase 6.

### No Drift Detected in Core Boundary

All 14 declared pure symbols are implemented correctly in core with no I/O imports. The purity boundary between core and shell is maintained.

---

## Summary

| Dimension | Result |
|-----------|--------|
| Core I/O imports | None detected — CLEAN |
| Shell I/O scope | Consistent with declaration — CLEAN |
| Core → Shell dependency | Shell imports from Core correctly — CLEAN |
| Core re-implementing shell logic | None detected — CLEAN |
| Undeclared side effects in core | None detected — CLEAN |
| Inline crypto in handleAuthRequest | Present — Low severity, non-blocking |
| validateStartupConfig missing from map | Informational only — non-blocking |

**Overall purity boundary verdict**: PASS with two non-blocking observations.

No required follow-up actions before Phase 6. The inline crypto coupling (Mismatch #1) is recommended for cleanup in a post-MVP refactor sprint.
