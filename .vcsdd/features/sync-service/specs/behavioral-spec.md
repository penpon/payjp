# sync-service Behavioral Specification

**Feature**: sync-service (R6–R8: Webhook受信・ロール同期・日次再同期・手動CLI)
**Phase**: 1a
**Source**: 2weeks-spec.md §5.3–§5.4, implementation-design-mvp.md §2–§8, tdd-acceptance-matrix-mvp.md T-P0-04–T-P0-07

---

## Purity Boundary Analysis

### Pure Core (deterministic, side-effect-free, formally verifiable)

- `validateWebhookToken(received: string, expected: string): boolean` — constant-time token comparison using `crypto.timingSafeEqual`; both empty → false
- `isAllowedEventType(eventType: string): boolean` — allowlist: `subscription.created/updated/renewed/canceled/deleted/paused/resumed`
- `isSubscriptionDataObject(dataObject: string | null): boolean` — `data.object === "subscription"`
- `isLivemodeMismatch(eventLivemode: boolean, expectedLivemode: boolean): boolean` — mismatch detection
- `validateRequiredFields(event: WebhookEvent): RequiredFieldsResult` — validates `event.id`, `event.type`, `event.created`, `data.id`; conditionally `data.status` for non-created/deleted events
- `isEventDuplicate(eventId: string, existingIds: Set<string>): boolean` — idempotency check
- `isEventStale(eventCreated: number, lastEventCreated: number | null): boolean` — `eventCreated < last` → stale; `eventCreated == last` → NOT stale (processed)
- `isSubscriptionCreatedEvent(eventType: string): boolean` — `subscription.created` check
- `determineIgnoreReason(event: WebhookEvent, expectedLivemode: boolean): string | null` — returns reason string for ignored events, null if processable
- `mapSubscriptionStatus(payjpStatus: string): SubscriptionStatus | null` — maps PAY.JP status to internal; unknown → null
- `shouldGrantRole(status: string | null): boolean` — `active/trial/canceled` → grant; `paused/deleted/null` → revoke
- `shouldSyncRole(oldStatus: string | null, newStatus: string | null): boolean` — status change detection
- `isStatusUnknown(status: string | null): boolean` — not in known statuses → true
- `maskSensitiveLogFields(entry: Record<string, unknown>): Record<string, unknown>` — fixed-key masking (card, token, authorization, cookie, set-cookie)
- `buildTokenMismatchLog(event: unknown, receivedAt: string, remoteIp: string, reason: string): TokenMismatchLog` — 4-key structured log
- `formatRfc3339Utc(date: Date): string` — RFC 3339 UTC string
- `buildCliResult(params: CliResultParams): CliResult` — 1-line JSON with required keys: mode, target, processed_count, succeeded_count, failed_count, started_at, finished_at, duration_ms
- `determineCliExitCode(failedCount: number, cliError: boolean): 0 | 1 | 2` — `0=ok`, `1=cli error`, `2=completed with failures`
- `validateCliArgs(args: string[]): CliArgsResult` — mutual exclusion: `--operation-id` / `--discord-user-id` / `--all`
- `isAccessEndExpired(accessEndAt: Date | null, now: Date): boolean` — `accessEndAt !== null && accessEndAt <= now`
- `calculateLastEventTimestamp(existing: number | null, resyncStartUnix: number): number` — `max(existing ?? 0, resyncStartUnix)`
- `isInflightOperationStale(startedAt: Date | null, now: Date, thresholdMinutes: number): boolean` — stale if > thresholdMinutes
- `canResolveInflightOperation(payjpSubscriptionStatus: string | null, payjpSubscriptionId: string | null, memberPayjpSubscriptionId: string | null, memberPayjpCustomerId: string | null): boolean` — integrity check: subscription status known AND IDs consistent
- `buildChargeSearchParams(customerIdPayjp: string, inflightStartedAtUnix: number): ChargeSearchParams` — `since = startedAt - 3600`, `until = startedAt + 604800`, `limit=100`
- `evaluateChargeSearchResult(matches: number, hasMoreAtLimit: boolean): 'proceed' | 'existing' | 'fail-close'` — 0 → proceed, 1 → existing, 2+ → fail-close, hasMoreAtLimit → fail-close
- `evaluateSubscriptionSearchResult(candidates: SubscriptionCandidate[], discordUserId: string, accessEndAtUnix: number | null): 'single-match' | 'fail-close'` — metadata match or period_end fallback
- `validateWebhookRequiredEnvVars(env: Record<string, string | undefined>): EnvVarValidationResult` — PAYJP_WEBHOOK_TOKEN, DATABASE_URL, DISCORD_BOT_TOKEN, etc.

