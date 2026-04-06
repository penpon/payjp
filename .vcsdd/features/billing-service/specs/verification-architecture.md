# billing-service Verification Architecture

**Feature**: billing-service (R2–R5: 購読開始・初回無料・月次課金・退会申請)
**Phase**: 1b
**Mode**: strict
**Source**: behavioral-spec.md, tdd-acceptance-matrix-mvp.md T-P0-02–T-P0-05

---

## Purity Boundary Map

### Pure Core
Deterministic, side-effect-free functions. No I/O. Fully unit-testable without mocks.

| Symbol | Input | Output | Verifiable Property |
|--------|-------|--------|---------------------|
| `validatePlanId(planId, allowedPlanIds)` | `string × string[]` | `boolean` | Exact match in allowlist; empty/absent → false |
| `isFirstTimeUser(firstTrialGrantedAt)` | `Date \| null` | `boolean` | null → true; non-null → false |
| `hasActiveSubscription(status, accessEndAt, now)` | `string \| null × Date \| null × Date` | `boolean` | active/trial → true; canceled+future → true; else → false |
| `hasInflightOperation(inflightOperationId)` | `string \| null` | `boolean` | non-null → true |
| `isThreeDSecureVerified(status)` | `string \| null` | `boolean` | only "verified" → true |
| `calculateCancelAcceptanceStart(accessEndAt)` | `Date` | `Date` | JST 1-month-before; month-end rollup |
| `isCancelAcceptable(nowJst, acceptanceStartJst)` | `Date × Date` | `boolean` | nowJst >= acceptanceStartJst → true (inclusive) |
| `calculateTrialEnd(now)` | `Date` | `Date` | now + 3 months |
| `buildSubscriptionMetadata(discordUserId, operationId)` | `string × string` | `Record<string, string>` | Both keys present with exact values |
| `buildSubscriptionResponse(member)` | `Member` | `SubscriptionResponse` | All required fields; RFC 3339 UTC dates |
| `buildCancelResponse(member)` | `Member` | `CancelResponse` | All required fields; RFC 3339 UTC dates |
| `formatRfc3339Utc(date)` | `Date` | `string` | ISO 8601 / RFC 3339 with Z suffix |
| `isSameOrigin(requestOrigin, allowedOrigin)` | `string × string` | `boolean` | scheme+host+port normalization; null → false |
| `maskSensitiveLogFields(entry)` | `Record<string, unknown>` | `Record<string, unknown>` | card/token/cookie/authorization keys masked |
| `validateFrontendBaseUrl(raw)` | `string` | `ValidationResult` | Origin-only; no trailing slash |
| `linkSessionTokenHash(token)` | `string` | `string` | Deterministic SHA-256 |
| `validateRequiredEnvVars(env)` | `Record<string, string \| undefined>` | `EnvVarValidationResult` | Each missing var detected individually |
| `validateFixedEnvVars(env)` | `Record<string, string \| undefined>` | `FixedEnvVarValidationResult` | BILLING_INTERVAL_MONTHS=1, INITIAL_FREE_CYCLES=2, CANCEL_NOTICE_CYCLES=1 |
| `getCorsHeaders(frontendBaseUrl)` | `string` | `Record<string, string>` | Allow-Credentials + Allow-Origin |
| `getCorsPreflight(frontendBaseUrl)` | `string` | `Record<string, string>` | preflight Allow-Methods/Headers + credentials + origin |
| `shouldGrantRole(status)` | `string \| null` | `boolean` | active/trial/canceled → true; else → false |
| `determineSubscriptionStatus(isFirstTime)` | `boolean` | `string` | true → "trial"; false → "active" |

### Effectful Shell
I/O-dependent functions. Tested via integration tests with real DB and/or mocked external services.

