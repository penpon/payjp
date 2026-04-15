import type { LinkSessionRecord, OAuthStateRecord, ValidationResult } from '@hayane/shared';

// PROP-AUTH-001 対象: buildDiscordAuthorizationUrl
// REQ-AUTH-001, REQ-AUTH-007: scope=identify 固定
export function buildDiscordAuthorizationUrl(clientId: string, redirectUri: string, state: string): string {
  const url = new URL('https://discord.com/oauth2/authorize');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'identify guilds.join');
  url.searchParams.set('state', state);
  return url.toString();
}

// PROP-AUTH-004 対象: isExpired
// REQ-AUTH-012, REQ-AUTH-013: expires_at <= now → true (排他境界)
export function isExpired(expiresAt: Date, now: Date): boolean {
  return now >= expiresAt;
}

// REQ-AUTH-002, REQ-AUTH-004: used_at が null なら未使用
export function isUsed(usedAt: Date | null): boolean {
  return usedAt !== null;
}

// PROP-AUTH-002, PROP-AUTH-003 対象: validateOAuthStateRecord
// REQ-AUTH-002: 4条件すべて成立時のみ ok: true
export function validateOAuthStateRecord(
  record: OAuthStateRecord,
  sessionHash: string,
  stateHashValue: string,
  now: Date,
): ValidationResult {
  if (record.state_hash !== stateHashValue) {
    return { ok: false, reason: 'state_hash mismatch' };
  }
  if (record.oauth_session_hash !== sessionHash) {
    return { ok: false, reason: 'oauth_session_hash mismatch' };
  }
  if (isExpired(record.expires_at, now)) {
    return { ok: false, reason: 'state record expired' };
  }
  if (isUsed(record.used_at)) {
    return { ok: false, reason: 'state record already used' };
  }
  return { ok: true };
}

// PROP-AUTH-027, PROP-AUTH-028 対象: validateLinkSessionRecord
// REQ-AUTH-004, REQ-AUTH-013: 3条件すべて成立時のみ ok: true
export function validateLinkSessionRecord(
  record: LinkSessionRecord,
  tokenHash: string,
  now: Date,
  options?: { allowConsumed?: boolean },
): ValidationResult {
  if (record.link_session_token_hash !== tokenHash) {
    return { ok: false, reason: 'link_session_token_hash mismatch' };
  }
  if (isExpired(record.expires_at, now)) {
    return { ok: false, reason: 'link session record expired' };
  }
  if (!options?.allowConsumed && isUsed(record.used_at)) {
    return { ok: false, reason: 'link session record already used' };
  }
  return { ok: true };
}

// PROP-AUTH-006, PROP-AUTH-007 対象: buildCookieAttributes
// REQ-AUTH-005: __Host-Cookie の固定属性
// 実装は @hayane/shared に移動済み。後方互換性のため re-export。
export { buildCookieAttributes } from '@hayane/shared';

// PROP-AUTH-005 対象: maskSensitiveLogFields
// REQ-AUTH-010: 機密キーのマスキング
const SENSITIVE_FIELD_PATTERN = /^(cookie|authorization|set-cookie|code|token)$/i;

export function maskSensitiveLogFields(logEntry: Record<string, unknown>): Record<string, unknown> {
  const masked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(logEntry)) {
    masked[key] = SENSITIVE_FIELD_PATTERN.test(key) ? '[REDACTED]' : value;
  }
  return masked;
}

// PROP-AUTH-008 対象: isSameOrigin
// REQ-AUTH-008: scheme+host+port 正規化比較（RFC 6454準拠）
// 実装は @hayane/shared に移動済み。後方互換性のため re-export。
export { isSameOrigin } from '@hayane/shared';

// PROP-AUTH-031 対象: buildCallbackRedirectUrl
// REQ-AUTH-002, REQ-AUTH-006: コールバックリダイレクト先は FRONTEND_BASE_URL そのもの（パス追加なし）
export function buildCallbackRedirectUrl(frontendBaseUrl: string): string {
  return frontendBaseUrl;
}

// PROP-AUTH-032 対象: getSecurityHeaders
// REQ-AUTH-014: セキュリティヘッダ（Cache-Control, Referrer-Policy）
export function getSecurityHeaders(): Record<string, string> {
  return {
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  };
}

// PROP-AUTH-033 対象: getCorsHeaders
// REQ-AUTH-004: CORS ヘッダ（Access-Control-Allow-Credentials, Access-Control-Allow-Origin）
export function getCorsHeaders(frontendBaseUrl: string): Record<string, string> {
  return {
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Origin': frontendBaseUrl,
  };
}

// PROP-AUTH-034 対象: validateRequiredEnvVars
// REQ-AUTH-011: 必須環境変数の存在検証
const REQUIRED_ENV_VAR_NAMES = [
  'DISCORD_CLIENT_ID',
  'DISCORD_CLIENT_SECRET',
  'DISCORD_REDIRECT_URI',
  'FRONTEND_BASE_URL',
  'DATABASE_URL',
] as const;

export type EnvVarValidationResult = { ok: true } | { ok: false; missingVars: string[] };

export function validateRequiredEnvVars(env: Record<string, string | undefined>): EnvVarValidationResult {
  const missingVars = REQUIRED_ENV_VAR_NAMES.filter((name) => !env[name] || env[name] === '');
  if (missingVars.length > 0) {
    return { ok: false, missingVars };
  }
  return { ok: true };
}

// PROP-AUTH-006, PROP-AUTH-007 補完: serializeCookieAttributes
// 実装は @hayane/shared に移動済み。後方互換性のため re-export。
export { serializeCookieAttributes } from '@hayane/shared';

// PROP-AUTH-009 対象: validateFrontendBaseUrl
// REQ-AUTH-011: origin形式のみ許可（末尾スラッシュ・パス禁止）
const FRONTEND_BASE_URL_PATTERN = /^https?:\/\/[^/]+$/;

export function validateFrontendBaseUrl(raw: string): ValidationResult {
  if (!FRONTEND_BASE_URL_PATTERN.test(raw)) {
    return { ok: false, reason: 'FRONTEND_BASE_URL must be scheme+host+optional-port with no path or trailing slash' };
  }
  return { ok: true };
}

// PROP-AUTH-020 対象: validateStartupConfig
// REQ-AUTH-011: 必須環境変数の存在 + FRONTEND_BASE_URL フォーマット検証を合成
// FIND-005: validateRequiredEnvVars（PROP-AUTH-034）と異なり、URLフォーマット検証も行う
export function validateStartupConfig(
  env: Record<string, string | undefined>,
): { ok: true } | { ok: false; errors: string[] } {
  const envResult = validateRequiredEnvVars(env);
  if (!envResult.ok) {
    return { ok: false, errors: envResult.missingVars.map((v) => `Missing: ${v}`) };
  }
  const urlResult = validateFrontendBaseUrl(env.FRONTEND_BASE_URL!);
  if (!urlResult.ok) {
    return { ok: false, errors: [urlResult.reason] };
  }
  return { ok: true };
}