### Effectful Shell (I/O, DB, network, crypto)

- `findPayjpEvent(db: Pool, eventId: string): Promise<PayjpEventRecord | null>` — idempotency lookup
- `insertPayjpEvent(db: Pool, event: PayjpEventInsert): Promise<void>` — record event with process_status
- `findMemberBySubscriptionId(db: Pool, subscriptionId: string): Promise<Member | null>` — reverse lookup by `payjp_subscription_id`
- `findMemberByDiscordUserId(db: Pool, discordUserId: string): Promise<Member | null>` — lookup
- `findMemberByInflightOperationId(db: Pool, operationId: string): Promise<Member | null>` — operation recovery
- `updateMemberFromWebhook(db: Pool, memberId: string, updates: WebhookMemberUpdate): Promise<void>` — status/plan/dates update
- `updateLastPayjpEventCreated(db: Pool, memberId: string, eventCreated: number): Promise<void>` — timestamp update
- `syncDiscordRole(discordClient: REST, guildId: string, userId: string, roleId: string, action: 'grant' | 'revoke'): Promise<void>` — with retry (max 3: 0s/1s/2s wait, 1s timeout each, ≤6s total)
- `findAllMembers(db: Pool): Promise<Member[]>` — for daily resync
- `findMembersWithInflightOperations(db: Pool): Promise<Member[]>` — for --all verification
- `getPayjpSubscription(payjpClient: Payjp, subscriptionId: string): Promise<PayjpSubscription | null>` — GET, 404 → null
- `listPayjpCharges(payjpClient: Payjp, params: ChargeSearchParams, offset: number): Promise<ChargeListResult>` — paginated search
- `listPayjpSubscriptions(payjpClient: Payjp, customerId: string, offset: number): Promise<SubscriptionListResult>` — paginated search
- `createPayjpCharge(payjpClient: Payjp, params: ChargeParams): Promise<Charge>` — recovery charge
- `createPayjpSubscription(payjpClient: Payjp, params: SubscriptionParams): Promise<Subscription>` — recovery subscription
- `cancelPayjpSubscription(payjpClient: Payjp, subscriptionId: string): Promise<Subscription>` — cancel execution
- `clearInflightOperation(db: Pool, memberId: string): Promise<void>` — clear inflight fields
- `insertMemberImpactLog(db: Pool, log: MemberImpactLogInsert): Promise<void>` — record impact
- `resolveMemberImpactLog(db: Pool, memberId: string, issueCode: string): Promise<void>` — `resolved_at = now()` for same member_id + issue_code
- `countUnresolvedImpactLogs(db: Pool): Promise<number>` — `resolved_at IS NULL` count
- `structuredLog(entry: LogEntry): void` — write to log sink

---

## Requirements

### REQ-SYNC-001: Webhook Token Verification

**EARS**: WHEN `POST /v1/payjp/webhook` is received THE SYSTEM SHALL verify the `X-Payjp-Webhook-Token` header against the configured `PAYJP_WEBHOOK_TOKEN` and reject with `401` if they do not match.

**Acceptance Criteria**:
- Token match → proceed to event processing
- Token mismatch → `401`, NO `payjp_events` record, structured log with 4 keys (`event`, `received_at`, `remote_ip`, `reason`)
- Token absent → `401`

---

### REQ-SYNC-002: Livemode Validation

**EARS**: WHEN a webhook event is received with `livemode` not matching the expected environment value THE SYSTEM SHALL record the event as `ignored` with `ignore_reason` and return `200` without updating `members`.

**Acceptance Criteria**:
- `livemode` mismatch → `process_status=ignored`, `ignore_reason="livemode_mismatch"`, `members` unchanged, `200`