| Symbol | Side Effect | Test Strategy |
|--------|-------------|---------------|
| `generateOperationId()` | `crypto.randomUUID` | Integration: UUID format check |
| `acquireAdvisoryLock(db, discordUserId)` | `pg_advisory_lock(discord_user_id::bigint)` | Integration: concurrent race test |
| `findMember(db, discordUserId)` | DB SELECT `members` | Integration: row found/not found |
| `createProvisionalMember(db, discordUserId, email)` | DB INSERT `members` | Integration: row created with expected fields |
| `saveInflightOperation(db, memberId, operationId, type)` | DB UPDATE `members.inflight_operation_*` | Integration: fields set correctly |
| `clearInflightOperation(db, memberId)` | DB UPDATE `members.inflight_operation_* = NULL` | Integration: fields cleared |
| `consumeLinkSession(db, tokenHash)` | DB UPDATE `discord_link_sessions.used_at` in txn | Integration: atomic consumption; concurrent race |
| `verifyPayjpToken(payjpClient, tokenId)` | HTTP GET PAY.JP `/v1/tokens/:id` | Integration with mock PAY.JP server |
| `createPayjpCustomer(payjpClient, email, tokenId)` | HTTP POST PAY.JP `/v1/customers` | Integration with mock PAY.JP server |
| `createPayjpCharge(payjpClient, params)` | HTTP POST PAY.JP `/v1/charges` | Integration with mock PAY.JP server |
| `createPayjpSubscription(payjpClient, params)` | HTTP POST PAY.JP `/v1/subscriptions` | Integration with mock PAY.JP server |
| `cancelPayjpSubscription(payjpClient, subscriptionId)` | HTTP POST PAY.JP cancel | Integration with mock PAY.JP server |
| `verifyDiscordMembership(discordClient, guildId, userId)` | HTTP GET Discord guild member | Integration with mock Discord server |
| `verifyDiscordRoleCapability(discordClient, guildId, roleId)` | HTTP GET Discord guild roles | Integration with mock Discord server |
| `syncDiscordRole(discordClient, guildId, userId, roleId, action)` | HTTP PUT/DELETE Discord role | Integration: retry behavior with 429/5xx injection |
| `updateMember(db, memberId, updates)` | DB UPDATE `members` | Integration: fields updated correctly |
| `structuredLog(entry)` | Write to log sink | Unit: verify masking applied |

---

## Proof Obligations

### Tier 1: Unit and Property Tests (Vitest + fast-check)

