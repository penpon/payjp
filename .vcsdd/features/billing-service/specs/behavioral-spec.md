# billing-service Behavioral Specification

**Feature**: billing-service (R2–R5: 購読開始・初回無料・月次課金・退会申請)
**Phase**: 1a
**Source**: 2weeks-spec.md §5–§6.7/§9, implementation-design-mvp.md §2–§5, tdd-acceptance-matrix-mvp.md T-P0-02–T-P0-05

---

## Purity Boundary Analysis

### Pure Core (deterministic, side-effect-free, formally verifiable)
- `validatePlanId(planId: string, allowedPlanIds: string[]): boolean` — plan allowlist check
- `isFirstTimeUser(firstTrialGrantedAt: Date | null): boolean` — `null` → true (eligible for trial)
- `hasActiveSubscription(status: string | null, accessEndAt: Date | null, now: Date): boolean` — `active/trial` or `canceled && accessEndAt > now` → true
- `hasInflightOperation(inflightOperationId: string | null): boolean` — non-null → true
- `isThreeDSecureVerified(threeDSecureStatus: string | null): boolean` — only `"verified"` → true; `attempted/failed/error/unverified/null` → false
- `calculateCancelAcceptanceStart(accessEndAt: Date, jstOffsetMinutes: 540): Date` — JST (UTC+9, fixed offset 540min) 1-month-before same-day 00:00:00; non-existent day rolls to month-end (e.g., 3/31 → 2/28). JST offset is a pure constant parameter, not runtime I/O.
- `isCancelAcceptable(nowJst: Date, acceptanceStartJst: Date): boolean` — `nowJst >= acceptanceStartJst` → true
- `calculateTrialEnd(now: Date): Date` — `now + 3 months` (PAY.JP trial_end timestamp)
- `buildSubscriptionMetadata(discordUserId: string, operationId: string): { discord_user_id: string; operation_id: string }` — metadata object
- `buildSubscriptionResponse(member: Member): SubscriptionResponse` — `{ ok, memberId, subscriptionStatus, planId, trialApplied, accessEndAt }`
- `buildCancelResponse(member: Member): CancelResponse` — `{ ok, memberId, cancelEffectiveAt, roleRemovalAt }`
- `formatRfc3339Utc(date: Date): string` — RFC 3339 UTC string (e.g., `2026-04-03T12:34:56Z`)
- `isSameOrigin(requestOrigin: string, allowedOrigin: string): boolean` — scheme+host+port normalization; `null`/empty → false
- `maskSensitiveLogFields(entry: Record<string, unknown>): Record<string, unknown>` — fixed-key masking (card, token, authorization, cookie, set-cookie)
- `validateFrontendBaseUrl(raw: string): ValidationResult` — origin-only regex; no trailing slash; no path
- `linkSessionTokenHash(token: string): string` — SHA-256 hash of link session token (deterministic, uses platform crypto)
- `validateRequiredEnvVars(env: Record<string, string | undefined>): EnvVarValidationResult` — detects each missing var and fixed-value mismatches
- `validateFixedEnvVars(env: Record<string, string | undefined>): FixedEnvVarValidationResult` — `BILLING_INTERVAL_MONTHS=1`, `INITIAL_FREE_CYCLES=2`, `CANCEL_NOTICE_CYCLES=1`
- `getCorsHeaders(frontendBaseUrl: string): Record<string, string>` — `Access-Control-Allow-Credentials: true` + `Access-Control-Allow-Origin`
- `getCorsPreflight(frontendBaseUrl: string): Record<string, string>` — preflight: `Allow-Methods: POST, OPTIONS` + `Allow-Headers: Content-Type` + credentials + origin
- `shouldGrantRole(status: string | null): boolean` — `active/trial/canceled` → grant; `paused/deleted/null` → revoke
- `determineSubscriptionStatus(isFirstTime: boolean): "trial" | "active"` — first-time → `trial`; non-first → `active`

