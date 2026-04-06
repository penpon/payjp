# sync-service Verification Architecture

**Feature**: sync-service (R6–R8: Webhook受信・ロール同期・日次再同期・手動CLI)
**Phase**: 1b
**Mode**: strict
**Source**: behavioral-spec.md, tdd-acceptance-matrix-mvp.md T-P0-04, T-P0-06, T-P0-07

---

## Purity Boundary Map

### Pure Core
Deterministic, side-effect-free functions. No I/O. Fully unit-testable without mocks.

| Symbol | Input | Output | Verifiable Property |
|--------|-------|--------|---------------------|
| `validateWebhookToken(received, expected)` | `string × string` | `boolean` | Constant-time via `crypto.timingSafeEqual`; empty → false |
| `isAllowedEventType(eventType)` | `string` | `boolean` | Exact match in 7-item allowlist |
| `isSubscriptionDataObject(dataObject)` | `string \| null` | `boolean` | Only `"subscription"` → true |
| `isLivemodeMismatch(eventLivemode, expectedLivemode)` | `boolean × boolean` | `boolean` | Strict equality |
| `validateRequiredFields(event)` | `WebhookEvent` | `RequiredFieldsResult` | event.id/type/created/data.id required; data.status for non-created/deleted |
| `isEventDuplicate(eventId, existingIds)` | `string × Set<string>` | `boolean` | Set membership |
| `isEventStale(eventCreated, lastEventCreated)` | `number × number \| null` | `boolean` | `< last` → true; `== last` → false; null → false |
| `isSubscriptionCreatedEvent(eventType)` | `string` | `boolean` | `subscription.created` only |
| `determineIgnoreReason(event, expectedLivemode)` | `WebhookEvent × boolean` | `string \| null` | Ordered: livemode > type > data.object |
| `mapSubscriptionStatus(payjpStatus)` | `string` | `SubscriptionStatus \| null` | Known → mapped; unknown → null |
| `shouldGrantRole(status)` | `string \| null` | `boolean` | active/trial/canceled → true; else → false |
| `shouldSyncRole(oldStatus, newStatus)` | `string \| null × string \| null` | `boolean` | Different → true |
| `isStatusUnknown(status)` | `string \| null` | `boolean` | Not in known set → true |
| `maskSensitiveLogFields(entry)` | `Record<string, unknown>` | `Record<string, unknown>` | Fixed-key pattern masking |
| `buildTokenMismatchLog(event, receivedAt, remoteIp, reason)` | `unknown × string × string × string` | `TokenMismatchLog` | 4 required keys present |
| `formatRfc3339Utc(date)` | `Date` | `string` | ISO 8601 / RFC 3339 with Z suffix |
| `buildCliResult(params)` | `CliResultParams` | `CliResult` | 8 required keys; RFC 3339 UTC dates |
| `determineCliExitCode(failedCount, cliError)` | `number × boolean` | `0 \| 1 \| 2` | cliError → 1; failed > 0 → 2; else → 0 |
| `validateCliArgs(args)` | `string[]` | `CliArgsResult` | Mutual exclusion of 3 modes |
| `isAccessEndExpired(accessEndAt, now)` | `Date \| null × Date` | `boolean` | Non-null + past → true |
| `calculateLastEventTimestamp(existing, resyncStartUnix)` | `number \| null × number` | `number` | max(existing ?? 0, resyncStartUnix) |
| `isInflightOperationStale(startedAt, now, thresholdMinutes)` | `Date \| null × Date × number` | `boolean` | > threshold → true |
| `canResolveInflightOperation(payjpSubStatus, payjpSubId, memberSubId, memberCustId)` | `string \| null × string \| null × string \| null × string \| null` | `boolean` | Status known AND IDs consistent AND customer exists |
| `buildChargeSearchParams(customerId, inflightStartedAtUnix)` | `string × number` | `ChargeSearchParams` | since = -3600, until = +604800, limit=100 |
| `evaluateChargeSearchResult(matches, hasMoreAtLimit)` | `number × boolean` | `string` | 0 → proceed; 1 → existing; 2+ → fail-close; hasMore → fail-close |
| `evaluateSubscriptionSearchResult(candidates, discordUserId, accessEndAtUnix)` | `array × string × number \| null` | `string` | metadata match or period_end fallback; 0/2+ → fail-close |
| `validateWebhookRequiredEnvVars(env)` | `Record<string, string \| undefined>` | `EnvVarValidationResult` | All required vars present |

### Effectful Shell
I/O-dependent functions. Tested via integration tests with real DB and/or mocked external services.