| ID | Description | REQ | Required | Tool |
|----|-------------|-----|----------|------|
| PROP-BILL-001 | `validatePlanId` returns true only for exact allowlist members; empty/absent → false | REQ-BILL-003 | true | Vitest unit tests (exhaustive + property) |
| PROP-BILL-002 | `isFirstTimeUser` returns true only when `firstTrialGrantedAt` is null | REQ-BILL-013 | true | Vitest unit test |
| PROP-BILL-003 | `hasActiveSubscription` returns true for active/trial, canceled+future accessEndAt; false otherwise | REQ-BILL-007 | true | Vitest unit tests (case table) |
| PROP-BILL-004 | `hasInflightOperation` returns true only when inflightOperationId is non-null | REQ-BILL-006 | true | Vitest unit test |
| PROP-BILL-005 | `isThreeDSecureVerified` returns true only for `"verified"`; rejects `attempted/failed/error/unverified/null` | REQ-BILL-009 | true | Vitest unit tests (exhaustive case table) |
| PROP-BILL-006 | `calculateCancelAcceptanceStart` correctly computes JST 1-month-before with month-end rollup | REQ-BILL-020 | true | Vitest unit tests (boundary cases: 3/31→2/28, 5/31→4/30, leap year) |
| PROP-BILL-007 | `isCancelAcceptable` returns true when `nowJst >= acceptanceStartJst` (inclusive boundary) | REQ-BILL-020 | true | Vitest unit tests (boundary ±1s) |
| PROP-BILL-008 | `calculateTrialEnd` returns exactly `now + 3 months` | REQ-BILL-013 | true | Vitest unit test |
| PROP-BILL-009 | `buildSubscriptionMetadata` always includes both `discord_user_id` and `operation_id` keys with exact values | REQ-BILL-013, REQ-BILL-014 | true | Vitest property test (fast-check) |
| PROP-BILL-010 | `buildSubscriptionResponse` produces valid response with all required keys; `accessEndAt` is RFC 3339 UTC | REQ-BILL-016 | true | Vitest property test |
| PROP-BILL-011 | `buildCancelResponse` produces valid response with all required keys; dates are RFC 3339 UTC | REQ-BILL-025 | true | Vitest property test |
| PROP-BILL-012 | `formatRfc3339Utc` produces ISO 8601 strings with Z suffix for any Date input | REQ-BILL-016, REQ-BILL-025 | true | Vitest property test (fast-check arbitrary dates) |
| PROP-BILL-013 | `isSameOrigin` rejects `Origin: null`, absent origin, and scheme/host/port mismatches | REQ-BILL-001 | true | Vitest unit tests (case table) |
| PROP-BILL-014 | `maskSensitiveLogFields` never outputs raw values for keys: card, token, cookie, authorization, set-cookie | REQ-BILL-030 | true | Vitest property test (fast-check) |
| PROP-BILL-015 | `validateFrontendBaseUrl` rejects trailing slash, path segment, empty string | REQ-BILL-031 | true | Vitest property test |
| PROP-BILL-016 | `validateRequiredEnvVars` detects each individually missing required env var | REQ-BILL-031 | true | Vitest unit test |
| PROP-BILL-017 | `getCorsHeaders` returns `Access-Control-Allow-Credentials: true` and `Access-Control-Allow-Origin: <frontendBaseUrl>` | REQ-BILL-029 | true | Vitest unit test |
| PROP-BILL-018 | `shouldGrantRole` returns true for active/trial/canceled; false for paused/deleted/null | REQ-BILL-015 | true | Vitest unit tests (exhaustive) |
| PROP-BILL-019 | `determineSubscriptionStatus` returns "trial" for first-time, "active" for non-first | REQ-BILL-014 | true | Vitest unit test |

### Tier 2: Integration Tests (Vitest + testcontainers PostgreSQL + mock PAY.JP/Discord HTTP servers)