### Effectful Shell (I/O, DB, network, crypto randomness)
- `generateOperationId(): string` — UUID v4 generation
- `acquireAdvisoryLock(db: Pool, discordUserId: string): Promise<void>` — `pg_advisory_lock(discord_user_id::bigint)` (CR-001: hashtext廃止)
- `findMember(db: Pool, discordUserId: string): Promise<Member | null>` — member lookup
- `createProvisionalMember(db: Pool, discordUserId: string, email: string): Promise<Member>` — provisional row creation
- `saveInflightOperation(db: Pool, memberId: string, operationId: string, type: 'subscribe' | 'cancel'): Promise<void>` — set `inflight_operation_*` fields
- `clearInflightOperation(db: Pool, memberId: string): Promise<void>` — clear `inflight_operation_*` fields
- `consumeLinkSession(db: Pool, tokenHash: string): Promise<LinkSessionRecord | null>` — atomic `UPDATE used_at = now() WHERE used_at IS NULL AND expires_at > now()` + return discord_user_id
- `validateLinkSession(db: Pool, tokenHash: string): Promise<LinkSessionRecord | null>` — read-only validation (no consumption)
- `verifyPayjpToken(payjpClient: Payjp, tokenId: string): Promise<TokenInfo>` — `GET /v1/tokens/:id`
- `createPayjpCustomer(payjpClient: Payjp, email: string, tokenId: string): Promise<Customer>` — `POST /v1/customers`
- `findPayjpCustomer(payjpClient: Payjp, customerId: string): Promise<Customer | null>` — existing customer lookup
- `createPayjpCharge(payjpClient: Payjp, params: ChargeParams): Promise<Charge>` — initial charge
- `createPayjpSubscription(payjpClient: Payjp, params: SubscriptionParams): Promise<Subscription>` — subscription creation
- `cancelPayjpSubscription(payjpClient: Payjp, subscriptionId: string): Promise<Subscription>` — cancel (stop billing, not delete)
- `verifyDiscordMembership(discordClient: REST, guildId: string, userId: string): Promise<boolean>` — guild member check
- `verifyDiscordRoleCapability(discordClient: REST, guildId: string, roleId: string): Promise<boolean>` — Bot Manage Roles + role hierarchy check
- `syncDiscordRole(discordClient: REST, guildId: string, userId: string, roleId: string, action: 'grant' | 'revoke'): Promise<void>` — role add/remove with retry
- `updateMember(db: Pool, memberId: string, updates: Partial<Member>): Promise<void>` — member state update
- `structuredLog(entry: LogEntry): void` — write to log sink

---

## Requirements

### REQ-BILL-001: Origin Validation for Billing Endpoints

**EARS**: WHEN `POST /v1/subscriptions` or `POST /v1/subscriptions/cancel` is received THE SYSTEM SHALL validate the `Origin` header against `FRONTEND_BASE_URL` using normalized scheme+host+port comparison and reject with `403` if they do not match.

**Normalization Rules**:
- Strip trailing slash from both values before comparison
- Compare scheme (case-insensitive), host (case-insensitive), and port (explicit or default per scheme)
- `Origin: null` MUST be rejected with `403`
- `Origin` header absent MUST be rejected with `403`

**Acceptance Criteria**:
- `Origin: <FRONTEND_BASE_URL>` → allowed
- `Origin: <anything else>` → `403`
- `Origin: null` → `403`
- `Origin` absent → `403`

---

### REQ-BILL-002: Link Session Validation and Consumption

**EARS**: WHEN `POST /v1/subscriptions` or `POST /v1/subscriptions/cancel` is received with cookie `__Host-link_session` THE SYSTEM SHALL validate `link_session_token_hash = SHA-256(cookie)` against `discord_link_sessions` (must be unused and not expired) and reject with `401` if invalid.

**Validation Rules**:
- `link_session_token_hash` matches a record in `discord_link_sessions`
- `used_at IS NULL`
- `expires_at > now()`

**Consumption Timing**: Defined per endpoint in REQ-BILL-011 and REQ-BILL-025.