---

### REQ-SYNC-003: Event Type Allowlist

**EARS**: WHEN a webhook event has `event.type` not in the allowlist (`subscription.created`, `subscription.updated`, `subscription.renewed`, `subscription.canceled`, `subscription.deleted`, `subscription.paused`, `subscription.resumed`) THE SYSTEM SHALL record the event as `ignored` with `ignore_reason` and return `200` without updating `members`.

**Acceptance Criteria**:
- Allowed event type → proceed
- Disallowed event type → `ignored` + `200`

---

### REQ-SYNC-004: Data Object Validation

**EARS**: WHEN a webhook event has `data.object` not equal to `"subscription"` THE SYSTEM SHALL record it as `ignored` with `ignore_reason` and return `200` without updating `members`.

---

### REQ-SYNC-005: Required Field Validation

**EARS**: WHEN a webhook event passes token/livemode/allowlist/data.object validation THE SYSTEM SHALL validate minimum required fields (`event.id`, `event.type`, `event.created`, `data.id`; plus `data.status` for non-created/deleted events) and record as `failed` with `200` if any required field is missing or invalid, without updating `members`.

**Acceptance Criteria**:
- All required fields present → proceed
- Any missing → `process_status=failed`, `members` unchanged, `200`

---

### REQ-SYNC-006: Event Idempotency

**EARS**: WHEN a webhook event with `event.id` already exists in `payjp_events` THE SYSTEM SHALL return `200` without reprocessing.

**Acceptance Criteria**:
- Duplicate `event.id` → `200`, no second `members` update

---

### REQ-SYNC-007: Event Ordering (Stale Event Rejection)

**EARS**: WHEN a webhook event has `event.created < members.last_payjp_event_created_at` THE SYSTEM SHALL record as `ignored` and return `200` without updating `members`.

**Same-second rule**: `event.created == last_payjp_event_created_at` → NOT ignored, processed normally.

**Acceptance Criteria**:
- `event.created < last` → `ignored`
- `event.created == last` → processed
- `event.created > last` → processed

---

### REQ-SYNC-008: Subscription Created Event

**EARS**: WHEN a `subscription.created` event passes all validation THE SYSTEM SHALL record as `ignored` (members not updated). WHEN required fields are missing THE SYSTEM SHALL record as `failed`.

**Acceptance Criteria**:
- Valid `subscription.created` → `ignored`, `200`
- Invalid `subscription.created` (missing fields) → `failed`, `200`

---

### REQ-SYNC-009: Member Resolution from Webhook

**EARS**: WHEN processing a webhook event THE SYSTEM SHALL resolve the target member by:
1. `data.metadata.discord_user_id` → lookup by `discord_user_id`
2. `data.id` → reverse lookup by `payjp_subscription_id`

IF both resolve and they do not match the same member → record as `failed`, `members` unchanged.

---

### REQ-SYNC-010: Status Update from Webhook

**EARS**: WHEN a validated webhook event (non-created) resolves to a member THE SYSTEM SHALL update `members.subscription_status` from `data.status`, update `last_payjp_event_created_at`, and trigger role sync only when status changes.

**Plan/date update**: `subscription.updated` with unchanged status SHALL still update `payjp_plan_id` and `next_billing_at`/`access_end_at`, but NOT trigger role sync.

**Succeeded events**: SHALL update `last_payjp_event_created_at` even if status is unchanged.

---

### REQ-SYNC-011: Unknown Status Handling

**EARS**: WHEN a webhook event contains an unrecognized `data.status` THE SYSTEM SHALL record the event as `failed` in `payjp_events` without updating `members`.

**Safe-side revocation**: WHEN the member is resolved (via REQ-SYNC-009) and has an existing granted role THE SYSTEM SHALL revoke it (fail-close safe-side). WHEN the member cannot be resolved, no role action is taken (cannot determine target user).

---

### REQ-SYNC-012: Discord Role Sync with Retry

**EARS**: WHEN role sync is triggered THE SYSTEM SHALL grant role for `active/trial/canceled` status and revoke for `paused/deleted/null/unknown`, with retry on Discord API `429/5xx` (max 3 attempts: 0s/1s/2s wait, 1s timeout each, total ≤6s).