| ID | Description | REQ | Required | Tool |
|----|-------------|-----|----------|------|
| PROP-BILL-020 | `POST /v1/subscriptions` rejects with `403` when `Origin` is absent, null, or mismatched | REQ-BILL-001 | true | Integration test |
| PROP-BILL-021 | `POST /v1/subscriptions` rejects with `401` for invalid/expired/consumed link session | REQ-BILL-002 | true | Integration test |
| PROP-BILL-022 | `POST /v1/subscriptions` rejects with `422` for planId not in allowlist | REQ-BILL-003 | true | Integration test |
| PROP-BILL-023 | Concurrent `POST /v1/subscriptions` for same user: exactly one succeeds, no duplicate charge/subscription | REQ-BILL-004, T-P0-03 | true | Integration test (concurrent requests) |
| PROP-BILL-024 | `POST /v1/subscriptions` creates provisional member row when none exists | REQ-BILL-005 | true | Integration test |
| PROP-BILL-025 | `POST /v1/subscriptions` returns `503 + existing operationId` when `inflight_operation_id` present; link session NOT consumed; PAY.JP calls = 0 | REQ-BILL-006 | true | Integration test |
| PROP-BILL-026 | `POST /v1/subscriptions` returns existing result when active/trial/canceled+future subscription exists | REQ-BILL-007 | true | Integration test (3 cases) |
| PROP-BILL-027 | `POST /v1/subscriptions` rejects with `409` when Discord guild non-member; PAY.JP calls = 0 | REQ-BILL-008 | true | Integration test |
| PROP-BILL-028 | `POST /v1/subscriptions` rejects with `503` when Bot cannot manage role; PAY.JP calls = 0 | REQ-BILL-008 | true | Integration test |
| PROP-BILL-029 | `POST /v1/subscriptions` rejects with `422` for non-verified 3DS status (attempted, null, etc.) | REQ-BILL-009 | true | Integration test (case table) |
| PROP-BILL-030 | `operationId` is persisted to DB before first PAY.JP write | REQ-BILL-010 | true | Integration test: DB state inspection between steps |
| PROP-BILL-031 | `__Host-link_session` consumed after pre-validations pass but before PAY.JP writes; re-send → 401 | REQ-BILL-011 | true | Integration test |
| PROP-BILL-032 | `members.payjp_customer_id` persisted immediately after customer creation, survives subsequent failure | REQ-BILL-012 | true | Integration test with injected post-customer failure |
| PROP-BILL-033 | First-time user: charge executed → `payjp_initial_charge_id` saved → subscription with `trial_end` created | REQ-BILL-013 | true | Integration test |
| PROP-BILL-034 | Non-first-time user: no charge executed, subscription without `trial_end` | REQ-BILL-013 | true | Integration test |
| PROP-BILL-035 | Re-subscriber (`first_trial_granted_at` set) treated as non-first-time | REQ-BILL-013 | true | Integration test |
| PROP-BILL-036 | charge and subscription metadata contain `discord_user_id` and `operation_id` | REQ-BILL-013, REQ-BILL-014 | true | Integration test: inspect PAY.JP request payloads |
| PROP-BILL-037 | `members.payjp_subscription_id` persisted immediately; subscription_status, access_end_at, next_billing_at, payjp_plan_id updated | REQ-BILL-014 | true | Integration test |
| PROP-BILL-038 | Subscription interval is `month` | REQ-BILL-014 | true | Integration test: inspect PAY.JP request |
| PROP-BILL-039 | Initial role sync retries up to 3 times on Discord 429/5xx (0s/1s/2s wait, 1s timeout) | REQ-BILL-015 | true | Integration test with mock Discord 429/5xx injection |
| PROP-BILL-040 | Role sync final failure → `503 + operationId`, `inflight_operation_*` retained | REQ-BILL-015 | true | Integration test |
| PROP-BILL-041 | Subscription success response matches exact schema with RFC 3339 UTC dates | REQ-BILL-016 | true | Integration test: JSON schema validation |
| PROP-BILL-042 | `POST /v1/subscriptions/cancel` returns `409` for no existing subscription | REQ-BILL-017 | true | Integration test |
| PROP-BILL-043 | `POST /v1/subscriptions/cancel` returns `409` when `access_end_at IS NULL` | REQ-BILL-018 | true | Integration test |
| PROP-BILL-044 | `POST /v1/subscriptions/cancel` returns `409` when `payjp_subscription_id IS NULL` | REQ-BILL-019 | true | Integration test |
| PROP-BILL-045 | Cancel boundary: `now_jst < acceptance_start` → `409`; `now_jst == acceptance_start` → proceed | REQ-BILL-020 | true | Integration test with injectable clock |
| PROP-BILL-046 | Cancel link session consumed after pre-cancel validations; re-send → 401 | REQ-BILL-021 | true | Integration test |
| PROP-BILL-047 | Cancel with `cancel_requested_at` already set → `200`, PAY.JP cancel calls = 0 | REQ-BILL-022 | true | Integration test |
| PROP-BILL-048 | Cancel `operationId` persisted before PAY.JP cancel call | REQ-BILL-023 | true | Integration test |
| PROP-BILL-049 | Cancel success: PAY.JP cancel API called, `cancel_requested_at` set, `access_end_at` updated, `inflight_operation_*` cleared, no Discord role calls | REQ-BILL-024 | true | Integration test |
| PROP-BILL-050 | Cancel success response matches exact schema with RFC 3339 UTC dates | REQ-BILL-025 | true | Integration test |
| PROP-BILL-051 | Subscription uncertain failure → `503 + operationId`, `inflight_operation_*` retained | REQ-BILL-026 | true | Integration test with injected timeout |
| PROP-BILL-052 | Definite failure before PAY.JP write → `inflight_operation_*` cleared | REQ-BILL-027 | true | Integration test |
| PROP-BILL-053a | Definite failure after customer creation but before charge → re-fetch customer; reconcile success → clear inflight | REQ-BILL-028 | true | Integration test with injected failure after customer |
| PROP-BILL-053b | Definite failure after charge but before subscription → re-fetch charge; reconcile payjp_initial_charge_id; no duplicate charge | REQ-BILL-028 | true | Integration test with injected failure after charge |
| PROP-BILL-053c | Definite failure after subscription creation but before member update → re-fetch subscription; reconcile → clear inflight | REQ-BILL-028 | true | Integration test with injected failure after subscription |
| PROP-BILL-053d | Definite failure after cancel API but before member update → re-fetch subscription status; reconcile → clear inflight | REQ-BILL-028 | true | Integration test with injected failure after cancel |
| PROP-BILL-053e | Reconciliation failure (PAY.JP API unreachable during re-fetch) → `503 + operationId`, inflight retained | REQ-BILL-028 | true | Integration test with mock PAY.JP down |
| PROP-BILL-054 | CORS headers present in all billing responses (success and error) | REQ-BILL-029 | true | Integration test |
| PROP-BILL-055 | Billing-service log entries contain no raw card info, cookie, authorization, token values; `operationId` present in PAY.JP write/failure logs | REQ-BILL-030 | true | Integration test: log capture inspection |
| PROP-BILL-056 | billing-service process exits non-zero when any required env var is missing | REQ-BILL-031 | true | Integration test: spawn with missing vars |
| PROP-BILL-057 | `GET /health` returns `200` when DB healthy, `503` when unavailable | REQ-BILL-032 | true | Integration test |
| PROP-BILL-058 | billing-service does not write to `payjp_events` or `member_impact_logs` under any flow | REQ-BILL-033 | true | Integration test: table row counts invariant |
| PROP-BILL-059 | `POST /v1/subscriptions/cancel` rejects with `403` when Origin is absent/null/mismatched | REQ-BILL-001 | true | Integration test |
| PROP-BILL-060 | Concurrent `POST /v1/subscriptions/cancel` for same user: PAY.JP cancel API called at most once | REQ-BILL-004 | true | Integration test (concurrent requests) |
| PROP-BILL-061 | `inflight_operation_id` existing during cancel → `503 + existing operationId`, link session NOT consumed | REQ-BILL-006 | true | Integration test |
| PROP-BILL-062 | **Subscribe orchestration ordering**: full 14-step sequence verified via mock call-order recording. Asserts: (1) advisory lock before member lookup, (2) provisional member before inflight check, (3) operationId persistence before link session consumption, (4) link session consumption before PAY.JP token verification, (5) customer_id persistence before charge, (6) charge_id persistence before subscription creation, (7) subscription_id persistence before role sync | REQ-BILL-011, REQ-BILL-010, REQ-BILL-012, REQ-BILL-013, REQ-BILL-014 | true | Integration test: mock server + DB state recording at each step |
| PROP-BILL-063 | **Cancel orchestration ordering**: full 12-step sequence verified. Asserts: (1) advisory lock before member lookup, (2) all pre-cancel checks before link session consumption, (3) link session consumption before cancel_requested_at check, (4) operationId persistence before PAY.JP cancel call | REQ-BILL-021, REQ-BILL-023, REQ-BILL-024 | true | Integration test: mock server + DB state recording |
| PROP-BILL-064 | **Customer reuse path**: existing `payjp_customer_id` present → no new customer creation, proceed to charge/subscription with existing customer | REQ-BILL-012 | true | Integration test |
| PROP-BILL-065 | **PAY.JP API encoding**: all PAY.JP calls use form-urlencoded or SDK; no JSON POST | REQ-BILL-034 | true | Integration test: inspect mock server Content-Type |
| PROP-BILL-066 | **PAY.JP write no-retry**: injected failure on customer/charge/subscription/cancel → exactly 1 call attempt, no retry | REQ-BILL-035 | true | Integration test: mock server call count assertion |
| PROP-BILL-067 | **Fixed env var rejection**: `BILLING_INTERVAL_MONTHS=2` or `INITIAL_FREE_CYCLES=0` or `CANCEL_NOTICE_CYCLES=3` → process exits non-zero | REQ-BILL-031 | true | Integration test: spawn with wrong fixed values |