**Edge Cases**:
- `__Host-link_session` cookie absent: `401`
- Token hash not found: `401`
- Token expired: `401`
- Token already consumed: `401`

**Acceptance Criteria**:
- Valid token → proceed
- Any invalid condition → `401`
- Once consumed, subsequent requests with same token → `401`

---

### REQ-BILL-003: Plan ID Allowlist Validation

**EARS**: WHEN `POST /v1/subscriptions` receives a `planId` THE SYSTEM SHALL verify it exists in `PAYJP_PLAN_IDS` allowlist and reject with `422` if not found.

**Acceptance Criteria**:
- `planId` in allowlist → allowed
- `planId` not in allowlist → `422`
- `planId` empty or absent → `422`

---

### REQ-BILL-004: User-Level Advisory Lock

**EARS**: WHEN `POST /v1/subscriptions` or `POST /v1/subscriptions/cancel` begins processing a validated request THE SYSTEM SHALL acquire `pg_advisory_lock(discord_user_id::bigint)` to prevent concurrent operations on the same user. (CR-001: hashtext廃止、Snowflake ID直接使用)

**Acceptance Criteria**:
- Concurrent requests for same `discord_user_id` are serialized
- Lock scope is transaction-level (released on commit/rollback)
- Different `discord_user_id` values can proceed concurrently

---

### REQ-BILL-005: Provisional Member Row Creation

**EARS**: WHEN `POST /v1/subscriptions` processes a request for a `discord_user_id` with no existing `members` row THE SYSTEM SHALL create a provisional row with `discord_user_id` and `email` to persist subscription-in-progress state.

**Acceptance Criteria**:
- No existing row → row created with `discord_user_id + email`, other fields null/default
- Existing row → row reused (no duplicate created)

---

### REQ-BILL-006: Inflight Operation Guard

**EARS**: WHEN `POST /v1/subscriptions` or `POST /v1/subscriptions/cancel` finds `members.inflight_operation_id IS NOT NULL` THE SYSTEM SHALL immediately respond `503` with the existing `operationId` without performing any PAY.JP writes.

**Link Session Behavior**: When inflight operation blocks the request, `__Host-link_session` MUST NOT be consumed.

**Acceptance Criteria**:
- `inflight_operation_id` present → `503` with existing `operationId`
- PAY.JP API call count: 0
- `__Host-link_session` remains unconsumed

---

### REQ-BILL-007: Existing Subscription Guard

**EARS**: WHEN `POST /v1/subscriptions` finds the member has status `active` or `trial`, or status `canceled` with `access_end_at > now()` THE SYSTEM SHALL return the existing subscription result without creating a new subscription.

**Acceptance Criteria**:
- `active` → return existing result (no PAY.JP write)
- `trial` → return existing result (no PAY.JP write)
- `canceled` with `access_end_at > now()` → return existing result
- `canceled` with `access_end_at <= now()` → allow new subscription
- `paused` / `deleted` / `null` → allow new subscription

---

### REQ-BILL-008: Discord Pre-Check

**EARS**: WHEN `POST /v1/subscriptions` is about to initiate PAY.JP writes THE SYSTEM SHALL first verify that (1) `discord_user_id` is a member of `DISCORD_GUILD_ID` and (2) Bot has `Manage Roles` permission and `DISCORD_PAID_ROLE_ID` is below Bot's highest role in hierarchy, and SHALL reject before any payment if either check fails.

**Error Codes**:
- Guild non-member → `409`
- Role capability failure (permission or hierarchy) → `503`

**Acceptance Criteria**:
- Discord non-member → `409`, PAY.JP API calls = 0
- Role permission failure → `503`, PAY.JP API calls = 0
- Both checks pass → proceed to payment

---

### REQ-BILL-009: PAY.JP Token 3DS Verification

**EARS**: WHEN `POST /v1/subscriptions` validates the payment token THE SYSTEM SHALL retrieve the token from PAY.JP API and verify `used = false` AND `card.three_d_secure_status = "verified"`, rejecting with `422` if either condition fails.

