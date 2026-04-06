# Security Report

## Feature: auth-service | Date: 2026-04-06

---

## Tooling

| Tool | Version | Status | Purpose |
|------|---------|--------|---------|
| npm audit | Node.js built-in | Available, executed | Known CVE detection across dependency tree |
| Semgrep | /usr/local/bin/semgrep | Available, executed | SAST — static pattern matching (213 rules, TypeScript + multilang) |
| Wycheproof | N/A | Not applicable | Cryptographic test vectors — auth-service does not implement custom crypto algorithms |

Raw output files:
- `security-results/npm-audit.txt` — full npm audit JSON output
- `security-results/semgrep-scan.txt` — full Semgrep scan output

---

## Findings

### npm audit

- **Vulnerabilities found**: 0
- **Dependencies scanned**: 107 (prod: 5, dev: 103, optional: 52)
- **Result**: CLEAN PASS

### Semgrep SAST

- **Rules applied**: 213 (166 TypeScript, 47 multilang)
- **Files scanned**: 5
- **Findings**: 0 (0 blocking)
- **Result**: CLEAN PASS

### Manual Security Review — auth-service specific concerns

#### Cookie Security (REQ-AUTH-005)

Reviewed `packages/auth-service/src/core/index.ts` — `buildCookieAttributes` and `serializeCookieAttributes`:
- `__Host-oauth_session` and `__Host-link_session` cookies are constructed with `Secure: true`, `HttpOnly: true`, `SameSite: Lax`, `Path: /`, and explicit absence of `Domain` attribute.
- `serializeCookieAttributes` intentionally omits `Domain` (comment documented in code).
- TypeScript type system enforces `CookieName` as a union literal; no arbitrary cookie names can be passed.
- Verified by PROP-AUTH-006, PROP-AUTH-007 (unit), PROP-AUTH-017, PROP-AUTH-018 (integration).

#### Sensitive Data Handling (REQ-AUTH-010)

Reviewed `maskSensitiveLogFields` in `packages/auth-service/src/core/index.ts`:
- Regex pattern `/^(cookie|authorization|set-cookie|code|token)$/i` masks all case variants.
- `structuredLog` in shell always applies masking before writing to `console.log`.
- Verified by PROP-AUTH-005 (property test, 50 runs) and PROP-AUTH-023 (integration log capture).

#### Cryptographic Token Generation (REQ-AUTH-009)

Reviewed `generateSecureRandomToken` in `packages/auth-service/src/shell/index.ts`:
- Uses `crypto.randomBytes(32)` — 256 bits of entropy, well above the 128-bit requirement.
- Output is hex-encoded (64 characters).
- Hash functions `stateHash`, `oauthSessionHash`, `linkSessionTokenHash` use `SHA-256` via `node:crypto`.
- Verified by PROP-AUTH-029 (length and format assertion, uniqueness across concurrent calls).

#### Origin Validation (REQ-AUTH-008)

Reviewed `isSameOrigin` in `packages/auth-service/src/core/index.ts`:
- Rejects `"null"` string literal (covers null-origin cross-origin requests).
- Rejects trailing-slash origins.
- Normalizes default ports (443 for HTTPS, 80 for HTTP) per RFC 6454.
- Performs case-insensitive hostname comparison.
- Verified by PROP-AUTH-008 (8 unit cases) and PROP-AUTH-015 (integration).

#### Environment Variable Validation (REQ-AUTH-011)

Reviewed `validateRequiredEnvVars` and `validateStartupConfig` in `packages/auth-service/src/core/index.ts`:
- `FRONTEND_BASE_URL` is validated against a regex that rejects trailing slashes and path segments.
- Both functions return typed `ValidationResult`/`EnvVarValidationResult` — no silent failures.

#### Wycheproof Note

Wycheproof cryptographic test vectors are not applicable. The auth-service uses only standard library SHA-256 (`node:crypto`) and `crypto.randomBytes`. No custom cipher, ECDSA, or ECDH implementations are present.

---

## Summary

- **npm audit**: 0 vulnerabilities across 107 dependencies — PASS
- **Semgrep SAST**: 0 findings across 5 files (213 rules) — PASS
- **Manual review**: No security issues identified — PASS
- **Wycheproof**: Not applicable (no custom crypto)
- **Overall security posture**: CLEAN