### Tier 3: Manual and Operational Verification

| ID | Description | REQ | Required | Tool |
|----|-------------|-----|----------|------|
| PROP-BILL-070 | Representative plan E2E: full subscription creation flow with real PAY.JP test mode | T-P0-02 | true | Manual E2E with PAY.JP test keys |
| PROP-BILL-071 | Remaining 2 plans: configuration consistency test (plan exists in PAY.JP, interval=month) | T-P0-02 | true | PAY.JP API verification |
| PROP-BILL-072 | Cancel E2E with real PAY.JP test mode | T-P0-05 | true | Manual E2E |
| PROP-BILL-073 | `FRONTEND_BASE_URL` malformed in staging → process exits | REQ-BILL-031 | true | Manual staging test |
| PROP-BILL-074 | Performance benchmarks: subscription p99 < 10s, cancel p99 < 5s | NFR-BILL-002 | false | k6/autocannon |

---

## Verification Strategy

### Tier 0: Type-Level Guarantees (TypeScript compiler)
- `SubscriptionStatus` is a union literal type: `'active' | 'trial' | 'canceled' | 'paused' | 'deleted'`
- `InflightOperationType` is a union literal type: `'subscribe' | 'cancel'`
- `PlanId` type wrapper for validated plan IDs
- `OperationId` type wrapper for UUID v4 strings
- `Rfc3339Utc` branded string type for formatted dates
- Response types enforce required fields at compile time
- `Member` type requires `discord_user_id: string` (non-optional)
- `CookieName` type: `'__Host-link_session'` for billing endpoints

