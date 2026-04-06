# auth-service Behavioral Specification

**Feature**: auth-service (R1: Discord OAuth Lite)
**Phase**: 1a
**Source**: 2weeks-spec.md §6.2 items 2-4, §8, tdd-acceptance-matrix-mvp.md T-P0-01

---

## Purity Boundary Analysis

### Pure Core (deterministic, side-effect-free, formally verifiable)
- `stateHash(rawState: string): string` — SHA-256 hash of state token
- `oauthSessionHash(sessionToken: string): string` — SHA-256 hash of OAuth session cookie value
- `linkSessionTokenHash(token: string): string` — SHA-256 hash of link session token
- `buildDiscordAuthorizationUrl(clientId: string, redirectUri: string, state: string): string` — URL construction with fixed `scope=identify`
- `isExpired(expiresAt: Date, now: Date): boolean` — TTL boundary check
- `isUsed(usedAt: Date | null): boolean` — one-time consumption check
- `validateOAuthStateRecord(record: OAuthStateRecord, sessionHash: string, stateHash: string, now: Date): ValidationResult` — pure state validation logic
- `validateLinkSessionRecord(record: LinkSessionRecord, tokenHash: string, now: Date): ValidationResult` — pure link session validation logic
- `buildCookieAttributes(name: '__Host-oauth_session' | '__Host-link_session', maxAge: number): CookieAttributes` — cookie attribute construction
- `maskSensitiveLogFields(logEntry: Record<string, unknown>): Record<string, unknown>` — fixed-key masking logic
- `isSameOrigin(requestOrigin: string, allowedOrigin: string): boolean` — origin comparison (scheme+host+port normalization)

### Effectful Shell (I/O, DB, network, crypto randomness)
- `generateSecureRandomToken(): Promise<string>` — crypto.randomBytes
- `saveOAuthState(db, record): Promise<void>` — DB INSERT into `oauth_states`
- `consumeOAuthState(db, stateHash, sessionHash): Promise<OAuthStateRecord | null>` — atomic DB UPDATE + SELECT in transaction
- `saveDiscordLinkSession(db, record): Promise<void>` — DB INSERT into `discord_link_sessions`
- `exchangeDiscordCode(code: string, env: DiscordEnv): Promise<string>` — Discord API token exchange
- `fetchDiscordUserId(accessToken: string): Promise<string>` — Discord API `/users/@me`
- `structuredLog(entry: LogEntry): void` — write to log sink

---

## Requirements

### REQ-AUTH-001: OAuth Start — State Generation and Storage

**EARS**: WHEN `GET /v1/auth/discord/start` is received THE SYSTEM SHALL generate a cryptographically random `state` token, compute `state_hash = SHA-256(state)` and `oauth_session_hash = SHA-256(random_session_value)`, persist both hashes to `oauth_states` with `expires_at = now() + 10 minutes`, issue `__Host-oauth_session` cookie with the raw session value, and respond with `302` redirect to the Discord authorization URL.

**Cookie Attributes (exact, immutable)**:
- Name: `__Host-oauth_session`
- Attributes: `Secure; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`
- Domain attribute: MUST be absent
- Value: raw random session token (not hash)

**Discord Authorization URL**:
- `scope` MUST be exactly `identify` (no other scopes allowed)
- `state` query parameter: the raw random state token
- `client_id`: `DISCORD_CLIENT_ID`
- `redirect_uri`: `DISCORD_REDIRECT_URI`
- `response_type`: `code`

**Edge Cases**:
- DB INSERT failure: respond `500`, do NOT issue cookie or redirect
- Env var `DISCORD_CLIENT_ID` / `DISCORD_REDIRECT_URI` missing: reject at startup, not per-request
- `state` token MUST have sufficient entropy (≥ 128 bits / 16 random bytes minimum)
- Concurrent calls: each generates independent state; no uniqueness conflict assumed at generation time (UUID or random hex collision probability negligible)

**Acceptance Criteria**:
- Response status is `302`
- `Location` header points to `https://discord.com/oauth2/authorize` with `scope=identify`
- `Set-Cookie` header contains `__Host-oauth_session` with exact attributes: `Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=600` — Domain attribute absent
- `oauth_states` row is inserted with non-null `state_hash`, `oauth_session_hash`, `expires_at = now+600s`, `used_at = NULL`
- `state` token in Location URL is NOT stored in DB (only its hash is stored)
- No raw header or body appears in logs

---

### REQ-AUTH-002: OAuth Callback — Atomic State Verification and Link Session Issuance

