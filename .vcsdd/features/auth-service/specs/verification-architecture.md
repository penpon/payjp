# auth-service Verification Architecture

**Feature**: auth-service (R1: Discord OAuth Lite)
**Phase**: 1b
**Mode**: strict
**Source**: behavioral-spec.md, tdd-acceptance-matrix-mvp.md T-P0-01

---

## Purity Boundary Map

### Pure Core
Deterministic, side-effect-free functions. No I/O. Fully unit-testable without mocks.

| Symbol | Input | Output | Verifiable Property |
|--------|-------|--------|---------------------|
| `stateHash(raw)` | `string` | `string` | Deterministic SHA-256; collision-resistant |
| `oauthSessionHash(raw)` | `string` | `string` | Deterministic SHA-256 |
| `linkSessionTokenHash(raw)` | `string` | `string` | Deterministic SHA-256 |
| `buildDiscordAuthorizationUrl(clientId, redirectUri, state)` | `string × string × string` | `URL` | `scope=identify`; no extra scopes; state present |
| `isExpired(expiresAt, now)` | `Date × Date` | `boolean` | `now >= expiresAt` → true; exclusive boundary |
| `isUsed(usedAt)` | `Date \| null` | `boolean` | null → false; non-null → true |
| `validateOAuthStateRecord(record, sessionHash, stateHash, now)` | `OAuthStateRecord × string × string × Date` | `ValidationResult` | All four conditions AND'd; each failure independent |
| `validateLinkSessionRecord(record, tokenHash, now)` | `LinkSessionRecord × string × Date` | `ValidationResult` | TTL + used_at check |
| `buildCookieAttributes(name, maxAge)` | `CookieName × number` | `CookieAttributes` | Exact attribute set per cookie name; Domain absent |
| `maskSensitiveLogFields(entry)` | `Record<string, unknown>` | `Record<string, unknown>` | Fixed-key masking; no sensitive values leak |
| `isSameOrigin(requestOrigin, allowedOrigin)` | `string × string` | `boolean` | scheme+host+port normalization; trailing slash stripped |
| `validateFrontendBaseUrl(raw)` | `string` | `ValidationResult` | Origin-only regex; no trailing slash; no path |

### Effectful Shell
I/O-dependent functions. Tested via integration tests or mocks.

| Symbol | Side Effect | Test Strategy |
|--------|-------------|---------------|
| `generateSecureRandomToken()` | `crypto.randomBytes` | Integration: entropy check, length check |
| `saveOAuthState(db, record)` | DB INSERT `oauth_states` | Integration: row visible after insert |
| `consumeOAuthState(db, stateHash, sessionHash)` | DB SELECT FOR UPDATE + UPDATE `used_at` in txn | Integration: atomic consumption, concurrent race |
| `saveDiscordLinkSession(db, record)` | DB INSERT `discord_link_sessions` | Integration: row visible after insert |
| `exchangeDiscordCode(code, env)` | HTTP POST to Discord token endpoint | Integration with mock Discord server |
| `fetchDiscordUserId(accessToken)` | HTTP GET to Discord `/users/@me` | Integration with mock Discord server |
| `structuredLog(entry)` | Write to log sink | Unit: verify masking applied before sink write |

---

## Proof Obligations