**Acceptance Criteria**:
- `active/trial/canceled` → grant
- `paused/deleted/null` → revoke
- 429/5xx → retry up to 3 times within 6s
- All retries fail → log error, continue (do not block webhook response)

---

### REQ-SYNC-013: Webhook Response Boundary (Fail-Close)

**EARS**: WHEN `POST /v1/payjp/webhook` completes processing THE SYSTEM SHALL return:
- `200` for all processed/ignored/failed events (prevents PAY.JP resend amplification)
- `401` only for token mismatch
- `503` only for DB unavailability

---

### REQ-SYNC-014: Operation ID Preservation in Events

**EARS**: WHEN a webhook event payload contains `data.metadata.operation_id` THE SYSTEM SHALL store it in `payjp_events.data_metadata_operation_id`. WHEN absent, store `NULL`.

---

### REQ-SYNC-015: Webhook Log Security

**EARS**: WHEN the sync-service writes any log entry THE SYSTEM SHALL NOT store raw header/body or card information. Sensitive fields SHALL be masked with fixed-key pattern (card, token, authorization, cookie, set-cookie).

---

### REQ-SYNC-016: Daily Resync Job

**EARS**: THE SYSTEM SHALL run a daily resync job (schedule from `DAILY_RESYNC_CRON`) that:
1. Iterates all members
2. Checks `access_end_at` expiration → revoke role if expired
3. Verifies PAY.JP subscription state → `404` treated as `deleted`
4. Updates `members` status accordingly
5. Does NOT clear `inflight_operation_*` (CLI-only)

---

### REQ-SYNC-017: Manual Resync CLI Arguments

**EARS**: THE SYSTEM SHALL accept exactly one of `--operation-id <id>`, `--discord-user-id <id>`, or `--all` as mutually exclusive arguments.

**Acceptance Criteria**:
- 0 args → exit code 1
- 2+ args → exit code 1
- Invalid arg → exit code 1
- Exactly 1 valid arg → proceed

---

### REQ-SYNC-018: CLI Output Format

**EARS**: THE SYSTEM SHALL output a single JSON line with required keys: `mode`, `target`, `processed_count`, `succeeded_count`, `failed_count`, `started_at` (RFC 3339 UTC), `finished_at` (RFC 3339 UTC), `duration_ms`.

**Exit codes**: `0` = completed with `failed_count=0`, `1` = CLI error, `2` = completed with `failed_count>0`

---

### REQ-SYNC-019: Subscribe Recovery via CLI (--operation-id)

**EARS**: WHEN `--operation-id` is specified for a `subscribe` type inflight operation THE SYSTEM SHALL:
1. Check `members.payjp_customer_id` — if NULL → fail-close (no recovery, record impact, escalate)
2. Check `members.payjp_initial_charge_id` — if present → use as authoritative (skip charge search)
3. If charge ID absent → `GET /v1/charges?customer=...&since=startedAt-3600&until=startedAt+604800&limit=100&offset=0,100,...` until `has_more=false`
   - `offset > 900` with `has_more=true` → fail-close
   - `metadata.operation_id` match count: 0 → create 1 charge; 1 → use existing (save to member); 2+ → fail-close
4. Check subscription existence → create only if absent
5. Update member, sync role, clear inflight only on confirmed integrity
6. Update `last_payjp_event_created_at = max(existing, resyncStartUnix)`

---

### REQ-SYNC-020: Cancel Recovery via CLI

**EARS**: WHEN `--operation-id` is specified for a `cancel` type inflight operation THE SYSTEM SHALL:
1. Check `members.payjp_customer_id` — if NULL → fail-close
2. Check `members.payjp_subscription_id` — if present → use directly
3. If subscription ID absent → search via `GET /v1/customers/:id/subscriptions` with pagination (`limit=100`, `offset<=900`)
   - Filter: `status in (active,trial,canceled,paused)` AND `metadata.discord_user_id == discord_user_id`
   - Fallback (no metadata): 1 candidate + `current_period_end == floor(epoch(access_end_at))` → adopt
   - 0 or 2+ candidates → fail-close