**EARS**: WHEN `GET /v1/auth/discord/callback` is received with query params `code` and `state` and cookie `__Host-oauth_session` THE SYSTEM SHALL atomically verify and consume the state record in a single DB transaction, exchange the code with Discord API to obtain `discord_user_id`, create a one-time `discord_link_sessions` record, issue `__Host-link_session` cookie, respond with `302` redirect to `FRONTEND_BASE_URL`, and set `Cache-Control: no-store` and `Referrer-Policy: no-referrer` response headers.

**Atomic Verification (single transaction, all four conditions required)**:
1. `state_hash = SHA-256(query.state)` matches a record in `oauth_states`
2. `oauth_session_hash = SHA-256(cookie.__Host-oauth_session)` matches the same record
3. `used_at IS NULL` (record has not been consumed)
4. `expires_at > now()` (record is within TTL)

If all conditions pass: UPDATE `used_at = now()` in the same transaction.

**On Verification Failure** (any condition fails, or record not found):
- Respond `401`
- Do NOT call Discord API
- Do NOT issue `__Host-link_session` cookie
- Do NOT redirect

**On Discord API Failure** (after state consumed):
- Respond `500` (or `502` if Discord unreachable)
- State remains consumed (no re-use)

**Link Session Cookie Attributes (exact, immutable)**:
- Name: `__Host-link_session`
- Attributes: `Secure; Path=/; HttpOnly; SameSite=Lax; Max-Age=900`
- Domain attribute: MUST be absent
- Value: raw random link session token (not hash)

**Redirect**:
- `Location`: `FRONTEND_BASE_URL` (no path appended beyond what FRONTEND_BASE_URL defines)
- MUST NOT include OAuth `code`, `state`, link session token, or any authentication token in `Location` query string or fragment

**Required Response Headers**:
- `Cache-Control: no-store`
- `Referrer-Policy: no-referrer`

**Edge Cases**:
- `state` query param absent: `401`
- `__Host-oauth_session` cookie absent: `401`
- `code` query param absent: `401`
- State record not found: `401`
- State expired (`expires_at <= now()`): `401`
- State already used (`used_at IS NOT NULL`): `401`
- `state_hash` matches but `oauth_session_hash` mismatches: `401` (CSRF protection)
- Discord token exchange returns error: `502`
- Discord `/users/@me` returns error or missing `id` field: `502`
- Concurrent duplicate callback requests for same state: second request MUST receive `401` due to atomic `used_at` update

**Acceptance Criteria**:
- All four verification conditions evaluated in one DB transaction
- `401` for each individual failure mode: state mismatch, TTL expired, already used, cookie mismatch
- `Set-Cookie` for `__Host-link_session` with exact attributes: `Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=900` — Domain absent
- `302` to `FRONTEND_BASE_URL` — `Location` value contains no token in query or fragment
- `Cache-Control: no-store` present in response
- `Referrer-Policy: no-referrer` present in response
- `discord_link_sessions` row inserted with `discord_user_id` populated, `used_at = NULL`, `expires_at = now+900s`
- No raw `Authorization`, `Cookie`, or `code` values in structured logs

---

### REQ-AUTH-003: OAuth Callback — Idempotency of State Consumption

**EARS**: WHEN two concurrent requests arrive for `GET /v1/auth/discord/callback` with the same `state` value THE SYSTEM SHALL allow at most one request to succeed, and the second SHALL receive `401` because the atomic transaction ensures `used_at` is set before the second read.

**Acceptance Criteria**:
- DB-level atomicity (SELECT FOR UPDATE or equivalent) prevents double-consumption
- Under concurrent load, exactly one callback succeeds per `state` token

---

### REQ-AUTH-004: Session Check — Link Session Validation

**EARS**: WHEN `GET /v1/auth/discord/session` is received with cookie `__Host-link_session` THE SYSTEM SHALL validate `link_session_token_hash` against `discord_link_sessions` (must be unused and not expired) and respond with `{ linked: boolean }`.

**Validation Rules**:
- `link_session_token_hash = SHA-256(cookie.__Host-link_session)` matches a record
- `used_at IS NULL`
- `expires_at > now()`

**Note**: `GET /v1/auth/discord/session` does NOT consume the link session token. `linked: true` when valid record found; `linked: false` (or `401`) when not found or invalid.

**Required Response Headers**:
- `Cache-Control: no-store`
- `Referrer-Policy: no-referrer`
- `Access-Control-Allow-Credentials: true`
- `Access-Control-Allow-Origin: <FRONTEND_BASE_URL>`

**CORS Policy (strict)**:
- `Access-Control-Allow-Origin` MUST be exactly `FRONTEND_BASE_URL` value (scheme+host+port, no trailing slash)
- `Access-Control-Allow-Credentials: true` MUST be present
- Requests with `Origin` header not matching `FRONTEND_BASE_URL` MUST be rejected with `403`
- Requests with absent `Origin` header: behavior depends on deployment (same-origin browser requests will have no Origin)