| ID | Description | REQ | Tier | Required | Tool |
|----|-------------|-----|------|----------|------|
| PROP-AUTH-001 | `buildDiscordAuthorizationUrl` always produces URL with `scope=identify` and no other scopes | REQ-AUTH-001, REQ-AUTH-007 | 1 | true | Vitest property test (fast-check) |
| PROP-AUTH-002 | `validateOAuthStateRecord` returns failure for each individual condition failure (state mismatch, session mismatch, expired, used) | REQ-AUTH-002, REQ-AUTH-012 | 1 | true | Vitest unit tests (exhaustive case table) |
| PROP-AUTH-003 | `validateOAuthStateRecord` returns success only when all four conditions hold simultaneously | REQ-AUTH-002 | 1 | true | Vitest property test (fast-check arbitraries) |
| PROP-AUTH-004 | `isExpired` boundary: `expires_at == now` → true (exclusive boundary) | REQ-AUTH-012, REQ-AUTH-013 | 1 | true | Vitest unit test with Date injection |
| PROP-AUTH-005 | `maskSensitiveLogFields` never outputs raw values for keys: `cookie`, `authorization`, `set-cookie`, `code`, `token` | REQ-AUTH-010 | 1 | true | Vitest property test: arbitrary string values for sensitive keys |
| PROP-AUTH-006 | `buildCookieAttributes('__Host-oauth_session', 600)` returns exact attribute set — Domain absent, Max-Age=600 | REQ-AUTH-005 | 1 | true | Vitest unit test |
| PROP-AUTH-007 | `buildCookieAttributes('__Host-link_session', 900)` returns exact attribute set — Domain absent, Max-Age=900 | REQ-AUTH-005 | 1 | true | Vitest unit test |
| PROP-AUTH-008 | `isSameOrigin` rejects `Origin: null` and origins that differ in scheme, host, or port | REQ-AUTH-008 | 1 | true | Vitest unit tests (case table) |
| PROP-AUTH-009 | `validateFrontendBaseUrl` rejects values with trailing slash, path segment, or empty string | REQ-AUTH-011 | 1 | true | Vitest property test |
| PROP-AUTH-010 | `consumeOAuthState` atomically marks state as used; concurrent invocations return success exactly once | REQ-AUTH-003 | 2 | true | Integration test with real PostgreSQL (concurrent requests) |
| PROP-AUTH-011 | `GET /v1/auth/discord/callback` returns `401` for all four individual verification failure modes | REQ-AUTH-002 | 2 | true | Integration test: 4 test cases |
| PROP-AUTH-012 | `GET /v1/auth/discord/callback` `302 Location` contains no token in query string or fragment | REQ-AUTH-006 | 2 | true | Integration test: parse Location URL |
| PROP-AUTH-013 | `GET /v1/auth/discord/callback` response always includes `Cache-Control: no-store` and `Referrer-Policy: no-referrer` | REQ-AUTH-014 | 2 | true | Integration test: success and failure paths |
| PROP-AUTH-014 | `GET /v1/auth/discord/session` response always includes `Cache-Control: no-store` and `Referrer-Policy: no-referrer` | REQ-AUTH-014 | 2 | true | Integration test |
| PROP-AUTH-015 | `GET /v1/auth/discord/session` returns `403` when `Origin` does not match `FRONTEND_BASE_URL` | REQ-AUTH-008 | 2 | true | Integration test: mismatched origin, null origin |
| PROP-AUTH-016 | `GET /v1/auth/discord/session` response includes `Access-Control-Allow-Credentials: true` and `Access-Control-Allow-Origin: <FRONTEND_BASE_URL>` | REQ-AUTH-004 | 2 | true | Integration test |
| PROP-AUTH-017 | `GET /v1/auth/discord/start` `Set-Cookie` for `__Host-oauth_session` matches exact attribute set | REQ-AUTH-005 | 2 | true | Integration test: parse Set-Cookie header |
| PROP-AUTH-018 | `GET /v1/auth/discord/callback` `Set-Cookie` for `__Host-link_session` matches exact attribute set | REQ-AUTH-005 | 2 | true | Integration test: parse Set-Cookie header |
| PROP-AUTH-019 | `GET /v1/auth/discord/start` Discord authorization URL has `scope=identify` | REQ-AUTH-007 | 2 | true | Integration test: parse Location URL |
| PROP-AUTH-020 | auth-service process exits non-zero when any required env var is missing | REQ-AUTH-011 | 2 | true | Integration test: spawn process with missing vars |
| PROP-AUTH-021 | `GET /v1/auth/discord/callback` `401` when `state` TTL expired (mocked clock) | REQ-AUTH-012 | 2 | true | Integration test with injectable clock |
| PROP-AUTH-022 | `GET /v1/auth/discord/session` `401` when link session TTL expired (mocked clock) | REQ-AUTH-013 | 2 | true | Integration test with injectable clock |
| PROP-AUTH-023 | auth-service log entries for any auth endpoint contain no raw Cookie, Authorization, Set-Cookie, code, or token values | REQ-AUTH-010 | 2 | true | Integration test: inspect captured log output |
| PROP-AUTH-024 | auth-service does not write to `members`, `payjp_events`, or `member_impact_logs` tables under any auth flow | NFR-AUTH-004 | 2 | true | Integration test: table row counts invariant |
| PROP-AUTH-025 | `FRONTEND_BASE_URL` with trailing slash causes startup failure | REQ-AUTH-011 | 3 | true | Manual validation in staging environment |
| PROP-AUTH-026 | Cookie connectivity verified in browser: `__Host-` cookies set and sent on same eTLD+1 | NFR-AUTH-003 | 3 | false | Manual / E2E smoke test |
| PROP-AUTH-027 | `validateLinkSessionRecord` returns failure for each individual condition failure (token hash mismatch, expired, already used) — exhaustive case table | REQ-AUTH-004, REQ-AUTH-013 | 1 | true | Vitest unit tests (exhaustive case table) |
| PROP-AUTH-028 | `validateLinkSessionRecord` returns success only when all conditions hold simultaneously | REQ-AUTH-004 | 1 | true | Vitest property test (fast-check arbitraries) |
| PROP-AUTH-029 | `generateSecureRandomToken` returns a token with at least 128 bits of entropy (>= 32 hex chars or >= 16 raw bytes) | REQ-AUTH-009 | 2 | true | Integration test: verify output length |
| PROP-AUTH-030 | `GET /v1/auth/discord/start`, `GET /v1/auth/discord/callback`, `GET /v1/auth/discord/session` meet p99 latency bounds under sustained load | NFR-AUTH-002 | 3 | false | Performance benchmark (k6 or autocannon) |