**MVP Complete Authentication Policy**: Only `verified` is accepted. `attempted`, `failed`, `error`, `unverified`, and `null` are all rejected.

**Acceptance Criteria**:
- `used=false` AND `three_d_secure_status=verified` → allowed
- `used=true` → `422`
- `three_d_secure_status=attempted` → `422`
- `three_d_secure_status=null` → `422`
- Any other status → `422`

---

### REQ-BILL-010: Operation ID Persistence Before PAY.JP Writes

**EARS**: WHEN `POST /v1/subscriptions` is about to execute PAY.JP writes (customer/charge/subscription creation) THE SYSTEM SHALL generate an `operationId` (UUID v4) and persist `members.inflight_operation_id`, `members.inflight_operation_type = 'subscribe'`, and `members.inflight_operation_started_at` BEFORE any PAY.JP API call.

**Acceptance Criteria**:
- `operationId` saved to DB before first PAY.JP write
- `inflight_operation_type = 'subscribe'`
- `inflight_operation_started_at` is set to current timestamp

---

### REQ-BILL-011: Link Session Consumption Timing — Subscribe

**EARS**: WHEN `POST /v1/subscriptions` passes all pre-payment validations THE SYSTEM SHALL consume the `__Host-link_session` token atomically (`UPDATE used_at = now()`), making it non-reusable regardless of subsequent success or failure.

**Consumption Point**: After operationId persistence (step 7), before PAY.JP token verification (step 9). This follows implementation-design-mvp.md §5.1 step ordering.

**Step Order** (implementation-design-mvp.md §5.1 steps 1–8):
1. Origin / link session validity / planId validation
2. Advisory lock (`pg_advisory_xact_lock`)
3. Provisional member row creation (if needed)
4. Inflight operation guard check
5. Existing subscription guard check
6. Discord pre-check (membership + role capability)
7. operationId persistence (`inflight_operation_*` set)
8. **Link session consumption** ← here

**Acceptance Criteria**:
- Consumption occurs after: Origin validation, link session validation, planId validation, advisory lock, provisional member creation, inflight check, existing subscription check, Discord pre-check, operationId persistence
- Consumption occurs before: PAY.JP token verification, PAY.JP writes (customer/charge/subscription)
- Once consumed, re-sending same cookie → `401`

---

### REQ-BILL-012: PAY.JP Customer Creation with Immediate Persistence

**EARS**: WHEN `POST /v1/subscriptions` creates or reuses a PAY.JP customer THE SYSTEM SHALL immediately persist `members.payjp_customer_id` at the point of confirmation, before proceeding to charge or subscription creation.

**Acceptance Criteria**:
- New customer created → `payjp_customer_id` saved immediately
- Existing customer reused → `payjp_customer_id` already present (no overwrite needed)
- If subsequent charge/subscription fails, `payjp_customer_id` remains saved (recovery key for CLI)

---

### REQ-BILL-013: First-Time User — Charge and Trial Subscription

**EARS**: WHEN `POST /v1/subscriptions` processes a first-time user (`members.first_trial_granted_at IS NULL`) THE SYSTEM SHALL (1) execute a `charge` for one month of the selected plan amount with `metadata.discord_user_id` and `metadata.operation_id`, (2) immediately persist `members.payjp_initial_charge_id` and `members.initial_charge_paid_at`, then (3) create a subscription with `trial_end = now + 3 months` and the same metadata.

**Non-first-time users**: `charge` MUST NOT be executed. Subscription is created without `trial_end`.

**Trial Persistence**: `members.first_trial_granted_at` MUST be set on first-time subscription and MUST NOT be reset on re-subscription after cancellation.

**Acceptance Criteria**:
- First-time: `charge` executed → `payjp_initial_charge_id` saved → subscription with `trial_end` created
- Non-first-time: no `charge`, subscription without `trial_end`
- Re-subscriber (has `first_trial_granted_at`): treated as non-first-time
- `charge` metadata contains `discord_user_id` and `operation_id`
- `subscription` metadata contains `discord_user_id` and `operation_id`