**Edge Cases**:
- `__Host-link_session` cookie absent: `401`
- Token hash not found in DB: `401`
- Token expired: `401`
- Token already consumed (`used_at IS NOT NULL`): `401`
- Origin not `FRONTEND_BASE_URL`: `403`

**Acceptance Criteria**:
- Valid, unexpired, unconsumed link session → `200 { linked: true }`
- Any invalid condition → `401`
- Origin mismatch → `403`
- `Cache-Control: no-store` present
- `Referrer-Policy: no-referrer` present
- `Access-Control-Allow-Credentials: true` present
- `Access-Control-Allow-Origin` equals `FRONTEND_BASE_URL` exactly

---

### REQ-AUTH-005: Cookie Security — `__Host-` Prefix Enforcement

**EARS**: WHEN any auth endpoint issues a `Set-Cookie` header THE SYSTEM SHALL use the `__Host-` prefix requiring all of: `Secure` flag, `HttpOnly` flag, `SameSite=Lax`, `Path=/`, no `Domain` attribute, and the specific `Max-Age` for that cookie type.

**Required Attribute Sets**:

| Cookie | Prefix | Secure | HttpOnly | SameSite | Path | Domain | Max-Age |
|--------|--------|--------|----------|----------|------|--------|---------|
| `__Host-oauth_session` | required | yes | yes | Lax | / | absent | 600 |
| `__Host-link_session` | required | yes | yes | Lax | / | absent | 900 |

**Acceptance Criteria**:
- Exact attribute set — no additional or missing attributes for each cookie type
- `Domain` attribute MUST NOT appear in `Set-Cookie` for either cookie
- `Max-Age=600` for `__Host-oauth_session`
- `Max-Age=900` for `__Host-link_session`

---

### REQ-AUTH-006: Token URL Exclusion

**EARS**: WHEN `GET /v1/auth/discord/callback` issues a `302` redirect THE SYSTEM SHALL ensure the `Location` header value contains no OAuth authorization `code`, OAuth `state` value, link session token, or any authentication credential in the query string or URL fragment.

**Acceptance Criteria**:
- `Location` URL query string is empty or contains only non-sensitive routing parameters defined in `FRONTEND_BASE_URL`
- `Location` URL fragment is absent or empty
- Specifically: no `code=`, `state=`, `token=`, `link_session=`, `session=` keys in query or fragment

---

### REQ-AUTH-007: Scope Fixation

**EARS**: WHEN `GET /v1/auth/discord/start` constructs the Discord authorization URL THE SYSTEM SHALL set `scope` to exactly `identify` with no other scopes.

**Acceptance Criteria**:
- Discord authorization URL `scope` parameter equals `identify`
- No additional scopes (e.g., `guilds`, `email`, `guilds.members.read`) present

---

### REQ-AUTH-008: CORS Origin Validation for Cookie-Linked Endpoints

**EARS**: WHEN a request arrives at `GET /v1/auth/discord/session` with an `Origin` header THE SYSTEM SHALL compare `Origin` against `FRONTEND_BASE_URL` using normalized scheme+host+port comparison and reject with `403` if they do not match.

**Normalization Rules**:
- Strip trailing slash from both values before comparison
- Compare scheme (case-insensitive), host (case-insensitive), and port (explicit or default per scheme)
- `Origin: null` MUST be rejected with `403`

**Acceptance Criteria**:
- `Origin: <FRONTEND_BASE_URL>` → allowed
- `Origin: <anything else>` → `403`
- `Origin: null` → `403`
- `FRONTEND_BASE_URL` configured as origin-only (no trailing slash, no path) — startup validation

---

### REQ-AUTH-009: State Generation Compliance with Discord OAuth2 State and Security

**EARS**: WHEN `GET /v1/auth/discord/start` generates a `state` value THE SYSTEM SHALL use a cryptographically secure random source of at least 128 bits entropy, and store only its hash in the database.

**Acceptance Criteria**:
- State generated using `crypto.randomBytes(≥16)` or equivalent
- Raw state NOT stored in database — only `SHA-256(state)` stored
- Raw state transmitted only in the redirect `Location` URL to Discord

---

### REQ-AUTH-010: Structured Logging — No Raw Sensitive Values

**EARS**: WHEN any auth-service endpoint handles a request THE SYSTEM SHALL write structured log entries with required keys and MUST NOT include raw `Cookie` header values, raw `Authorization` header values, raw OAuth `code` values, or raw link session token values.

**Required Log Keys** (all auth endpoints):
- `timestamp` (ISO 8601)
- `service`: `"auth-service"`
- `endpoint`: request path
- `result`: `"success"` | `"failure"` | `"error"`