### Tier 1: Unit and Property Tests (Vitest + fast-check)
Covers all pure core functions. No DB, no network.

**Target files**:
- `packages/billing-service/src/core/*.ts` — pure logic
- `packages/billing-service/src/core/__tests__/*.test.ts`

**Property tests (fast-check arbitraries)**:
- `PROP-BILL-001`: arbitrary strings vs fixed allowlist → only exact matches pass
- `PROP-BILL-009`: arbitrary discordUserId × operationId → both keys always present
- `PROP-BILL-010`: arbitrary member data → response always has required keys + RFC 3339 dates
- `PROP-BILL-011`: arbitrary member data → cancel response always has required keys + RFC 3339 dates
- `PROP-BILL-012`: arbitrary Date objects → always produces Z-suffixed ISO string
- `PROP-BILL-014`: arbitrary string values for sensitive log keys → always masked
- `PROP-BILL-015`: arbitrary strings with trailing slash or path → always rejected

**Unit case tables**:
- `PROP-BILL-003`: 6 rows (active, trial, canceled+future, canceled+past, paused, deleted)
- `PROP-BILL-005`: 7 rows (verified, attempted, failed, error, unverified, null, empty)
- `PROP-BILL-006`: 8+ date pairs (month-end rollup, leap year, standard months, edge cases)
- `PROP-BILL-007`: 3 Date pairs at boundary ±1s (before, exactly at, after acceptance start)
- `PROP-BILL-013`: 6 origin pairs (match, scheme diff, host diff, port diff, null, absent)
- `PROP-BILL-018`: 6 status values (active, trial, canceled, paused, deleted, null)