---

## Verification Strategy

### Tier 0: Type-Level Guarantees (TypeScript compiler)
- All DB record types (`OAuthStateRecord`, `LinkSessionRecord`) defined with non-optional `expires_at: Date`, `used_at: Date | null`
- `CookieName` is a union literal type: `'__Host-oauth_session' | '__Host-link_session'`
- `ValidationResult` is a discriminated union: `{ ok: true } | { ok: false; reason: string }`
- `FRONTEND_BASE_URL` type wrapper prevents raw string assignment without validation
- Compiler enforces that `buildCookieAttributes` returns a typed `CookieAttributes` object with `domain` typed as `never` (absent)

### Tier 1: Unit and Property Tests (Vitest + fast-check)
Covers all pure core functions. No DB, no network.

**Target files**:
- `packages/auth-service/src/core/*.ts` — pure logic
- `packages/auth-service/src/core/__tests__/*.test.ts`

**Property tests (fast-check arbitraries)**:
- `PROP-AUTH-001`: arbitrary `clientId × redirectUri × state` → scope always `identify`
- `PROP-AUTH-003`: arbitrary records with all-valid conditions → always `ok: true`
- `PROP-AUTH-005`: arbitrary string values for sensitive log keys → always masked
- `PROP-AUTH-009`: arbitrary strings with trailing slash or path → always rejected
- `PROP-AUTH-028`: arbitrary records with all-valid link session conditions → always `ok: true`

**Unit case tables**:
- `PROP-AUTH-002`: 4 rows × 4 conditions (each fail individually)
- `PROP-AUTH-004`: 3 Date pairs at boundary ±1s
- `PROP-AUTH-006`, `PROP-AUTH-007`: exact header string comparison
- `PROP-AUTH-008`: 6 origin pairs covering scheme, host, port, null, case variants
- `PROP-AUTH-027`: 3 rows × 3 conditions (token hash mismatch, expired, already used — each fail individually)

### Tier 2: Integration Tests (Vitest + testcontainers PostgreSQL + mock Discord HTTP server)
Covers effectful shell. Requires real DB and HTTP mocks.

**Target files**:
- `packages/auth-service/src/__tests__/integration/*.test.ts`

