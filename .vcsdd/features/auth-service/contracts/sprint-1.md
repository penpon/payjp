# Sprint 1 Contract — auth-service

**Feature**: auth-service (R1: Discord OAuth Lite)
**Mode**: strict
**Sprint**: 1
**Phase**: 2c (Refactor complete)

---

## Scope

Sprint 1 implements ALL auth-service requirements (REQ-AUTH-001 through REQ-AUTH-015, NFR-AUTH-001 through NFR-AUTH-004). This is a single-sprint feature covering the complete Discord OAuth Lite flow.

## Artifacts

### Source Specifications
| File | Role |
|------|------|
| `specs/behavioral-spec.md` | 15 REQ + 4 NFR in EARS format |
| `specs/verification-architecture.md` | 30 PROP obligations, purity boundary map, traceability matrix |

### Implementation
| File | Role |
|------|------|
| `packages/auth-service/src/core/index.ts` | Pure core: 16 deterministic functions (hash, validation, cookie attributes, masking, RFC 6454 origin check, redirect URL builder, security/CORS headers, env var validation) |
| `packages/auth-service/src/shell/index.ts` | Effectful shell: 8 I/O functions (crypto RNG, in-memory DB ops, mock Discord API, structured log, health check) |
| `packages/auth-service/src/shell/store.ts` | In-memory Map store (Green phase placeholder for PostgreSQL) + getStoreCounts helper |
| `packages/shared/src/types.ts` | Shared types: `CookieName`, `ValidationResult`, `OAuthStateRecord`, `LinkSessionRecord`, `CookieAttributes`, `LogEntry` |
| `packages/shared/src/schema.sql` | PostgreSQL DDL for all 5 tables |

### Tests
| File | Tier | Count |
|------|------|-------|
| `packages/auth-service/src/core/__tests__/pure-core.test.ts` | 1 (unit/property) | 57 tests |
| `packages/auth-service/src/__tests__/integration/auth-flow.test.ts` | 2 (integration) | 37 tests |
| **Total** | | **94 tests** |

### Evidence
| File | Phase | Result |
|------|-------|--------|
| `evidence/sprint-1-red-phase.log` | 2a (Red) | 67 failed (67 total) |
| `evidence/sprint-1-green-phase.log` | 2b/2c (Green+Refactor) | 67 passed (67 total) |
| `evidence/sprint-1-findings-fix.log` | 2c (contract review fixes) | 94 passed (94 total) |

## PROP Coverage

### Tier 1 — Pure Core (15 PROPs, all required: true)
| PROP | REQ | Status |
|------|-----|--------|
| PROP-AUTH-001 | REQ-AUTH-001, REQ-AUTH-007 | tested |
| PROP-AUTH-002 | REQ-AUTH-002, REQ-AUTH-012 | tested |
| PROP-AUTH-003 | REQ-AUTH-002 | tested |
| PROP-AUTH-004 | REQ-AUTH-012, REQ-AUTH-013 | tested |
| PROP-AUTH-005 | REQ-AUTH-010 | tested |
| PROP-AUTH-006 | REQ-AUTH-005 | tested |
| PROP-AUTH-007 | REQ-AUTH-005 | tested |
| PROP-AUTH-008 | REQ-AUTH-008 | tested (RFC 6454: case-insensitive host, default port normalization) |
| PROP-AUTH-009 | REQ-AUTH-011 | tested |
| PROP-AUTH-027 | REQ-AUTH-004, REQ-AUTH-013 | tested |
| PROP-AUTH-028 | REQ-AUTH-004 | tested |
| PROP-AUTH-031 | REQ-AUTH-006 | tested (buildCallbackRedirectUrl: returns FRONTEND_BASE_URL with no path/query/fragment) |
| PROP-AUTH-032 | REQ-AUTH-014 | tested (getSecurityHeaders: Cache-Control/Referrer-Policy) |
| PROP-AUTH-033 | REQ-AUTH-004 | tested (getCorsHeaders: CORS header values) |
| PROP-AUTH-034 | REQ-AUTH-011 | tested (validateRequiredEnvVars: each var missing individually) |