### Tier 2: Integration Tests (Vitest + testcontainers PostgreSQL + mock HTTP servers)
Covers effectful shell. Requires real DB and HTTP mocks.

**Target files**:
- `packages/billing-service/src/__tests__/integration/*.test.ts`

**Fixtures**:
- PostgreSQL testcontainer with schema from `packages/shared/src/schema.sql`
- Mock HTTP server simulating PAY.JP API (tokens, customers, charges, subscriptions)
- Mock HTTP server simulating Discord API (guild members, roles)
- Injectable clock (`Date.now` override) for cancel boundary tests
- Log capture utility to intercept structured log output
- Injected timeout/failure for uncertain failure scenarios

**Critical integration test scenarios**:
- Full subscribe happy path: first-time (charge + trial subscription + role grant)
- Full subscribe happy path: non-first-time (no charge, standard subscription + role grant)
- Subscribe `401` matrix: link session expired, consumed, absent
- Subscribe `403`: Origin absent, null, mismatched
- Subscribe `422`: planId invalid, 3DS non-verified
- Subscribe `409`: Discord non-member
- Subscribe `503`: inflight operation guard, role capability failure, uncertain PAY.JP failure
- Concurrent subscribe race: 2 simultaneous requests → exactly 1 success, charge=1, subscription=1
- Existing subscription guard: active, trial, canceled+future → return existing
- operationId persistence ordering: DB state inspection between PAY.JP calls
- payjp_customer_id immediate persistence: survives subsequent failure
- payjp_initial_charge_id immediate persistence: survives subsequent failure
- payjp_subscription_id immediate persistence
- Full cancel happy path: acceptance boundary passed, PAY.JP cancel executed
- Cancel `409` matrix: no subscription, access_end_at null, payjp_subscription_id null, before acceptance start
- Cancel idempotency: cancel_requested_at already set → 200, PAY.JP calls = 0
- Concurrent cancel race: 2 simultaneous requests → PAY.JP cancel called at most once
- Uncertain failure: subscription timeout → 503 + operationId
- Uncertain failure: cancel timeout → 503 + operationId
- Definite failure before PAY.JP write → inflight cleared
- Definite failure after PAY.JP write → reconciliation
- Service boundary: payjp_events and member_impact_logs row counts invariant

### Tier 3: Manual and Operational Verification
Covers E2E with real PAY.JP test mode, production configuration, performance.

**Checklist (pre-Go-Live)**:
- `PROP-BILL-070`: Full subscription E2E with representative plan (PAY.JP test mode)
- `PROP-BILL-071`: Remaining plans exist in PAY.JP with `interval=month`
- `PROP-BILL-072`: Full cancel E2E with PAY.JP test mode
- `PROP-BILL-073`: Staging deploy with malformed `FRONTEND_BASE_URL` → process exits
- `PROP-BILL-074`: Performance benchmark confirming p99 bounds per NFR-BILL-002
- Confirm `PAYJP_PLAN_IDS` values match PAY.JP dashboard
- Confirm `DISCORD_PAID_ROLE_ID` is below Bot's highest role in guild hierarchy

---

## Traceability Matrix