| Symbol | Side Effect | Test Strategy |
|--------|-------------|---------------|
| `findPayjpEvent(db, eventId)` | DB SELECT `payjp_events` | Integration: found/not found |
| `insertPayjpEvent(db, event)` | DB INSERT `payjp_events` | Integration: row created, idempotency constraint |
| `findMemberBySubscriptionId(db, subscriptionId)` | DB SELECT `members` | Integration: reverse lookup |
| `findMemberByDiscordUserId(db, discordUserId)` | DB SELECT `members` | Integration: found/not found |
| `findMemberByInflightOperationId(db, operationId)` | DB SELECT `members` | Integration: operation recovery |
| `updateMemberFromWebhook(db, memberId, updates)` | DB UPDATE `members` | Integration: fields updated |
| `updateLastPayjpEventCreated(db, memberId, eventCreated)` | DB UPDATE `members` | Integration: timestamp advanced |
| `syncDiscordRole(discordClient, guildId, userId, roleId, action)` | HTTP PUT/DELETE Discord role | Integration: retry with 429/5xx injection |
| `findAllMembers(db)` | DB SELECT `members` | Integration: all rows returned |
| `findMembersWithInflightOperations(db)` | DB SELECT `members` | Integration: filtered correctly |
| `getPayjpSubscription(payjpClient, subscriptionId)` | HTTP GET PAY.JP | Integration: 200 + 404 handling |
| `listPayjpCharges(payjpClient, params, offset)` | HTTP GET PAY.JP | Integration: pagination |
| `listPayjpSubscriptions(payjpClient, customerId, offset)` | HTTP GET PAY.JP | Integration: pagination |
| `createPayjpCharge(payjpClient, params)` | HTTP POST PAY.JP | Integration: recovery charge |
| `createPayjpSubscription(payjpClient, params)` | HTTP POST PAY.JP | Integration: recovery subscription |
| `cancelPayjpSubscription(payjpClient, subscriptionId)` | HTTP POST PAY.JP | Integration: cancel execution |
| `clearInflightOperation(db, memberId)` | DB UPDATE `members` | Integration: fields cleared |
| `insertMemberImpactLog(db, log)` | DB INSERT `member_impact_logs` | Integration: row created |
| `resolveMemberImpactLog(db, memberId, issueCode)` | DB UPDATE `member_impact_logs` | Integration: resolved_at set |
| `countUnresolvedImpactLogs(db)` | DB SELECT count | Integration: correct count |
| `structuredLog(entry)` | stdout/stderr | Integration: spy-based verification |

---

## Proof Obligations

### Tier 1: Property-Based Tests (fast-check)

| ID | Target Function | Property | Strategy |
|----|----------------|----------|----------|
| PROP-SYNC-001 | `validateWebhookToken` | Equal strings → true; any diff → false | `fc.string()` pairs |
| PROP-SYNC-002 | `isAllowedEventType` | Exactly 7 allowlisted types return true | `fc.constantFrom(...)` + `fc.string()` |
| PROP-SYNC-003 | `isEventStale` | `created < last` → true; `created == last` → false; `last == null` → false | `fc.integer()` pairs |
| PROP-SYNC-004 | `mapSubscriptionStatus` | Known statuses → non-null; unknown → null | `fc.string()` |
| PROP-SYNC-005 | `shouldGrantRole` | active/trial/canceled → true; others → false | `fc.string()` |
| PROP-SYNC-006 | `validateCliArgs` | Exactly 1 of 3 modes → valid; else → invalid | `fc.array(fc.string())` |
| PROP-SYNC-007 | `determineCliExitCode` | cliError → 1; failed > 0 → 2; else → 0 | `fc.integer()` × `fc.boolean()` |
| PROP-SYNC-008 | `evaluateChargeSearchResult` | 0+noMore → proceed; 1+noMore → existing; 2+ → fail-close; hasMore → fail-close | `fc.integer()` × `fc.boolean()` |
| PROP-SYNC-009 | `isAccessEndExpired` | null → false; future → false; past → true | `fc.date()` pairs |
| PROP-SYNC-010 | `calculateLastEventTimestamp` | Result ≥ both inputs | `fc.integer()` pairs |
| PROP-SYNC-011 | `maskSensitiveLogFields` | Sensitive keys masked; non-sensitive preserved | `fc.dictionary()` |
| PROP-SYNC-012 | `buildChargeSearchParams` | since = input - 3600; until = input + 604800; limit = 100 | `fc.integer()` |
| PROP-SYNC-013 | `validateRequiredFields` | All 4 fields present → ok; any missing → invalid | `fc.record()` |
| PROP-SYNC-014 | `formatRfc3339Utc` | Output matches /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/ | `fc.date()` |
| PROP-SYNC-015 | `determineIgnoreReason` | Priority: livemode > type > data.object | `fc.record()` |
| PROP-SYNC-016 | `canResolveInflightOperation` | null customerID → false; null status → false; mismatched IDs → false; all valid → true | `fc.option(fc.string())` tuples |
| PROP-SYNC-017 | `shouldSyncRole` | same status → false; different → true | `fc.constantFrom(...)` pairs |
| PROP-SYNC-018 | `isStatusUnknown` | known statuses → false; arbitrary string → true | `fc.string()` |
| PROP-SYNC-019 | `evaluateSubscriptionSearchResult` | 0 candidates → fail-close; 1 metadata match → single-match; 2+ → fail-close; null accessEndAt → fail-close | `fc.array()` |
| PROP-SYNC-020 | `isInflightOperationStale` | null startedAt → false; within threshold → false; beyond → true | `fc.date()` × `fc.integer()` |

