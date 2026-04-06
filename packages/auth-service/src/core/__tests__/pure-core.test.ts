/**
 * Tier 1 純粋関数テスト — Red Phase
 *
 * PROP-AUTH-001 〜 PROP-AUTH-009, PROP-AUTH-027, PROP-AUTH-028
 * すべてのテストはスタブが "Not implemented" をスローするため FAIL する。
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

import {
  buildDiscordAuthorizationUrl,
  validateOAuthStateRecord,
  validateLinkSessionRecord,
  isExpired,
  isUsed,
  maskSensitiveLogFields,
  buildCookieAttributes,
  serializeCookieAttributes,
  isSameOrigin,
  validateFrontendBaseUrl,
  buildCallbackRedirectUrl,
  getSecurityHeaders,
  getCorsHeaders,
  validateRequiredEnvVars,
} from '../index.js';

import type { OAuthStateRecord, LinkSessionRecord } from '@hayane/shared';

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

const BASE_OAUTH_RECORD: OAuthStateRecord = {
  id: 'test-id',
  state_hash: 'correct-state-hash',
  oauth_session_hash: 'correct-session-hash',
  expires_at: new Date('2099-01-01T00:10:00Z'),
  used_at: null,
  created_at: new Date('2099-01-01T00:00:00Z'),
};

const BASE_LINK_RECORD: LinkSessionRecord = {
  id: 'link-id',
  link_session_token_hash: 'correct-token-hash',
  discord_user_id: 'discord-123',
  expires_at: new Date('2099-01-01T00:15:00Z'),
  used_at: null,
  created_at: new Date('2099-01-01T00:00:00Z'),
};

const NOW_BEFORE_EXPIRY = new Date('2099-01-01T00:05:00Z');

// ---------------------------------------------------------------------------
// PROP-AUTH-001: buildDiscordAuthorizationUrl — scope=identify 固定
// REQ-AUTH-001, REQ-AUTH-007
// ---------------------------------------------------------------------------
describe('PROP-AUTH-001: buildDiscordAuthorizationUrl always has scope=identify', () => {
  it('property: arbitrary clientId/redirectUri/state always yields URL with scope=identify and no extra scopes', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.webUrl(),
        fc.string({ minLength: 1 }),
        (clientId, redirectUri, state) => {
          const url = buildDiscordAuthorizationUrl(clientId, redirectUri, state);
          const parsed = new URL(url);
          const scope = parsed.searchParams.get('scope');
          expect(scope).toBe('identify');
          // 余分なスコープが入っていないこと
          expect(scope?.split(' ').length).toBe(1);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('URL base is https://discord.com/oauth2/authorize', () => {
    const url = buildDiscordAuthorizationUrl('client123', 'https://api.example.com/callback', 'state-abc');
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://discord.com/oauth2/authorize');
  });

  it('state query parameter is present in URL', () => {
    const state = 'test-state-value';
    const url = buildDiscordAuthorizationUrl('client123', 'https://api.example.com/callback', state);
    const parsed = new URL(url);
    expect(parsed.searchParams.get('state')).toBe(state);
  });

  it('response_type=code is present', () => {
    const url = buildDiscordAuthorizationUrl('client123', 'https://api.example.com/callback', 'state-xyz');
    const parsed = new URL(url);
    expect(parsed.searchParams.get('response_type')).toBe('code');
  });
});

// ---------------------------------------------------------------------------
// PROP-AUTH-002: validateOAuthStateRecord — 各条件個別失敗
// REQ-AUTH-002, REQ-AUTH-012
// ---------------------------------------------------------------------------
describe('PROP-AUTH-002: validateOAuthStateRecord fails for each condition individually', () => {
  it('case 1: state_hash mismatch → { ok: false }', () => {
    const result = validateOAuthStateRecord(
      BASE_OAUTH_RECORD,
      'correct-session-hash',
      'WRONG-state-hash',    // 不一致
      NOW_BEFORE_EXPIRY,
    );
    expect(result.ok).toBe(false);
  });

  it('case 2: oauth_session_hash mismatch → { ok: false }', () => {
    const result = validateOAuthStateRecord(
      BASE_OAUTH_RECORD,
      'WRONG-session-hash',  // 不一致
      'correct-state-hash',
      NOW_BEFORE_EXPIRY,
    );
    expect(result.ok).toBe(false);
  });

  it('case 3: expired (expires_at <= now) → { ok: false }', () => {
    const expiredRecord: OAuthStateRecord = {
      ...BASE_OAUTH_RECORD,
      expires_at: new Date('2000-01-01T00:00:00Z'),
    };
    const result = validateOAuthStateRecord(
      expiredRecord,
      'correct-session-hash',
      'correct-state-hash',
      new Date('2000-01-01T00:01:00Z'), // expires_at より後
    );
    expect(result.ok).toBe(false);
  });

  it('case 4: already used (used_at !== null) → { ok: false }', () => {
    const usedRecord: OAuthStateRecord = {
      ...BASE_OAUTH_RECORD,
      used_at: new Date('2099-01-01T00:01:00Z'),
    };
    const result = validateOAuthStateRecord(
      usedRecord,
      'correct-session-hash',
      'correct-state-hash',
      NOW_BEFORE_EXPIRY,
    );
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PROP-AUTH-003: validateOAuthStateRecord — 全条件成立時のみ成功
// REQ-AUTH-002
// ---------------------------------------------------------------------------
describe('PROP-AUTH-003: validateOAuthStateRecord succeeds only when all conditions hold', () => {
  it('property: valid record with matching hashes and before expiry always succeeds', () => {
    fc.assert(
      fc.property(
        fc.uuid(),
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 1 }),
        (id, stateHashVal, sessionHashVal) => {
          const futureExpiry = new Date('2099-12-31T23:59:59Z');
          const now = new Date('2099-01-01T00:00:00Z');
          const record: OAuthStateRecord = {
            id,
            state_hash: stateHashVal,
            oauth_session_hash: sessionHashVal,
            expires_at: futureExpiry,
            used_at: null,
            created_at: now,
          };
          const result = validateOAuthStateRecord(record, sessionHashVal, stateHashVal, now);
          expect(result.ok).toBe(true);
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ---------------------------------------------------------------------------
// PROP-AUTH-004: isExpired — 境界値テスト
// REQ-AUTH-012, REQ-AUTH-013
// ---------------------------------------------------------------------------
describe('PROP-AUTH-004: isExpired boundary', () => {
  it('case 1: expires_at > now → false (まだ有効)', () => {
    const expiresAt = new Date('2099-01-01T00:10:00Z');
    const now = new Date('2099-01-01T00:05:00Z');
    expect(isExpired(expiresAt, now)).toBe(false);
  });

  it('case 2: expires_at < now → true (期限切れ)', () => {
    const expiresAt = new Date('2099-01-01T00:05:00Z');
    const now = new Date('2099-01-01T00:10:00Z');
    expect(isExpired(expiresAt, now)).toBe(true);
  });

  it('case 3: expires_at === now → true (排他境界 — 同刻は期限切れ)', () => {
    const boundary = new Date('2099-01-01T00:10:00Z');
    expect(isExpired(boundary, boundary)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PROP-AUTH-005: maskSensitiveLogFields — 機密キーのマスキング
// REQ-AUTH-010
// ---------------------------------------------------------------------------
describe('PROP-AUTH-005: maskSensitiveLogFields never outputs raw sensitive values', () => {
  const SENSITIVE_KEYS = ['cookie', 'authorization', 'set-cookie', 'code', 'token'];

  it('property: arbitrary strings for sensitive keys are always masked to [REDACTED]', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        (sensitiveValue) => {
          for (const key of SENSITIVE_KEYS) {
            const entry = { [key]: sensitiveValue, other: 'safe-value' };
            const masked = maskSensitiveLogFields(entry);
            expect(masked[key]).toBe('[REDACTED]');
            // 非機密フィールドはそのまま
            expect(masked['other']).toBe('safe-value');
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  it('masks all sensitive keys simultaneously', () => {
    const entry: Record<string, unknown> = {
      cookie: 'raw-cookie-value',
      authorization: 'Bearer secret-token',
      'set-cookie': '__Host-oauth_session=abc',
      code: 'discord-oauth-code',
      token: 'raw-token-value',
      endpoint: '/v1/auth/discord/callback',
      result: 'success',
    };
    const masked = maskSensitiveLogFields(entry);
    for (const key of SENSITIVE_KEYS) {
      expect(masked[key]).toBe('[REDACTED]');
    }
    expect(masked['endpoint']).toBe('/v1/auth/discord/callback');
    expect(masked['result']).toBe('success');
  });

  it('non-sensitive fields pass through unchanged', () => {
    const entry = { timestamp: '2099-01-01T00:00:00Z', service: 'auth-service' };
    const masked = maskSensitiveLogFields(entry);
    expect(masked['timestamp']).toBe('2099-01-01T00:00:00Z');
    expect(masked['service']).toBe('auth-service');
  });
});

// ---------------------------------------------------------------------------
// PROP-AUTH-006: buildCookieAttributes for __Host-oauth_session
// REQ-AUTH-005
// ---------------------------------------------------------------------------
describe('PROP-AUTH-006: buildCookieAttributes for __Host-oauth_session', () => {
  it('returns exact required attributes with Max-Age=600', () => {
    const attrs = buildCookieAttributes('__Host-oauth_session', 600);

    expect(attrs.name).toBe('__Host-oauth_session');
    expect(attrs.secure).toBe(true);
    expect(attrs.httpOnly).toBe(true);
    expect(attrs.sameSite).toBe('Lax');
    expect(attrs.path).toBe('/');
    expect(attrs.maxAge).toBe(600);
    // Domain は absent — undefined または存在しない
    expect(attrs.domain).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// PROP-AUTH-007: buildCookieAttributes for __Host-link_session
// REQ-AUTH-005
// ---------------------------------------------------------------------------
describe('PROP-AUTH-007: buildCookieAttributes for __Host-link_session', () => {
  it('returns exact required attributes with Max-Age=900', () => {
    const attrs = buildCookieAttributes('__Host-link_session', 900);

    expect(attrs.name).toBe('__Host-link_session');
    expect(attrs.secure).toBe(true);
    expect(attrs.httpOnly).toBe(true);
    expect(attrs.sameSite).toBe('Lax');
    expect(attrs.path).toBe('/');
    expect(attrs.maxAge).toBe(900);
    expect(attrs.domain).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// PROP-AUTH-008: isSameOrigin — 各種不一致ケース
// REQ-AUTH-008
// ---------------------------------------------------------------------------
describe('PROP-AUTH-008: isSameOrigin rejects various mismatches', () => {
  it('case 1: scheme mismatch (http vs https) → false', () => {
    expect(isSameOrigin('http://example.com', 'https://example.com')).toBe(false);
  });

  it('case 2: host mismatch → false', () => {
    expect(isSameOrigin('https://other.com', 'https://example.com')).toBe(false);
  });

  it('case 3: port mismatch → false', () => {
    expect(isSameOrigin('https://example.com:8080', 'https://example.com')).toBe(false);
  });

  it('case 4: origin="null" string → false', () => {
    expect(isSameOrigin('null', 'https://example.com')).toBe(false);
  });

  it('case 5: case difference in host → true (RFC 6454: hostname is case-insensitive)', () => {
    expect(isSameOrigin('https://EXAMPLE.COM', 'https://example.com')).toBe(true);
  });

  it('case 6: exact match → true', () => {
    expect(isSameOrigin('https://example.com', 'https://example.com')).toBe(true);
  });

  it('case 7: exact match with port → true', () => {
    expect(isSameOrigin('https://example.com:443', 'https://example.com:443')).toBe(true);
  });

  it('case 8: trailing slash in request origin → false or normalized', () => {
    // 末尾スラッシュ付きは不一致として扱う
    expect(isSameOrigin('https://example.com/', 'https://example.com')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PROP-AUTH-009: validateFrontendBaseUrl — 無効フォーマット拒否
// REQ-AUTH-011
// ---------------------------------------------------------------------------
describe('PROP-AUTH-009: validateFrontendBaseUrl rejects invalid formats', () => {
  it('rejects empty string', () => {
    const result = validateFrontendBaseUrl('');
    expect(result.ok).toBe(false);
  });

  it('rejects URL with trailing slash', () => {
    const result = validateFrontendBaseUrl('https://example.com/');
    expect(result.ok).toBe(false);
  });

  it('rejects URL with path segment', () => {
    const result = validateFrontendBaseUrl('https://example.com/app');
    expect(result.ok).toBe(false);
  });

  it('rejects URL with path and trailing slash', () => {
    const result = validateFrontendBaseUrl('https://example.com/app/');
    expect(result.ok).toBe(false);
  });

  it('property: strings with trailing slash always rejected', () => {
    fc.assert(
      fc.property(
        fc.webUrl().filter((u) => !u.endsWith('/')),
        (url) => {
          const withSlash = url + '/';
          const result = validateFrontendBaseUrl(withSlash);
          expect(result.ok).toBe(false);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('accepts valid origin-only URL without path', () => {
    const result = validateFrontendBaseUrl('https://example.com');
    expect(result.ok).toBe(true);
  });

  it('accepts valid origin with explicit port', () => {
    const result = validateFrontendBaseUrl('https://example.com:3000');
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PROP-AUTH-027: validateLinkSessionRecord — 各条件個別失敗
// REQ-AUTH-004, REQ-AUTH-013
// ---------------------------------------------------------------------------
describe('PROP-AUTH-027: validateLinkSessionRecord fails for each condition individually', () => {
  it('case 1: token hash mismatch → { ok: false }', () => {
    const result = validateLinkSessionRecord(
      BASE_LINK_RECORD,
      'WRONG-token-hash',
      NOW_BEFORE_EXPIRY,
    );
    expect(result.ok).toBe(false);
  });

  it('case 2: expired → { ok: false }', () => {
    const expiredRecord: LinkSessionRecord = {
      ...BASE_LINK_RECORD,
      expires_at: new Date('2000-01-01T00:00:00Z'),
    };
    const result = validateLinkSessionRecord(
      expiredRecord,
      'correct-token-hash',
      new Date('2000-01-01T00:01:00Z'),
    );
    expect(result.ok).toBe(false);
  });

  it('case 3: already used → { ok: false }', () => {
    const usedRecord: LinkSessionRecord = {
      ...BASE_LINK_RECORD,
      used_at: new Date('2099-01-01T00:01:00Z'),
    };
    const result = validateLinkSessionRecord(
      usedRecord,
      'correct-token-hash',
      NOW_BEFORE_EXPIRY,
    );
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PROP-AUTH-028: validateLinkSessionRecord — 全条件成立時のみ成功
// REQ-AUTH-004
// ---------------------------------------------------------------------------
describe('PROP-AUTH-028: validateLinkSessionRecord succeeds when all conditions hold', () => {
  it('property: valid record with matching token hash and before expiry always succeeds', () => {
    fc.assert(
      fc.property(
        fc.uuid(),
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 1, maxLength: 50 }),
        (id, tokenHashVal, discordUserId) => {
          const futureExpiry = new Date('2099-12-31T23:59:59Z');
          const now = new Date('2099-01-01T00:00:00Z');
          const record: LinkSessionRecord = {
            id,
            link_session_token_hash: tokenHashVal,
            discord_user_id: discordUserId,
            expires_at: futureExpiry,
            used_at: null,
            created_at: now,
          };
          const result = validateLinkSessionRecord(record, tokenHashVal, now);
          expect(result.ok).toBe(true);
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ---------------------------------------------------------------------------
// isUsed — 補完テスト
// ---------------------------------------------------------------------------
describe('isUsed: null → false, non-null → true', () => {
  it('null → false (未使用)', () => {
    expect(isUsed(null)).toBe(false);
  });

  it('non-null Date → true (使用済み)', () => {
    expect(isUsed(new Date('2099-01-01T00:00:00Z'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PROP-AUTH-031: buildCallbackRedirectUrl — クエリ/フラグメントにトークン非掲載
// REQ-AUTH-006
// ---------------------------------------------------------------------------
describe('PROP-AUTH-031: buildCallbackRedirectUrl returns FRONTEND_BASE_URL with no query or fragment', () => {
  it('returns exactly frontendBaseUrl with no query parameters and no fragment', () => {
    const frontendBaseUrl = 'https://frontend.example.com';
    const url = buildCallbackRedirectUrl(frontendBaseUrl);
    expect(url).toBe(frontendBaseUrl);
    const parsed = new URL(url);
    expect(parsed.searchParams.get('token')).toBeNull();
    expect(parsed.searchParams.get('link_session')).toBeNull();
    expect(parsed.searchParams.get('oauth_session')).toBeNull();
    expect(parsed.searchParams.get('code')).toBeNull();
    expect(parsed.hash).toBe('');
    // REQ-AUTH-002: パスは追加しない
    expect(parsed.pathname).toBe('/');
  });

  it('property: arbitrary frontendBaseUrl returns the URL unchanged (no path appended)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          'https://app.example.com',
          'https://frontend.example.org',
          'http://localhost:3000',
        ),
        (baseUrl) => {
          const url = buildCallbackRedirectUrl(baseUrl);
          expect(url).toBe(baseUrl);
          const parsed = new URL(url);
          const sensitiveParams = ['token', 'link_session', 'oauth_session', 'code', 'authorization'];
          for (const param of sensitiveParams) {
            expect(parsed.searchParams.get(param)).toBeNull();
          }
          expect(parsed.hash).toBe('');
        },
      ),
      { numRuns: 10 },
    );
  });
});

// ---------------------------------------------------------------------------
// PROP-AUTH-032: getSecurityHeaders — Cache-Control/Referrer-Policy 必須値
// REQ-AUTH-014
// ---------------------------------------------------------------------------
describe('PROP-AUTH-032: getSecurityHeaders returns required security headers', () => {
  it('returns Cache-Control: no-store', () => {
    const headers = getSecurityHeaders();
    expect(headers['Cache-Control']).toBe('no-store');
  });

  it('returns Referrer-Policy: no-referrer', () => {
    const headers = getSecurityHeaders();
    expect(headers['Referrer-Policy']).toBe('no-referrer');
  });

  it('returns exactly two headers with no extra entries', () => {
    const headers = getSecurityHeaders();
    expect(Object.keys(headers).length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// PROP-AUTH-033: getCorsHeaders — CORS ヘッダ値
// REQ-AUTH-004
// ---------------------------------------------------------------------------
describe('PROP-AUTH-033: getCorsHeaders returns required CORS headers', () => {
  it('returns Access-Control-Allow-Credentials: true', () => {
    const headers = getCorsHeaders('https://frontend.example.com');
    expect(headers['Access-Control-Allow-Credentials']).toBe('true');
  });

  it('returns Access-Control-Allow-Origin matching frontendBaseUrl', () => {
    const frontendBaseUrl = 'https://frontend.example.com';
    const headers = getCorsHeaders(frontendBaseUrl);
    expect(headers['Access-Control-Allow-Origin']).toBe(frontendBaseUrl);
  });

  it('property: getCorsHeaders always echoes frontendBaseUrl as Allow-Origin', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          'https://app.example.com',
          'https://frontend.example.org',
          'http://localhost:3000',
        ),
        (baseUrl) => {
          const headers = getCorsHeaders(baseUrl);
          expect(headers['Access-Control-Allow-Origin']).toBe(baseUrl);
          expect(headers['Access-Control-Allow-Credentials']).toBe('true');
        },
      ),
      { numRuns: 10 },
    );
  });
});

// ---------------------------------------------------------------------------
// PROP-AUTH-034: validateRequiredEnvVars — 各必須変数の欠落を検出
// REQ-AUTH-011
// ---------------------------------------------------------------------------
describe('PROP-AUTH-034: validateRequiredEnvVars detects each missing required env var', () => {
  const FULL_ENV = {
    DISCORD_CLIENT_ID: 'client-id',
    DISCORD_CLIENT_SECRET: 'client-secret',
    DISCORD_REDIRECT_URI: 'https://api.example.com/callback',
    FRONTEND_BASE_URL: 'https://frontend.example.com',
    DATABASE_URL: 'postgresql://localhost:5432/hayane',
  };

  it('accepts fully populated env', () => {
    const result = validateRequiredEnvVars(FULL_ENV);
    expect(result.ok).toBe(true);
  });

  it('rejects when DISCORD_CLIENT_ID is missing', () => {
    const env = { ...FULL_ENV, DISCORD_CLIENT_ID: undefined };
    const result = validateRequiredEnvVars(env);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missingVars).toContain('DISCORD_CLIENT_ID');
    }
  });

  it('rejects when DISCORD_CLIENT_SECRET is missing', () => {
    const env = { ...FULL_ENV, DISCORD_CLIENT_SECRET: undefined };
    const result = validateRequiredEnvVars(env);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missingVars).toContain('DISCORD_CLIENT_SECRET');
    }
  });

  it('rejects when DISCORD_REDIRECT_URI is missing', () => {
    const env = { ...FULL_ENV, DISCORD_REDIRECT_URI: undefined };
    const result = validateRequiredEnvVars(env);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missingVars).toContain('DISCORD_REDIRECT_URI');
    }
  });

  it('rejects when FRONTEND_BASE_URL is missing', () => {
    const env = { ...FULL_ENV, FRONTEND_BASE_URL: undefined };
    const result = validateRequiredEnvVars(env);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missingVars).toContain('FRONTEND_BASE_URL');
    }
  });

  it('rejects when DATABASE_URL is missing', () => {
    const env = { ...FULL_ENV, DATABASE_URL: undefined };
    const result = validateRequiredEnvVars(env);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missingVars).toContain('DATABASE_URL');
    }
  });

  it('rejects when all env vars are missing', () => {
    const result = validateRequiredEnvVars({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missingVars.length).toBe(5);
    }
  });
});

// ---------------------------------------------------------------------------
// PROP-AUTH-008 追加: isSameOrigin — デフォルトポート正規化
// REQ-AUTH-008 (RFC 6454)
// ---------------------------------------------------------------------------
describe('PROP-AUTH-008 (additional): isSameOrigin RFC 6454 default port normalization', () => {
  it('https://example.com and https://example.com:443 are the same origin', () => {
    expect(isSameOrigin('https://example.com', 'https://example.com:443')).toBe(true);
  });

  it('https://example.com:443 and https://example.com are the same origin', () => {
    expect(isSameOrigin('https://example.com:443', 'https://example.com')).toBe(true);
  });

  it('http://example.com and http://example.com:80 are the same origin', () => {
    expect(isSameOrigin('http://example.com', 'http://example.com:80')).toBe(true);
  });

  it('https://example.com:8080 and https://example.com are different origins (non-default port)', () => {
    expect(isSameOrigin('https://example.com:8080', 'https://example.com')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PROP-AUTH-006/007 補完 (Tier 1): serializeCookieAttributes — Set-Cookie 文字列フォーマット
// REQ-AUTH-005
// FIND-009: serializeCookieAttributes は purity boundary map に掲載されているが Tier 1 テストがなかった
// ---------------------------------------------------------------------------
describe('serializeCookieAttributes: serializes to correct Set-Cookie header string format', () => {
  it('serializes __Host-oauth_session with all required attributes in correct order', () => {
    const attrs = buildCookieAttributes('__Host-oauth_session', 600);
    const result = serializeCookieAttributes(attrs, 'test-session-value');
    expect(result).toContain('__Host-oauth_session=test-session-value');
    expect(result).toContain('Max-Age=600');
    expect(result).toContain('Path=/');
    expect(result).toContain('Secure');
    expect(result).toContain('HttpOnly');
    expect(result).toContain('SameSite=Lax');
    // Domain は含まれない（__Host- Cookie の要件）
    expect(result).not.toContain('Domain=');
  });

  it('serializes __Host-link_session with Max-Age=900', () => {
    const attrs = buildCookieAttributes('__Host-link_session', 900);
    const result = serializeCookieAttributes(attrs, 'test-link-token');
    expect(result).toContain('__Host-link_session=test-link-token');
    expect(result).toContain('Max-Age=900');
    expect(result).toContain('Secure');
    expect(result).toContain('HttpOnly');
    expect(result).toContain('SameSite=Lax');
    expect(result).toContain('Path=/');
    expect(result).not.toContain('Domain=');
  });

  it('property: serialized string always starts with name=value pair', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('__Host-oauth_session' as const, '__Host-link_session' as const),
        fc.integer({ min: 1, max: 9999 }),
        fc.string({ minLength: 1, maxLength: 64 }).filter((s) => !s.includes(';') && !s.includes('=')),
        (name, maxAge, value) => {
          const attrs = buildCookieAttributes(name, maxAge);
          const result = serializeCookieAttributes(attrs, value);
          expect(result.startsWith(`${name}=${value}`)).toBe(true);
          expect(result).not.toContain('Domain=');
        },
      ),
      { numRuns: 30 },
    );
  });
});

// ---------------------------------------------------------------------------
// PROP-AUTH-005 追加: maskSensitiveLogFields — 混合ケースキーのマスキング
// REQ-AUTH-010
// FIND-013: 小文字のみテスト済みだったが Cookie/AUTHORIZATION/Set-Cookie（混合ケース）もマスクされることを検証
// ---------------------------------------------------------------------------
describe('PROP-AUTH-005 (mixed-case): maskSensitiveLogFields masks keys regardless of case', () => {
  it('masks "Cookie" (PascalCase) as sensitive field', () => {
    const entry = { Cookie: 'raw-cookie-value', path: '/api' };
    const masked = maskSensitiveLogFields(entry);
    expect(masked['Cookie']).toBe('[REDACTED]');
    expect(masked['path']).toBe('/api');
  });

  it('masks "AUTHORIZATION" (uppercase) as sensitive field', () => {
    const entry = { AUTHORIZATION: 'Bearer secret', service: 'auth' };
    const masked = maskSensitiveLogFields(entry);
    expect(masked['AUTHORIZATION']).toBe('[REDACTED]');
    expect(masked['service']).toBe('auth');
  });

  it('masks "Set-Cookie" (title-case) as sensitive field', () => {
    const entry = { 'Set-Cookie': '__Host-link_session=abc; Secure', endpoint: '/callback' };
    const masked = maskSensitiveLogFields(entry);
    expect(masked['Set-Cookie']).toBe('[REDACTED]');
    expect(masked['endpoint']).toBe('/callback');
  });

  it('masks all mixed-case variants simultaneously', () => {
    const entry: Record<string, unknown> = {
      Cookie: 'raw-value',
      AUTHORIZATION: 'Bearer token',
      'Set-Cookie': '__Host-oauth_session=xyz',
      timestamp: '2099-01-01T00:00:00Z',
    };
    const masked = maskSensitiveLogFields(entry);
    expect(masked['Cookie']).toBe('[REDACTED]');
    expect(masked['AUTHORIZATION']).toBe('[REDACTED]');
    expect(masked['Set-Cookie']).toBe('[REDACTED]');
    expect(masked['timestamp']).toBe('2099-01-01T00:00:00Z');
  });
});