**Masking Rules**:
- Keys matching `cookie`, `authorization`, `set-cookie`, `code`, `token` MUST be replaced with fixed mask string (e.g., `"[REDACTED]"`)
- Masking applied at log serialization layer — raw values never reach log sink

**Edge Cases**:
- Error stack traces: allowed, but MUST NOT contain raw token values
- Log aggregator forwarding: same masking applies at source

**Acceptance Criteria**:
- No test or production log entry contains the literal value of `__Host-oauth_session`, `__Host-link_session`, OAuth `code`, or Discord `access_token`
- `timestamp`, `service`, `endpoint`, `result` fields present in every log entry
- Fixed mask string (`[REDACTED]`) appears in place of sensitive values

---

### REQ-AUTH-011: Environment Variable Validation at Startup

**EARS**: WHEN `auth-service` starts THE SYSTEM SHALL validate that `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_REDIRECT_URI`, `FRONTEND_BASE_URL`, and `DATABASE_URL` are all present and that `FRONTEND_BASE_URL` matches the origin-only format (`scheme://host[:port]` with no trailing slash and no path beyond host), and SHALL exit with a non-zero code if any validation fails.

**`FRONTEND_BASE_URL` Validation**:
- MUST match regex: `^https?:\/\/[^\/]+$` (origin-only, no trailing slash, no path)

**Acceptance Criteria**:
- Missing any required env var → process exits non-zero before accepting requests
- `FRONTEND_BASE_URL` with trailing slash or path → process exits non-zero
- All valid → service starts and begins accepting requests

---

### REQ-AUTH-012: TTL Boundary — Expired State Rejection

**EARS**: WHEN `GET /v1/auth/discord/callback` processes a state record where `expires_at <= now()` THE SYSTEM SHALL respond with `401` even if `used_at IS NULL`.

**Acceptance Criteria**:
- State created 9m59s ago → valid (within TTL)
- State created 10m01s ago → `401` (expired)
- Boundary at exactly `expires_at == now()` → `401` (boundary is exclusive)

---

### REQ-AUTH-013: TTL Boundary — Expired Link Session Rejection

**EARS**: WHEN `GET /v1/auth/discord/session` processes a link session record where `expires_at <= now()` THE SYSTEM SHALL respond with `401` even if `used_at IS NULL`.

**Acceptance Criteria**:
- Link session created 14m59s ago → `200 { linked: true }`
- Link session created 15m01s ago → `401`
- Boundary at exactly `expires_at == now()` → `401`

---

### REQ-AUTH-014: Response Headers — Cache and Referrer for Sensitive Endpoints

**EARS**: WHEN `GET /v1/auth/discord/callback` or `GET /v1/auth/discord/session` sends a response THE SYSTEM SHALL include `Cache-Control: no-store` and `Referrer-Policy: no-referrer` in every response regardless of success or failure status code.

**Acceptance Criteria**:
- `200`, `302`, `401`, `403`, `500` responses from these endpoints all include both headers
- `GET /v1/auth/discord/start` does NOT require these headers (redirect only)

---

### REQ-AUTH-015: Health Check Endpoint

**EARS**: WHEN `GET /health` is received THE SYSTEM SHALL respond with `200` if all dependencies are reachable, and `503` if any dependency (e.g., PostgreSQL) is unavailable.

**Acceptance Criteria**:
- `GET /health` returns `200` when DB connection is healthy
- `GET /health` returns `503` when DB connection fails
- Response body MAY include a JSON status object (e.g., `{ "status": "ok" }` or `{ "status": "error" }`)
- Endpoint does NOT require authentication or cookies

---

## Non-Functional Requirements

### NFR-AUTH-001: Atomicity
- State verification and consumption MUST occur in a single PostgreSQL transaction
- `SELECT ... FOR UPDATE` or equivalent pessimistic lock required to prevent TOCTOU

### NFR-AUTH-002: Performance
- `GET /v1/auth/discord/start`: p99 < 200ms (DB write + crypto generation)
- `GET /v1/auth/discord/callback`: p99 < 2000ms (includes Discord API round-trip)
- `GET /v1/auth/discord/session`: p99 < 100ms (DB read only)

### NFR-AUTH-003: Hash Computation Stability
- The current design uses SHA-256 hash-based validation (no HMAC cookie signing)
- Hash computation is deterministic and key-free; no `OAUTH_COOKIE_SECRET` is required
- If cookie signing is introduced in a future design change, a Change Request to this spec is required

### NFR-AUTH-004: Service Boundary
- auth-service MUST NOT write to `members`, `payjp_events`, or `member_impact_logs` tables
- auth-service MUST NOT call PAY.JP API
- auth-service MUST NOT call Discord role management API (only `identify` scope OAuth and `/users/@me`)