---

### REQ-BILL-014: Subscription Creation and State Persistence

**EARS**: WHEN `POST /v1/subscriptions` creates a PAY.JP subscription THE SYSTEM SHALL immediately persist `members.payjp_subscription_id`, update `members.subscription_status`, `members.payjp_plan_id`, and set `members.access_end_at` and `members.next_billing_at` from `subscription.current_period_end`.

**Subscription Parameters**:
- `plan`: selected `planId`
- `customer`: `members.payjp_customer_id`
- `trial_end`: first-time → `now + 3 months`; non-first → absent
- `metadata.discord_user_id`: required
- `metadata.operation_id`: required

**Acceptance Criteria**:
- `payjp_subscription_id` saved immediately after creation
- `subscription_status` set to `trial` (first-time) or `active` (non-first)
- `access_end_at = subscription.current_period_end`
- `next_billing_at = subscription.current_period_end`
- Subscription `interval` is `month`

---

### REQ-BILL-015: Initial Role Sync After Subscription

**EARS**: WHEN `POST /v1/subscriptions` successfully creates a subscription THE SYSTEM SHALL execute Discord role grant with retry (max 3 attempts: 0s/1s/2s wait, 1s timeout each, total ≤ 6s), and on final success clear `inflight_operation_*`.

**Failure Behavior**: If role sync fails after all retries, respond `503 + operationId` and retain `inflight_operation_*`.

**Acceptance Criteria**:
- Role granted on success → `inflight_operation_*` cleared
- Discord `429`/`5xx` → retry up to 3 times
- Final role sync failure → `503 + operationId`, `inflight_operation_*` retained

---

### REQ-BILL-016: Subscription Response Format

**EARS**: WHEN `POST /v1/subscriptions` succeeds THE SYSTEM SHALL respond with `{ ok: true, memberId: string(uuid), subscriptionStatus: "active"|"trial"|"canceled"|"paused"|"deleted", planId: string, trialApplied: boolean, accessEndAt: string(RFC3339 UTC) }`.

**Acceptance Criteria**:
- `memberId` is UUID string
- `subscriptionStatus` is one of the enum values
- `planId` matches the requested plan
- `trialApplied` is `true` for first-time, `false` for non-first
- `accessEndAt` is RFC 3339 UTC string (e.g., `2026-04-03T12:34:56Z`)
- No Unix timestamps or JST strings in response

---

### REQ-BILL-017: Cancel — Existing Subscription Required

**EARS**: WHEN `POST /v1/subscriptions/cancel` finds no member with `subscription_status` in `active/trial/canceled` THE SYSTEM SHALL respond `409`.

**Acceptance Criteria**:
- `active` / `trial` / `canceled` → proceed
- `paused` / `deleted` / `null` / no member → `409`

---

### REQ-BILL-018: Cancel — access_end_at Required

**EARS**: WHEN `POST /v1/subscriptions/cancel` finds `members.access_end_at IS NULL` THE SYSTEM SHALL respond `409` and require resync CLI to populate the field before retry.

**Acceptance Criteria**:
- `access_end_at` present → proceed
- `access_end_at` null → `409`

---

### REQ-BILL-019: Cancel — payjp_subscription_id Required

**EARS**: WHEN `POST /v1/subscriptions/cancel` finds `members.payjp_subscription_id IS NULL` THE SYSTEM SHALL respond `409` and require resync CLI to populate the field before retry.

**Acceptance Criteria**:
- `payjp_subscription_id` present → proceed
- `payjp_subscription_id` null → `409`

---

### REQ-BILL-020: Cancel Acceptance Boundary

**EARS**: WHEN `POST /v1/subscriptions/cancel` evaluates the cancel acceptance period THE SYSTEM SHALL compute the acceptance start as `access_end_at` minus 1 month (same day, 00:00:00 JST), rolling to month-end if the day doesn't exist, and reject with `409` if the current JST time is before the acceptance start.