| REQ | PROP obligations | TDD check |
|-----|-----------------|-----------|
| REQ-BILL-001 | PROP-BILL-013, PROP-BILL-020, PROP-BILL-059 | T-P0-02, T-P0-05 Origin validation |
| REQ-BILL-002 | PROP-BILL-021, PROP-BILL-031, PROP-BILL-046 | T-P0-02, T-P0-05 link session |
| REQ-BILL-003 | PROP-BILL-001, PROP-BILL-022 | T-P0-02 planId allowlist |
| REQ-BILL-004 | PROP-BILL-023, PROP-BILL-060 | T-P0-03 concurrent guard |
| REQ-BILL-005 | PROP-BILL-024 | T-P0-02 provisional member |
| REQ-BILL-006 | PROP-BILL-004, PROP-BILL-025, PROP-BILL-061 | T-P0-04 inflight guard |
| REQ-BILL-007 | PROP-BILL-003, PROP-BILL-026 | T-P0-03 existing subscription |
| REQ-BILL-008 | PROP-BILL-027, PROP-BILL-028 | T-P0-02 Discord pre-check |
| REQ-BILL-009 | PROP-BILL-005, PROP-BILL-029 | T-P0-02 3DS verification |
| REQ-BILL-010 | PROP-BILL-030 | T-P0-04 operationId before write |
| REQ-BILL-011 | PROP-BILL-031 | T-P0-02 link session consumption |
| REQ-BILL-012 | PROP-BILL-032 | T-P0-02, T-P0-04 customer persistence |
| REQ-BILL-013 | PROP-BILL-002, PROP-BILL-008, PROP-BILL-009, PROP-BILL-033, PROP-BILL-034, PROP-BILL-035, PROP-BILL-036 | T-P0-02 first-time charge + trial |
| REQ-BILL-014 | PROP-BILL-019, PROP-BILL-037, PROP-BILL-038 | T-P0-02 subscription creation |
| REQ-BILL-015 | PROP-BILL-018, PROP-BILL-039, PROP-BILL-040 | T-P0-02 role sync |
| REQ-BILL-016 | PROP-BILL-010, PROP-BILL-012, PROP-BILL-041 | T-P0-02 response format |
| REQ-BILL-017 | PROP-BILL-042 | T-P0-05 existing subscription required |
| REQ-BILL-018 | PROP-BILL-043 | T-P0-05 access_end_at required |
| REQ-BILL-019 | PROP-BILL-044 | T-P0-05 payjp_subscription_id required |
| REQ-BILL-020 | PROP-BILL-006, PROP-BILL-007, PROP-BILL-045 | T-P0-05 cancel boundary |
| REQ-BILL-021 | PROP-BILL-046 | T-P0-05 link session consumption |
| REQ-BILL-022 | PROP-BILL-047 | T-P0-05 cancel idempotency |
| REQ-BILL-023 | PROP-BILL-048 | T-P0-05 cancel operationId |
| REQ-BILL-024 | PROP-BILL-049 | T-P0-05 cancel execution |
| REQ-BILL-025 | PROP-BILL-011, PROP-BILL-050 | T-P0-05 cancel response |
| REQ-BILL-026 | PROP-BILL-051 | T-P0-04, T-P0-05 uncertain failure |
| REQ-BILL-027 | PROP-BILL-052 | T-P0-04 pre-write failure |
| REQ-BILL-028 | PROP-BILL-053a, PROP-BILL-053b, PROP-BILL-053c, PROP-BILL-053d, PROP-BILL-053e | T-P0-04 post-write failure |
| REQ-BILL-029 | PROP-BILL-017, PROP-BILL-054 | T-P0-02, T-P0-05 CORS |
| REQ-BILL-030 | PROP-BILL-014, PROP-BILL-055 | T-P0-02, T-P0-05 logging |
| REQ-BILL-031 | PROP-BILL-015, PROP-BILL-016, PROP-BILL-056 | T-P0-02 env validation |
| REQ-BILL-032 | PROP-BILL-057 | health check |
| REQ-BILL-033 | PROP-BILL-058 | service boundary |
| NFR-BILL-001 | PROP-BILL-023, PROP-BILL-060 | atomicity |
| NFR-BILL-002 | PROP-BILL-074 | performance |
| NFR-BILL-003 | PROP-BILL-025, PROP-BILL-026, PROP-BILL-047 | idempotency |
| REQ-BILL-034 | PROP-BILL-065 | PAY.JP API encoding |
| REQ-BILL-035 | PROP-BILL-066 | PAY.JP write no-retry |
| NFR-BILL-004 | PROP-BILL-058 | service boundary |