**Fixtures**:
- PostgreSQL testcontainer with schema from `packages/shared/src/schema.sql`
- Mock HTTP server simulating Discord token endpoint and `/users/@me`
- Injectable clock (`Date.now` override) for TTL boundary tests
- Log capture utility to intercept structured log output

**Critical integration test scenarios (all PROP-AUTH-010 through PROP-AUTH-024, PROP-AUTH-029)**:
- Full OAuth flow happy path: `start → callback → session`
- Callback `401` matrix: 4 cases (state mismatch, session mismatch, expired, already used)
- Concurrent callback race: 2 simultaneous requests with same state → exactly 1 success
- Cookie attribute exact match: parse `Set-Cookie` header for both cookie types
- Location URL inspection: no token in query/fragment
- Response header presence: `Cache-Control`, `Referrer-Policy`, CORS headers
- Log capture: sensitive values absent from log output
- DB invariant: `members` table row count unchanged after any auth operation

### Tier 3: Manual and Operational Verification
Covers browser behavior, production configuration, eTLD+1 cookie scoping, and performance benchmarks.

**Checklist (pre-Go-Live)**:
- `PROP-AUTH-025`: staging deploy with intentionally malformed `FRONTEND_BASE_URL` → process exits
- `PROP-AUTH-026`: browser flow on `https://<frontend>` and `https://<api>` sharing same eTLD+1 — `__Host-` cookies set and forwarded
- `PROP-AUTH-030`: performance benchmark confirming p99 latency bounds per NFR-AUTH-002
- Confirm `DISCORD_REDIRECT_URI` matches Discord developer portal registered URI
- Confirm no `Domain` attribute visible in browser DevTools cookie inspector

---

## Traceability Matrix

| REQ | PROP obligations | T-P0-01 check |
|-----|-----------------|---------------|
| REQ-AUTH-001 | PROP-AUTH-001, PROP-AUTH-006, PROP-AUTH-017, PROP-AUTH-019 | scope=identify; Set-Cookie attributes |
| REQ-AUTH-002 | PROP-AUTH-002, PROP-AUTH-003, PROP-AUTH-011, PROP-AUTH-013, PROP-AUTH-018 | 401 matrix; Cache-Control; Referrer-Policy; callback Location no-token |
| REQ-AUTH-003 | PROP-AUTH-010 | atomic consumption |
| REQ-AUTH-004 | PROP-AUTH-014, PROP-AUTH-015, PROP-AUTH-016 | session CORS; Cache-Control; Access-Control-Allow-Credentials |
| REQ-AUTH-005 | PROP-AUTH-006, PROP-AUTH-007, PROP-AUTH-017, PROP-AUTH-018 | Set-Cookie exact attributes |
| REQ-AUTH-006 | PROP-AUTH-012 | Location no-token |
| REQ-AUTH-007 | PROP-AUTH-001, PROP-AUTH-019 | scope=identify |
| REQ-AUTH-008 | PROP-AUTH-008, PROP-AUTH-015, PROP-AUTH-016 | Origin validation; 403 |
| REQ-AUTH-009 | PROP-AUTH-029 | state entropy |
| REQ-AUTH-010 | PROP-AUTH-005, PROP-AUTH-023 | log masking |
| REQ-AUTH-011 | PROP-AUTH-009, PROP-AUTH-020, PROP-AUTH-025 | startup validation |
| REQ-AUTH-012 | PROP-AUTH-004, PROP-AUTH-021 | TTL boundary |
| REQ-AUTH-013 | PROP-AUTH-004, PROP-AUTH-022, PROP-AUTH-027 | TTL boundary |
| REQ-AUTH-014 | PROP-AUTH-013, PROP-AUTH-014 | response headers |
| REQ-AUTH-015 | (integration test: health check endpoint) | health check |
| NFR-AUTH-001 | PROP-AUTH-010 | atomicity |
| NFR-AUTH-002 | PROP-AUTH-030 | performance bounds |
| NFR-AUTH-003 | PROP-AUTH-026 | hash-based validation; no cookie signing |
| NFR-AUTH-004 | PROP-AUTH-024 | service boundary |