### Tier 2 — Integration (18 PROPs, all required: true)
| PROP | REQ | Status |
|------|-----|--------|
| PROP-AUTH-010 | REQ-AUTH-003, NFR-AUTH-001 | tested |
| PROP-AUTH-011 | REQ-AUTH-002 | tested |
| PROP-AUTH-012 | REQ-AUTH-006 | tested (uses buildCallbackRedirectUrl, not mock literal) |
| PROP-AUTH-013 | REQ-AUTH-014 | tested (via handleAuthRequest; verifies security headers in response) |
| PROP-AUTH-014 | REQ-AUTH-014 | tested (via handleAuthRequest; verifies security headers in response) |
| PROP-AUTH-015 | REQ-AUTH-008 | tested (via handleAuthRequest; returns 403 for mismatched/null origin) |
| PROP-AUTH-016 | REQ-AUTH-004 | tested (via handleAuthRequest; returns CORS headers on success) |
| PROP-AUTH-017 | REQ-AUTH-005 | tested (via handleAuthRequest; Set-Cookie header contains required attributes) |
| PROP-AUTH-018 | REQ-AUTH-005 | tested (via saveDiscordLinkSession; store count verified) |
| PROP-AUTH-019 | REQ-AUTH-007 | tested (via handleAuthRequest; Location URL has scope=identify) |
| PROP-AUTH-020 | REQ-AUTH-011 | tested (calls validateRequiredEnvVars for each missing var) |
| PROP-AUTH-021 | REQ-AUTH-012 | tested |
| PROP-AUTH-022 | REQ-AUTH-013 | tested (uses validateLinkSessionRecord with expired LinkSessionRecord) |
| PROP-AUTH-023 | REQ-AUTH-010 | tested |
| PROP-AUTH-024 | NFR-AUTH-004 | tested (uses getStoreCounts() to verify only auth stores written) |
| PROP-AUTH-029 | REQ-AUTH-009 | tested |
| PROP-AUTH-035 | NFR-AUTH-004 | tested (getStoreCounts: verifies auth-only store writes) |
| PROP-AUTH-036 | REQ-AUTH-015 | tested (checkHealth(isHealthy) returns ok when true, error when false or throws) |

### Tier 3 — Manual/Operational (2 PROPs, deferred to pre-Go-Live)
| PROP | REQ | Required | Status |
|------|-----|----------|--------|
| PROP-AUTH-025 | REQ-AUTH-011 | true | deferred |
| PROP-AUTH-026 | NFR-AUTH-003 | false | deferred |
| PROP-AUTH-030 | NFR-AUTH-002 | false | deferred |

## Grading Dimensions (Adversary Review)

VCSDD標準5次元を使用。

| Dimension | Weight | Pass Threshold | Description |
|-----------|--------|----------------|-------------|
| spec_fidelity | 25% | All REQ-AUTH-001〜015 have corresponding PROP and test | 全REQに対応するPROPとテストが存在する |
| edge_case_coverage | 25% | Every critical edge case in spec has explicit test | boundary値・失敗モード・TTL超過・null origin等が網羅されている |
| implementation_correctness | 25% | No logic errors vs EARS spec | 純粋コアロジックが仕様と一致し、RFC 6454準拠 |
| structural_integrity | 15% | Purity boundary respected; no tautological tests | 純粋コアにI/Oなし、シェルに副作用集約、テストが実装コードを行使する |
| verification_readiness | 10% | PROP numbering correct; tier counts accurate | PROP番号・Tier分類・カウント数が正確 |

**Overall pass threshold**: No critical findings in any dimension. At most 2 major findings total.

## Known Limitations (Sprint 1)

1. Shell functions use in-memory Map store — PostgreSQL integration deferred to HTTP server layer
2. `exchangeDiscordCode` / `fetchDiscordUserId` are mock implementations — real Discord API calls deferred
3. No HTTP server (Fastify) layer — endpoint routing, middleware, and actual cookie handling not yet implemented
4. PROP-AUTH-010 (concurrent atomicity) uses single-threaded Map — true DB-level atomicity requires PostgreSQL `SELECT FOR UPDATE` and cannot be verified with single-threaded in-memory tests
5. Tier 2 integration tests (PROP-AUTH-013〜019) call through `handleAuthRequest` — a minimal shell handler that composes core functions. This satisfies the Tier 2 requirement of calling through a higher-level function rather than calling pure core functions directly.
6. `maskSensitiveLogFields` masks top-level keys only (not nested objects) — this is intentional and consistent with the spec which states "Keys matching..." at the top-level log entry. Nested object masking is out of MVP scope.
7. `checkHealth` (PROP-AUTH-036) accepts an `isHealthy: () => boolean` parameter, making it fully testable including error paths. Real PostgreSQL connectivity check deferred to HTTP server layer.
8. `buildCallbackRedirectUrl` returns `FRONTEND_BASE_URL` with no path appended, per REQ-AUTH-002.