### Tier 2: Integration Tests (vitest)

| ID | Scenario | Fixtures/Mocks |
|----|----------|----------------|
| INT-SYNC-001 | Webhook happy path: valid event → member update + role sync | DB + Discord mock |
| INT-SYNC-002 | Webhook idempotency: duplicate event.id → no reprocessing | DB |
| INT-SYNC-003 | Webhook stale event: old event.created → ignored | DB |
| INT-SYNC-004 | Webhook same-second event: event.created == last → processed | DB |
| INT-SYNC-005 | Webhook token mismatch → 401 + log 4 keys | Log spy |
| INT-SYNC-006 | Webhook unknown status → failed + role revocation | DB + Discord mock |
| INT-SYNC-007 | Webhook subscription.created → ignored (no member update) | DB |
| INT-SYNC-008 | Webhook member resolution: metadata + subscription_id cross-check | DB |
| INT-SYNC-009 | Webhook subscription.updated status-unchanged: plan/dates updated, no role sync | DB |
| INT-SYNC-010 | Daily resync: access_end_at expired → role revoke | DB + Discord mock |
| INT-SYNC-011 | Daily resync: subscription 404 → deleted treatment | DB + PAY.JP mock |
| INT-SYNC-012 | Daily resync: does NOT clear inflight_operation | DB |
| INT-SYNC-013 | CLI --operation-id subscribe recovery: charge search + create | DB + PAY.JP mock |
| INT-SYNC-014 | CLI --operation-id subscribe recovery: existing charge found | DB + PAY.JP mock |
| INT-SYNC-015 | CLI --operation-id subscribe recovery: 2+ charges → fail-close | DB + PAY.JP mock |
| INT-SYNC-016 | CLI --operation-id subscribe recovery: customer_id NULL → fail-close | DB |
| INT-SYNC-017 | CLI --operation-id cancel recovery: subscription search + cancel | DB + PAY.JP mock |
| INT-SYNC-018 | CLI --operation-id cancel recovery: metadata fallback with period_end | DB + PAY.JP mock |
| INT-SYNC-019 | CLI --discord-user-id: full reconciliation | DB + PAY.JP + Discord mocks |
| INT-SYNC-020 | CLI --all: iterate all + verify 0 inflight residual | DB + PAY.JP + Discord mocks |
| INT-SYNC-021 | CLI mutual exclusion: 0 args / 2 args → exit 1 | CLI args |
| INT-SYNC-022 | CLI output format: JSON 8 keys + exit codes | CLI execution |
| INT-SYNC-023 | CLI last_payjp_event_created_at update after recovery | DB |
| INT-SYNC-024 | member_impact_logs: insert on failure, resolve on recovery | DB |
| INT-SYNC-025 | Discord role retry: 429 → success on retry 2 | Discord mock |
| INT-SYNC-026 | Discord role retry: 3 failures → logged, webhook response not blocked | Discord mock + log spy |
| INT-SYNC-027 | Webhook log security: no raw header/body, masked sensitive fields | Log spy |
| INT-SYNC-028 | Webhook data.metadata.operation_id preservation in payjp_events | DB |
| INT-SYNC-029 | CLI --operation-id subscribe: offset>900 with has_more → fail-close | PAY.JP mock |
| INT-SYNC-030 | CLI --operation-id cancel: metadata absent + period_end mismatch → fail-close | PAY.JP mock |
| INT-SYNC-031 | CLI --operation-id cancel: customer_id NULL → fail-close | DB |
| INT-SYNC-032 | CLI --operation-id cancel: offset>900 pagination limit → fail-close | PAY.JP mock |
| INT-SYNC-033 | Inflight operation monitoring: 30min threshold detection | Time injection |
| INT-SYNC-034 | Inflight operation escalation: 6h threshold triggers escalation log | Time injection |
| INT-SYNC-035 | Env var validation: missing required vars → startup failure | Env mock |
| INT-SYNC-036 | Concurrent webhooks: per-member advisory lock prevents race | DB + concurrent requests |
| INT-SYNC-037 | Daily resync: individual member failure → continue + log | DB + PAY.JP mock (error) |
| INT-SYNC-038 | Webhook subscription.renewed: processes like other status events | DB + Discord mock |
| INT-SYNC-039 | Webhook DB unavailability → 503 response | DB connection error mock |

