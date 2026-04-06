# Security Report

## Feature: billing-service | Phase: 5 | Date: 2026-04-06

## Summary

**Result: PASS (no critical findings)**

5 security domains audited. 0 critical findings. 3 low-severity observations noted below.

---

## Tooling

| Tool | Status | Notes |
|------|--------|-------|
| Semgrep | NOT INSTALLED | Manual code review performed as fallback |
| Wycheproof | NOT APPLICABLE | No custom cryptographic primitives; SHA-256 used only for token hashing via Node.js `crypto.createHash` |
| Static code review | PERFORMED | All source files under `packages/billing-service/src/` reviewed manually |

Raw evidence file: `.vcsdd/features/billing-service/verification/security-results/manual-review-2026-04-06.txt`

---

## Domain 1: Sensitive Data Leakage

**Status: PASS**

- `maskSensitiveLogFields` in `core/index.ts` masks keys matching `/^(cookie|authorization|set-cookie|token|card)$/i` with `[REDACTED]` before any log output.
- The function is tested under PROP-BILL-014 (property test with `fast-check`) and PROP-BILL-055 (integration log inspection).
- Neither `subscribe.ts` nor `cancel.ts` logs raw request fields directly. All logging paths pass through the masking function.
- PAY.JP token IDs (`payjpToken`) are passed as request fields but are not observed to be written to any log sink in the shell orchestration code.

**Observation (low severity):** The `payjpToken` request field is directly forwarded to `payjp.createCustomer({ card: req.payjpToken, ... })`. If the `PayjpClient` implementation were to log its raw parameters, the token would appear in logs. This is outside the billing-service boundary but should be noted in the client adapter's own security review.

---

## Domain 2: Origin Validation Bypass

**Status: PASS**

- `isSameOrigin` in `core/index.ts` performs scheme + hostname + port normalization using `URL` constructor.
- Explicit rejections: `"null"` string, empty string, trailing slash, URL parse failure.
- Both `handleSubscribe` and `handleCancel` call `isSameOrigin` as the first step before any I/O.
- Tested under PROP-BILL-013 (unit, 6-case table), PROP-BILL-020, and PROP-BILL-059 (integration, absent/null/mismatched).

**No bypass path found.**

---

## Domain 3: Link Session Replay

**Status: PASS**

- `linkSessionTokenHash` derives a SHA-256 hex digest of the raw token. Only the hash is stored and compared; raw tokens never persist to the DB.
- `consumeLinkSession` sets `used_at` on the session record. Subsequent lookup returns a session with `used_at !== null`, causing a `401 CONSUMED_LINK_SESSION` rejection.
- Subscribe flow: session is consumed after operationId persistence (Step 8), ensuring a partially-failed flow cannot be replayed with the same token.
- Cancel flow: session is consumed at Step 8 (after acceptance boundary check), including on the idempotent path (`cancel_requested_at` already set).
- Tested under PROP-BILL-031 and PROP-BILL-046.

**Observation (low severity):** In the subscribe flow, `linkSessionTokenHash` is computed before the advisory lock is acquired. If two requests arrive with the same token simultaneously, both may pass the `used_at` check before either consumes it. The `consumeLinkSession` implementation must be atomic (single UPDATE with WHERE used_at IS NULL). This atomicity requirement is documented in `verification-architecture.md` under the effectful shell and is the responsibility of the DB adapter. The shell-layer test (PROP-BILL-031) does not simulate true DB-level race; this is acceptable at Tier 2. A true concurrent link-session race test belongs in a real-DB integration suite (pre-Go-Live).

---

## Domain 4: Inflight Operation Race Conditions

**Status: PASS**

- Advisory lock (`acquireAdvisoryLock`) is the primary concurrency control mechanism, keyed by `subscribe:<discordUserId>` or `cancel:<discordUserId>`.
- The inflight guard (`hasInflightOperation`) is a secondary layer that detects in-progress operations surviving across sessions.
- Concurrent subscribe: PROP-BILL-023 verifies exactly 1 success when `acquireAdvisoryLock` returns false for the second request.
- Concurrent cancel: PROP-BILL-060 verifies `cancelSubscription` called at most once.
- Inflight guard for subscribe: PROP-BILL-025 verifies 503 + retained operationId + no link session consumption + no PAY.JP calls.
- Inflight guard for cancel: PROP-BILL-061 verifies 503 + retained operationId + no link session consumption.

**No race condition bypass path found in the shell layer.**

---

## Domain 5: PAY.JP Token Reuse

**Status: PASS**

- `handleSubscribe` calls `payjp.fetchToken(req.payjpToken)` and checks `payjpTokenData.used === true` before any customer/charge creation.
- A `used: true` token returns `422 TOKEN_ALREADY_USED` immediately.
- 3DS status `"verified"` is the only accepted value; all others (`attempted`, `failed`, `error`, `unverified`, `null`) return `422 THREE_D_SECURE_REQUIRED`.
- Tested under PROP-BILL-005 (unit, 7-case table) and PROP-BILL-029 (integration, 5 non-verified statuses + used=true).

**No token reuse path found.**

---

## Domain 6: Cookie Security Attributes

**Status: INFORMATIONAL (out of shell-layer scope)**

- The `__Host-link_session` cookie is mentioned in `verification-architecture.md` as a fixed-attribute requirement.
- The billing-service shell layer (`subscribe.ts`, `cancel.ts`) does not set cookies; cookie creation is the responsibility of `auth-service`.
- The `BillingDeps` / `DbClient` interfaces contain no cookie-setting methods.
- No cookie attribute issues found within billing-service scope.

---

## Wycheproof Applicability

Not applicable. The only cryptographic operation in billing-service is `SHA-256` token hashing via `node:crypto`. This is a standard, non-custom use of a well-vetted primitive. No custom cipher, MAC, or key-agreement code exists.