**Month-End Rollup Examples**:
- `access_end_at = 2026-03-31` → acceptance start = `2026-02-28 00:00:00 JST` (non-leap) or `2026-02-29` (leap)
- `access_end_at = 2026-05-31` → acceptance start = `2026-04-30 00:00:00 JST`
- `access_end_at = 2026-08-30` → acceptance start = `2026-07-30 00:00:00 JST`

**Acceptance Criteria**:
- `now_jst < acceptance_start` → `409`
- `now_jst >= acceptance_start` → proceed
- Boundary at exactly `acceptance_start` → proceed (inclusive)

---

### REQ-BILL-021: Cancel — Link Session Consumption Timing

**EARS**: WHEN `POST /v1/subscriptions/cancel` passes all pre-cancel validations THE SYSTEM SHALL consume `__Host-link_session` before proceeding to PAY.JP cancel API.

**Step Order** (implementation-design-mvp.md §5.2 steps 1–8):
1. Origin / link session validity validation
2. Advisory lock (`pg_advisory_xact_lock`)
3. Existing subscription check (`active/trial/canceled`)
4. Inflight operation guard check
5. `access_end_at` required check
6. `payjp_subscription_id` required check
7. Cancel acceptance boundary check (JST 1-month-before)
8. **Link session consumption** ← here

**Acceptance Criteria**:
- Consumption occurs after: Origin validation, link session validation, advisory lock, existing subscription check, inflight check, access_end_at check, payjp_subscription_id check, acceptance boundary check
- Consumption occurs before: cancel_requested_at idempotency check, operationId persistence, PAY.JP cancel API call
- Once consumed, re-sending same cookie → `401`

---

### REQ-BILL-022: Cancel Idempotency

**EARS**: WHEN `POST /v1/subscriptions/cancel` finds `members.cancel_requested_at IS NOT NULL` THE SYSTEM SHALL respond `200` without calling PAY.JP cancel API again.

**Note**: The `__Host-link_session` is consumed on this path (consumed at pre-validation pass point).

**Acceptance Criteria**:
- `cancel_requested_at` already set → `200` (idempotent success)
- PAY.JP cancel API call count: 0
- Response includes valid `cancelEffectiveAt` and `roleRemovalAt`

---

### REQ-BILL-023: Cancel — Operation ID Persistence

**EARS**: WHEN `POST /v1/subscriptions/cancel` is about to call PAY.JP cancel API THE SYSTEM SHALL generate an `operationId` and persist `members.inflight_operation_id`, `members.inflight_operation_type = 'cancel'`, and `members.inflight_operation_started_at` BEFORE the API call.

**Acceptance Criteria**:
- `operationId` saved before PAY.JP cancel call
- `inflight_operation_type = 'cancel'`

---

### REQ-BILL-024: Cancel — PAY.JP Execution and State Update

**EARS**: WHEN `POST /v1/subscriptions/cancel` executes THE SYSTEM SHALL call PAY.JP cancel API with `members.payjp_subscription_id`, record `members.cancel_requested_at`, update `members.access_end_at` from PAY.JP response, and clear `inflight_operation_*` on success.

**Role Sync**: Cancel does NOT trigger role revocation. Roles are maintained until `access_end_at`.

**Acceptance Criteria**:
- PAY.JP cancel API called with correct `subscription_id`
- `cancel_requested_at` set to current time
- `access_end_at` updated from PAY.JP response
- `inflight_operation_*` cleared on success
- No Discord role API calls made

---

### REQ-BILL-025: Cancel Response Format

**EARS**: WHEN `POST /v1/subscriptions/cancel` succeeds THE SYSTEM SHALL respond with `{ ok: true, memberId: string(uuid), cancelEffectiveAt: string(RFC3339 UTC), roleRemovalAt: string(RFC3339 UTC) }`.

