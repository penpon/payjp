import type {
  CookieAttributes,
  CookieName,
  LinkSessionRecord,
  OAuthStateRecord,
  ValidationResult,
} from '@hayane/shared';

// PROP-AUTH-001 対象: buildDiscordAuthorizationUrl
// REQ-AUTH-001, REQ-AUTH-007: scope=identify 固定
export function buildDiscordAuthorizationUrl(clientId: string, redirectUri: string, state: string): string {
  const url = new URL('https://discord.com/oauth2/authorize');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'identify');
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
export function buildCookieAttributes(name: CookieName, maxAge: number): CookieAttributes {
  return {
    name,
    secure: true,
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge,
  };
}

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
// - ホスト名は大文字小文字を区別しない（lowercase正規化）
// - デフォルトポート認識: https:443, http:80 は省略と等価
// - Origin: null は拒否
// - requestOrigin の末尾スラッシュは拒否
export function isSameOrigin(requestOrigin: string, allowedOrigin: string): boolean {
  if (requestOrigin === 'null') {
    return false;
  }
  // 末尾スラッシュは不一致とする
  if (requestOrigin.endsWith('/')) {
    return false;
  }
  try {
    const req = new URL(requestOrigin);
    const allowed = new URL(allowedOrigin);
    // スキーム比較（小文字正規化済み）
    if (req.protocol !== allowed.protocol) {
      return false;
    }
    // ホスト比較（RFC 6454: case-insensitive）
    if (req.hostname.toLowerCase() !== allowed.hostname.toLowerCase()) {
      return false;
    }
    // ポート正規化: デフォルトポートは省略と等価
    const normalizePort = (url: URL): string => {
      if (url.port !== '') {
        return url.port;
      }
      if (url.protocol === 'https:') {
        return '443';
      }
      if (url.protocol === 'http:') {
        return '80';
      }
      return '';
    };
    return normalizePort(req) === normalizePort(allowed);
  } catch {
    return false;
  }
}

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
// CookieAttributes を Set-Cookie ヘッダ文字列にシリアライズする
export function serializeCookieAttributes(attrs: CookieAttributes, value: string): string {
  const parts: string[] = [`${attrs.name}=${value}`];
  if (attrs.maxAge !== undefined) parts.push(`Max-Age=${attrs.maxAge}`);
  if (attrs.path) parts.push(`Path=${attrs.path}`);
  if (attrs.secure) parts.push('Secure');
  if (attrs.httpOnly) parts.push('HttpOnly');
  if (attrs.sameSite) parts.push(`SameSite=${attrs.sameSite}`);
  // Domain は意図的に追加しない（__Host- Cookie の要件）
  return parts.join('; ');
}

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