### Tier 3: Mutation Testing (Stryker)

Target: Pure core functions with ≥90% mutation kill rate.

Priority targets:
- `isEventStale` (same-second boundary)
- `evaluateChargeSearchResult` (fail-close boundaries)
- `validateRequiredFields` (conditional data.status)
- `shouldGrantRole` (status mapping)
- `determineCliExitCode` (exit code boundaries)

---

## Traceability Matrix (REQ → Test)

| Requirement | Property Tests | Integration Tests |
|-------------|---------------|-------------------|
| REQ-SYNC-001 | PROP-SYNC-001 | INT-SYNC-005 |
| REQ-SYNC-002 | PROP-SYNC-015 | INT-SYNC-001 |
| REQ-SYNC-003 | PROP-SYNC-002 | INT-SYNC-001, INT-SYNC-038 |
| REQ-SYNC-004 | — | INT-SYNC-001 |
| REQ-SYNC-005 | PROP-SYNC-013 | INT-SYNC-001, INT-SYNC-007 |
| REQ-SYNC-006 | — | INT-SYNC-002 |
| REQ-SYNC-007 | PROP-SYNC-003 | INT-SYNC-003, INT-SYNC-004 |
| REQ-SYNC-008 | — | INT-SYNC-007 |
| REQ-SYNC-009 | — | INT-SYNC-008 |
| REQ-SYNC-010 | PROP-SYNC-005, PROP-SYNC-017 | INT-SYNC-001, INT-SYNC-009 |
| REQ-SYNC-011 | PROP-SYNC-004, PROP-SYNC-018 | INT-SYNC-006 |
| REQ-SYNC-012 | PROP-SYNC-005 | INT-SYNC-025, INT-SYNC-026 |
| REQ-SYNC-013 | — | INT-SYNC-005, INT-SYNC-001 |
| REQ-SYNC-014 | — | INT-SYNC-028 |
| REQ-SYNC-015 | PROP-SYNC-011 | INT-SYNC-027 |
| REQ-SYNC-016 | PROP-SYNC-009 | INT-SYNC-010, INT-SYNC-011, INT-SYNC-012, INT-SYNC-037 |
| REQ-SYNC-017 | PROP-SYNC-006 | INT-SYNC-021 |
| REQ-SYNC-018 | PROP-SYNC-007, PROP-SYNC-014 | INT-SYNC-022 |
| REQ-SYNC-019 | PROP-SYNC-008, PROP-SYNC-010, PROP-SYNC-012, PROP-SYNC-016 | INT-SYNC-013, INT-SYNC-014, INT-SYNC-015, INT-SYNC-016, INT-SYNC-023, INT-SYNC-029 |
| REQ-SYNC-020 | PROP-SYNC-016, PROP-SYNC-019 | INT-SYNC-017, INT-SYNC-018, INT-SYNC-030, INT-SYNC-031, INT-SYNC-032 |
| REQ-SYNC-021 | — | INT-SYNC-019 |
| REQ-SYNC-022 | — | INT-SYNC-020 |
| REQ-SYNC-023 | — | INT-SYNC-024 |
| REQ-SYNC-024 | PROP-SYNC-020 | INT-SYNC-033, INT-SYNC-034 |
| REQ-SYNC-025 | — | INT-SYNC-012 |
| REQ-SYNC-026 | PROP-SYNC-009 | INT-SYNC-010 |
| REQ-SYNC-027 | — | INT-SYNC-011 |
| REQ-SYNC-028 | — | INT-SYNC-035 |
| REQ-SYNC-029 | — | INT-SYNC-036 |
| REQ-SYNC-030 | — | INT-SYNC-037 |
| REQ-SYNC-013 (DB 503) | — | INT-SYNC-039 |

---

## Sprint Contract (strict mode)

### Sprint 1: Webhook Core + Role Sync + Daily Resync + CLI

**Scope**: REQ-SYNC-001 through REQ-SYNC-030 (all requirements)

**Grading Dimensions** (binary PASS/FAIL per dimension):
| Dimension | Pass Criteria |
|-----------|---------------|
| Spec Fidelity | All 30 REQs have corresponding tests with exact fail-close boundaries |
| Behavioral Completeness | Idempotency, stale rejection, same-second, unknown status, concurrent webhook serialization all covered |
| Safety & Security | Token mismatch → 401 only (constant-time via timingSafeEqual); no raw log; masked fields; inflight preserved; concurrent webhook serialized |
| Purity Compliance | All pure functions tested without mocks; property tests for all boundary conditions |
| Traceability | Each test maps to REQ-SYNC-* via traceability matrix; evidence logs present |

**Overall Pass**: All 5 dimensions PASS