4. Cancel only if not already canceled
5. Clear inflight only on confirmed integrity

---

### REQ-SYNC-021: Resync by Discord User ID

**EARS**: WHEN `--discord-user-id` is specified THE SYSTEM SHALL:
1. Look up the member by `discord_user_id` (not found → exit code 1)
2. If `payjp_subscription_id` exists → `GET /v1/subscriptions/:id` to get current state (404 → `deleted`)
3. Update `members.subscription_status` and related fields from PAY.JP state
4. Sync Discord role based on updated status
5. Resolve matching `member_impact_logs` (same `member_id + issue_code`)
6. Does NOT clear `inflight_operation_*` unless integrity is confirmed via `canResolveInflightOperation`

---

### REQ-SYNC-022: Resync All Members

**EARS**: WHEN `--all` is specified THE SYSTEM SHALL iterate all members, performing the same reconciliation as `--discord-user-id` for each. After completion, verify `members.inflight_operation_id` residual count = 0.

**Output**: `target="all"` in result JSON, all count keys present.

---

### REQ-SYNC-023: Member Impact Log Management

**EARS**: WHEN an inconsistency is detected THE SYSTEM SHALL insert a `member_impact_logs` record. WHEN the inconsistency is resolved via resync THE SYSTEM SHALL update `resolved_at = now()` on the matching `member_id + issue_code` record.

**`failed_count`**: Must equal `member_impact_logs.resolved_at IS NULL` count.

---

### REQ-SYNC-024: Inflight Operation Monitoring Threshold

**EARS**: WHEN the CLI processes a member with `inflight_operation_started_at` older than 30 minutes THE SYSTEM SHALL emit a warning-level structured log indicating monitoring-enhanced status.

WHEN the CLI processes a member with `inflight_operation_started_at` older than 6 hours THE SYSTEM SHALL:
1. Emit an error-level structured log indicating escalation required
2. Record in `member_impact_logs` with `issue_code = "escalation_6h_inflight"`
3. Include in the log: `resolution_possible` (boolean), `assignee` (string, from env or "unassigned"), `detected_at` (RFC 3339 UTC)
4. The member SHALL be counted in `failed_count` if unresolved

---

### REQ-SYNC-025: Daily Resync Does Not Clear Inflight

**EARS**: THE SYSTEM SHALL NOT clear `inflight_operation_*` during daily resync. Only manual CLI may clear inflight operations, and only when integrity is confirmed.

---

### REQ-SYNC-026: Access End Expiration Role Revocation

**EARS**: WHEN `access_end_at` has passed (via webhook or daily resync) THE SYSTEM SHALL revoke the Discord role.

---

### REQ-SYNC-027: Subscription 404 Handling

**EARS**: WHEN PAY.JP `GET /v1/subscriptions/:id` returns `404` during resync THE SYSTEM SHALL treat the subscription as `deleted` and revoke the Discord role.

---

### REQ-SYNC-028: Required Environment Variables

**EARS**: WHEN the sync-service starts THE SYSTEM SHALL validate that all required environment variables (`PAYJP_WEBHOOK_TOKEN`, `PAYJP_SECRET_KEY`, `DATABASE_URL`, `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_PAID_ROLE_ID`, `DAILY_RESYNC_CRON`, `PAYJP_LIVEMODE`) are present and non-empty, and refuse to start if any are missing.

---

### REQ-SYNC-029: Concurrent Webhook Serialization

**EARS**: WHEN multiple webhook events for the same member arrive concurrently THE SYSTEM SHALL serialize member updates using `pg_advisory_xact_lock(hashtext(discord_user_id))` or equivalent per-member locking to prevent race conditions in `members` table updates.

**Note**: The `payjp_events` idempotency check (REQ-SYNC-006) provides a second layer of protection.

---

### REQ-SYNC-030: Daily Resync Individual Member Error Handling

**EARS**: WHEN an individual member's resync fails during daily resync THE SYSTEM SHALL log the error and continue processing remaining members. The failure SHALL be recorded in `member_impact_logs` and included in `failed_count`.