**Acceptance Criteria**:
- `memberId` is UUID string
- `cancelEffectiveAt` is RFC 3339 UTC string
- `roleRemovalAt` is RFC 3339 UTC string
- No Unix timestamps or JST strings

---

### REQ-BILL-026: Uncertain Failure — 503 + operationId

**EARS**: WHEN any PAY.JP API call during subscription creation or cancellation results in a timeout or indeterminate failure THE SYSTEM SHALL respond `503` with the `operationId`, retain `inflight_operation_*`, and forbid client automatic retry.

**Acceptance Criteria**:
- Response: `503` with `operationId` in body
- `inflight_operation_*` retained in DB
- PAY.JP write NOT retried automatically
- `__Host-link_session` already consumed (re-OAuth required for retry)

---

### REQ-BILL-027: Definite Failure Before PAY.JP Write

**EARS**: WHEN a definite failure occurs before any PAY.JP write (validation failure, Discord pre-check failure) THE SYSTEM SHALL clear `inflight_operation_*` and return the appropriate error code.

**Acceptance Criteria**:
- Validation failure → `inflight_operation_*` cleared (if it was set)
- Appropriate error code returned (`401`/`403`/`409`/`422`)

---

### REQ-BILL-028: Definite Failure After PAY.JP Write

**EARS**: WHEN a definite failure occurs after a PAY.JP write has started THE SYSTEM SHALL re-fetch the current PAY.JP state, reconcile with `members`, and clear `inflight_operation_*` only if reconciliation succeeds. If reconciliation fails, respond `503 + operationId` and retain `inflight_operation_*`.

**Acceptance Criteria**:
- PAY.JP state re-fetched after failure
- Reconciliation success → `members` updated, `inflight_operation_*` cleared
- Reconciliation failure → `503 + operationId`, `inflight_operation_*` retained

---

### REQ-BILL-029: CORS Headers for Billing Endpoints

**EARS**: WHEN `POST /v1/subscriptions` or `POST /v1/subscriptions/cancel` sends a response THE SYSTEM SHALL include `Access-Control-Allow-Credentials: true` and `Access-Control-Allow-Origin: <FRONTEND_BASE_URL>`.

**Acceptance Criteria**:
- `Access-Control-Allow-Credentials: true` present in all responses
- `Access-Control-Allow-Origin` equals `FRONTEND_BASE_URL` exactly
- Responses to OPTIONS preflight also include correct CORS headers

---

### REQ-BILL-030: Structured Logging

**EARS**: WHEN any billing-service endpoint handles a request THE SYSTEM SHALL write structured log entries with required keys and MUST NOT include raw card information, raw `Cookie` header values, raw `Authorization` header values, or raw token values.

**Required Log Keys** (all billing endpoints):
- `timestamp` (ISO 8601)
- `service`: `"billing-service"`
- `endpoint`: request path
- `result`: `"success"` | `"failure"` | `"error"`
- `operationId` (when PAY.JP write is executed or uncertain failure occurs)

**Masking Rules**:
- Keys matching `cookie`, `authorization`, `set-cookie`, `token`, `card` MUST be replaced with `"[REDACTED]"`
- Card number, CVC, expiry MUST NEVER appear in logs
- Masking applied at log serialization layer

**Acceptance Criteria**:
- No log entry contains raw card information
- `operationId` present in PAY.JP write execution logs and uncertain failure logs
- Required keys present in every log entry
- `[REDACTED]` appears in place of sensitive values

---

### REQ-BILL-031: Environment Variable Validation at Startup

**EARS**: WHEN `billing-service` starts THE SYSTEM SHALL validate that all required env vars are present, `FRONTEND_BASE_URL` matches origin-only format, and fixed-value env vars equal their MVP fixed values, and SHALL exit with non-zero code if any validation fails.

