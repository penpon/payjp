# sync-service Security Report

**Phase**: 5 (Formal Hardening)
**Date**: 2026-04-06

## Security Controls Verified

### 1. Webhook Token Verification (REQ-SYNC-001)
- **Status**: PASS
- Constant-time comparison via `crypto.timingSafeEqual` with length-independent padding
- Buffer padding prevents length-based timing side channel
- Empty token → reject
- Token absent → reject

### 2. Fail-Close Response Boundary (REQ-SYNC-013)
- **Status**: PASS
- `200` for all processed/ignored/failed (prevents PAY.JP resend amplification)
- `401` only for token mismatch
- `503` only for DB unavailability
- No other status codes exposed

### 3. Log Security (REQ-SYNC-015)
- **Status**: PASS
- No raw header/body stored in logs
- Token mismatch log contains only event type (not full payload)
- Sensitive field masking: card, token, authorization, cookie, set-cookie
- Card information never logged

### 4. SQL Injection Prevention (FIND-017 fix)
- **Status**: PASS
- `updateMemberFromWebhook` uses column whitelist
- Only allowed columns: subscription_status, payjp_plan_id, access_end_at, next_billing_at, last_payjp_event_created_at, payjp_subscription_id
- Unknown keys silently dropped

### 5. Concurrent Webhook Serialization (REQ-SYNC-029)
- **Status**: PASS (structural)
- `pg_advisory_xact_lock(hashtext(discord_user_id))` acquired before member resolution
- Full semantic verification requires real PostgreSQL

### 6. Inflight Operation Protection (REQ-SYNC-025)
- **Status**: PASS
- Daily resync does NOT clear inflight_operation_*
- Only CLI with confirmed integrity may clear
- Verified via INT-SYNC-012

### 7. Event ID Collision Prevention
- **Status**: PASS
- Fallback event IDs use `crypto.randomUUID()` (not `Date.now()`)
- `ON CONFLICT (id) DO NOTHING` prevents duplicates

## Residual Risks

1. Full advisory lock testing requires real PostgreSQL (mock DB cannot verify lock semantics)
2. Discord retry logic (0s/1s/2s delays) is delegated to `syncRole` dependency — timing guarantees depend on caller implementation
