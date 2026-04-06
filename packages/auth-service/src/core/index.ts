import type {
  OAuthStateRecord,
  LinkSessionRecord,
  ValidationResult,
  CookieName,
  CookieAttributes,
} from '@hayane/shared';

// PROP-AUTH-001 対象: buildDiscordAuthorizationUrl
// REQ-AUTH-001, REQ-AUTH-007: scope=identify 固定
export function buildDiscordAuthorizationUrl(
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  throw new Error('Not implemented');
}

// REQ-AUTH-001: state_hash = SHA-256(rawState)
export function stateHash(rawState: string): string {
  throw new Error('Not implemented');
}

// REQ-AUTH-001: oauth_session_hash = SHA-256(sessionToken)
export function oauthSessionHash(sessionToken: string): string {
  throw new Error('Not implemented');
}

// REQ-AUTH-004: link_session_token_hash = SHA-256(token)
export function linkSessionTokenHash(token: string): string {
  throw new Error('Not implemented');
}

// PROP-AUTH-004 対象: isExpired
// REQ-AUTH-012, REQ-AUTH-013: expires_at <= now → true (排他境界)
export function isExpired(expiresAt: Date, now: Date): boolean {
  throw new Error('Not implemented');
}

// REQ-AUTH-002, REQ-AUTH-004: used_at が null なら未使用
export function isUsed(usedAt: Date | null): boolean {
  throw new Error('Not implemented');
}

// PROP-AUTH-002, PROP-AUTH-003 対象: validateOAuthStateRecord
// REQ-AUTH-002: 4条件すべて成立時のみ ok: true
export function validateOAuthStateRecord(
  record: OAuthStateRecord,
  sessionHash: string,
  stateHashValue: string,
  now: Date,
): ValidationResult {
  throw new Error('Not implemented');
}

// PROP-AUTH-027, PROP-AUTH-028 対象: validateLinkSessionRecord
// REQ-AUTH-004, REQ-AUTH-013: 3条件すべて成立時のみ ok: true
export function validateLinkSessionRecord(
  record: LinkSessionRecord,
  tokenHash: string,
  now: Date,
): ValidationResult {
  throw new Error('Not implemented');
}

// PROP-AUTH-006, PROP-AUTH-007 対象: buildCookieAttributes
// REQ-AUTH-005: __Host-Cookie の固定属性
export function buildCookieAttributes(
  name: CookieName,
  maxAge: number,
): CookieAttributes {
  throw new Error('Not implemented');
}

// PROP-AUTH-005 対象: maskSensitiveLogFields
// REQ-AUTH-010: 機密キーのマスキング
export function maskSensitiveLogFields(
  logEntry: Record<string, unknown>,
): Record<string, unknown> {
  throw new Error('Not implemented');
}

// PROP-AUTH-008 対象: isSameOrigin
// REQ-AUTH-008: scheme+host+port 正規化比較
export function isSameOrigin(
  requestOrigin: string,
  allowedOrigin: string,
): boolean {
  throw new Error('Not implemented');
}

// PROP-AUTH-009 対象: validateFrontendBaseUrl
// REQ-AUTH-011: origin形式のみ許可（末尾スラッシュ・パス禁止）
export function validateFrontendBaseUrl(raw: string): ValidationResult {
  throw new Error('Not implemented');
}