**Required Env Vars** (presence check):
- `FRONTEND_BASE_URL`, `DATABASE_URL`, `PAYJP_SECRET_KEY`, `PAYJP_PLAN_IDS`
- `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_PAID_ROLE_ID`
- `BILLING_INTERVAL_MONTHS`, `INITIAL_FREE_CYCLES`, `CANCEL_NOTICE_CYCLES`

**Fixed-Value Env Vars** (2weeks-spec.md §9: MVP固定値以外はエラー終了):
- `BILLING_INTERVAL_MONTHS` MUST equal `"1"`
- `INITIAL_FREE_CYCLES` MUST equal `"2"`
- `CANCEL_NOTICE_CYCLES` MUST equal `"1"`

**Acceptance Criteria**:
- Missing any required env var → process exits non-zero
- `FRONTEND_BASE_URL` with trailing slash or path → process exits non-zero
- `BILLING_INTERVAL_MONTHS != "1"` → process exits non-zero
- `INITIAL_FREE_CYCLES != "2"` → process exits non-zero
- `CANCEL_NOTICE_CYCLES != "1"` → process exits non-zero
- All valid → service starts

---

### REQ-BILL-032: Health Check Endpoint

**EARS**: WHEN `GET /health` is received THE SYSTEM SHALL respond `200` if all dependencies (PostgreSQL) are reachable, and `503` if any dependency is unavailable.

**Acceptance Criteria**:
- DB healthy → `200`
- DB unavailable → `503`
- No authentication required

---

### REQ-BILL-033: Service Boundary

**EARS**: AT ALL TIMES billing-service MUST NOT receive Webhook events, MUST NOT execute daily resync, and MUST NOT write to `payjp_events` or `member_impact_logs` tables.

**Acceptance Criteria**:
- No Webhook endpoint registered in billing-service
- No cron/scheduler registered in billing-service
- `payjp_events` row count unchanged after any billing operation
- `member_impact_logs` row count unchanged after any billing operation (role sync failures are logged structurally, not to `member_impact_logs`)

---

### REQ-BILL-034: PAY.JP API Encoding

**EARS**: WHEN billing-service calls any PAY.JP API THE SYSTEM SHALL use `application/x-www-form-urlencoded` encoding (or the official `payjp` npm SDK which does this internally) and MUST NOT send JSON POST bodies to PAY.JP endpoints.

**Acceptance Criteria**:
- All PAY.JP API calls use form-urlencoded or SDK
- No `Content-Type: application/json` sent to PAY.JP

---

### REQ-BILL-035: PAY.JP Write Auto-Retry Prohibition

**EARS**: WHEN a PAY.JP write API call (customer/charge/subscription creation, subscription cancel) fails THE SYSTEM SHALL NOT automatically retry the call, to avoid duplicate resource creation.

**Acceptance Criteria**:
- customer/charge/subscription creation failures are NOT retried
- cancel API failures are NOT retried
- Recovery is performed only via manual resync CLI (sync-service)

---

## Non-Functional Requirements

### NFR-BILL-001: Atomicity
- Advisory lock acquisition and member state updates MUST occur within a single PostgreSQL transaction
- `pg_advisory_xact_lock` prevents concurrent operations on the same user
- PAY.JP writes are outside the DB transaction (external system) — reconciliation handles failures

### NFR-BILL-002: Performance
- `POST /v1/subscriptions`: p99 < 10000ms (includes PAY.JP + Discord round-trips)
- `POST /v1/subscriptions/cancel`: p99 < 5000ms (includes PAY.JP round-trip)
- `GET /health`: p99 < 100ms

### NFR-BILL-003: Idempotency Guarantees
- Subscription creation: existing active/trial/canceled-with-access guard prevents double creation
- Cancel: `cancel_requested_at` check prevents double PAY.JP cancel call
- Inflight operation guard prevents concurrent operations

### NFR-BILL-004: Service Boundary
- billing-service MUST NOT write to `payjp_events` or `member_impact_logs` tables
- billing-service MUST NOT register Webhook or daily resync endpoints
- billing-service reads `discord_link_sessions` (auth-service creates them)
- billing-service writes to `members` table only
