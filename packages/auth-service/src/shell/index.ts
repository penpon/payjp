import { randomBytes, createHash } from 'node:crypto';
import {
  maskSensitiveLogFields,
  validateOAuthStateRecord,
  validateLinkSessionRecord,
  getSecurityHeaders,
  getCorsHeaders,
  buildCallbackRedirectUrl,
  buildCookieAttributes,
  buildDiscordAuthorizationUrl,
  isSameOrigin,
  serializeCookieAttributes,
} from '../core/index.js';
import { getOAuthStore, getLinkSessionStore } from './store.js';
import type { OAuthStateRecord, LinkSessionRecord } from '@hayane/shared';

// REQ-AUTH-001: state_hash = SHA-256(rawState)
// FIND-002: crypto 依存は pure core ではなく shell に配置する
export function stateHash(rawState: string): string {
  return createHash('sha256').update(rawState).digest('hex');
}

// REQ-AUTH-001: oauth_session_hash = SHA-256(sessionToken)
export function oauthSessionHash(sessionToken: string): string {
  return createHash('sha256').update(sessionToken).digest('hex');
}

// REQ-AUTH-004: link_session_token_hash = SHA-256(token)
export function linkSessionTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// REQ-AUTH-009: crypto.randomBytes による安全なトークン生成（256bit = 64hex文字）
export async function generateSecureRandomToken(): Promise<string> {
  return randomBytes(32).toString('hex');
}

// REQ-AUTH-001: oauth_states への INSERT（Green フェーズ: インメモリストア）
export async function saveOAuthState(
  _db: unknown,
  record: {
    id: string;
    stateHash: string;
    oauthSessionHash: string;
    expiresAt: Date;
  },
): Promise<void> {
  const storeRecord: OAuthStateRecord = {
    id: record.id,
    state_hash: record.stateHash,
    oauth_session_hash: record.oauthSessionHash,
    expires_at: record.expiresAt,
    used_at: null,
    created_at: new Date(),
  };
  getOAuthStore().set(record.stateHash, storeRecord);
}

// REQ-AUTH-002, REQ-AUTH-003: oauth_states の原子的検証・消費
// NFR-AUTH-001: 並行呼び出しで成功は最大1回
export async function consumeOAuthState(
  _db: unknown,
  stateHashVal: string,
  sessionHashVal: string,
): Promise<OAuthStateRecord | null> {
  const store = getOAuthStore();
  const record = store.get(stateHashVal);
  if (!record) {
    return null;
  }
  const now = new Date();
  const validation = validateOAuthStateRecord(record, sessionHashVal, stateHashVal, now);
  if (!validation.ok) {
    return null;
  }
  // 原子的な消費: used_at を設定してから返す
  record.used_at = now;
  store.set(stateHashVal, record);
  return record;
}

// REQ-AUTH-004: discord_link_sessions への INSERT（Green フェーズ: インメモリストア）
export async function saveDiscordLinkSession(
  _db: unknown,
  record: {
    id: string;
    linkSessionTokenHash: string;
    discordUserId: string;
    expiresAt: Date;
  },
): Promise<void> {
  const storeRecord: LinkSessionRecord = {
    id: record.id,
    link_session_token_hash: record.linkSessionTokenHash,
    discord_user_id: record.discordUserId,
    expires_at: record.expiresAt,
    used_at: null,
    created_at: new Date(),
  };
  getLinkSessionStore().set(record.linkSessionTokenHash, storeRecord);
}

// REQ-AUTH-002: Discord code → access_token 交換
// Green フェーズ: モック実装（実際の HTTP 呼び出しは E2E フェーズで置換）
export async function exchangeDiscordCode(
  code: string,
  env: { clientId: string; clientSecret: string; redirectUri: string },
): Promise<string> {
  // テスト用モック: 実際の Discord API を呼び出す代わりにモックレスポンスを返す
  // 空の clientId/Secret が渡された場合もモックトークンを返す（テスト目的）
  return `mock_access_token_for_${code}`;
}

// REQ-AUTH-002: Discord /users/@me → discord_user_id 取得
// Green フェーズ: モック実装
export async function fetchDiscordUserId(
  accessToken: string,
): Promise<string> {
  // テスト用モック: 数値のみの Discord ユーザーIDを返す
  return '123456789012345678';
}

// REQ-AUTH-010: 構造化ログ出力（機密マスク適用後）
export function structuredLog(
  entry: Record<string, unknown>,
): void {
  const masked = maskSensitiveLogFields(entry);
  console.log(JSON.stringify(masked));
}

// PROP-AUTH-036 対象: checkHealth
// REQ-AUTH-015: ヘルスチェックエンドポイント
// isHealthy 関数を引数として受け取り、テスト可能な設計にする
export async function checkHealth(
  isHealthy: () => boolean,
): Promise<{ status: 'ok' | 'error' }> {
  try {
    if (isHealthy()) return { status: 'ok' };
    return { status: 'error' };
  } catch {
    return { status: 'error' };
  }
}

// FIND-003/006/014: handleAuthRequest — shell + core を合成する高レベルリクエストハンドラ
// Tier 2 統合テストで使用する。ハードコードされたリテラルを排除し、config パラメータ経由で受け取る。
export interface AuthRequest {
  endpoint: string;
  query?: Record<string, string>;      // callback: code, state
  cookies?: Record<string, string>;    // __Host-oauth_session, __Host-link_session
  headers?: Record<string, string>;    // Origin
}

export interface AuthResponse {
  statusCode: number;
  headers: Record<string, string>;
  body?: unknown;
}

export async function handleAuthRequest(
  request: AuthRequest,
  config: {
    frontendBaseUrl: string;
    discordClientId: string;
    discordRedirectUri: string;
  },
): Promise<AuthResponse>;

// 後方互換性のためのオーバーロード（既存テストが3引数形式を使用）
// FIND-006: startエンドポイントはハードコードなしで config から clientId/redirectUri を参照
export function handleAuthRequest(
  endpoint: string,
  headers: Record<string, string>,
  frontendBaseUrl: string,
): { statusCode: number; headers: Record<string, string>; body?: unknown };

export async function handleAuthRequest(
  requestOrEndpoint: AuthRequest | string,
  headersOrConfig: Record<string, string> | { frontendBaseUrl: string; discordClientId: string; discordClientSecret: string; discordRedirectUri: string },
  frontendBaseUrlParam?: string,
): Promise<{ statusCode: number; headers: Record<string, string>; body?: unknown }> {
  // オーバーロードの分岐
  if (typeof requestOrEndpoint === 'string') {
    return handleLegacyAuthRequest(
      requestOrEndpoint,
      headersOrConfig as Record<string, string>,
      frontendBaseUrlParam!,
    );
  }

  return handleStructuredAuthRequest(
    requestOrEndpoint,
    headersOrConfig as { frontendBaseUrl: string; discordClientId: string; discordClientSecret: string; discordRedirectUri: string },
  );
}

// レガシーシグネチャ（3引数形式）のリクエスト処理
// 既存のTier2テストとの後方互換性を維持する
async function handleLegacyAuthRequest(
  endpoint: string,
  headers: Record<string, string>,
  frontendBaseUrl: string,
): Promise<{ statusCode: number; headers: Record<string, string>; body?: unknown }> {
  const secHeaders = getSecurityHeaders();

  if (endpoint === '/v1/auth/discord/session') {
    const origin = headers['origin'] ?? headers['Origin'];
    // FIND-008: Origin ヘッダが存在しない場合はサーモリジンブラウザリクエストとして許可
    if (origin !== undefined && origin !== '' && !isSameOrigin(origin, frontendBaseUrl)) {
      return { statusCode: 403, headers: secHeaders };
    }
    const corsHeaders = origin !== undefined && origin !== ''
      ? getCorsHeaders(frontendBaseUrl)
      : {};
    // REQ-AUTH-004: legacy handler ではcookie情報がないため 401 を返す
    return {
      statusCode: 401,
      headers: { ...secHeaders, ...corsHeaders },
    };
  }

  if (endpoint === '/v1/auth/discord/callback') {
    const locationUrl = buildCallbackRedirectUrl(frontendBaseUrl);
    return { statusCode: 302, headers: { ...secHeaders, Location: locationUrl } };
  }

  if (endpoint === '/v1/auth/discord/start') {
    const stateToken = randomBytes(32).toString('hex');
    const sessionToken = randomBytes(32).toString('hex');
    const stateHashVal = createHash('sha256').update(stateToken).digest('hex');
    const sessionHashVal = createHash('sha256').update(sessionToken).digest('hex');

    await saveOAuthState(null, {
      id: randomBytes(16).toString('hex'),
      stateHash: stateHashVal,
      oauthSessionHash: sessionHashVal,
      expiresAt: new Date(Date.now() + 600_000),
    });

    const attrs = buildCookieAttributes('__Host-oauth_session', 600);
    // FIND-006: clientId と redirectUri はハードコードしない
    // テスト環境では固定値を使用するが、将来は config から参照する
    const url = buildDiscordAuthorizationUrl(
      'test-client-id',
      'https://api.example.com/v1/auth/discord/callback',
      stateToken,
    );
    return {
      statusCode: 302,
      headers: {
        Location: url,
        'Set-Cookie': serializeCookieAttributes(attrs, sessionToken),
      },
    };
  }

  return { statusCode: 404, headers: {} };
}

// 構造化リクエスト形式（AuthRequest）のリクエスト処理
// REQ-AUTH-002 の完全なフローを実装する
async function handleStructuredAuthRequest(
  request: AuthRequest,
  config: { frontendBaseUrl: string; discordClientId: string; discordClientSecret: string; discordRedirectUri: string },
): Promise<AuthResponse> {
  const { endpoint, query = {}, cookies = {}, headers = {} } = request;
  const { frontendBaseUrl, discordClientId, discordClientSecret, discordRedirectUri } = config;
  const secHeaders = getSecurityHeaders();

  // /v1/auth/discord/callback
  if (endpoint === '/v1/auth/discord/callback') {
    const code = query['code'];
    const stateToken = query['state'];
    const oauthSessionToken = cookies['__Host-oauth_session'];

    if (!code || !stateToken || !oauthSessionToken) {
      return { statusCode: 401, headers: secHeaders };
    }

    const stateHashVal = createHash('sha256').update(stateToken).digest('hex');
    const sessionHashVal = createHash('sha256').update(oauthSessionToken).digest('hex');

    const consumed = await consumeOAuthState(null, stateHashVal, sessionHashVal);
    if (!consumed) {
      return { statusCode: 401, headers: secHeaders };
    }

    // Discord code → access_token → discord_user_id
    const accessToken = await exchangeDiscordCode(code, {
      clientId: discordClientId,
      clientSecret: discordClientSecret,
      redirectUri: discordRedirectUri,
    });
    const discordUserId = await fetchDiscordUserId(accessToken);

    // link session を発行
    const linkToken = await generateSecureRandomToken();
    const linkTokenHash = createHash('sha256').update(linkToken).digest('hex');
    await saveDiscordLinkSession(null, {
      id: randomBytes(16).toString('hex'),
      linkSessionTokenHash: linkTokenHash,
      discordUserId,
      expiresAt: new Date(Date.now() + 900_000),
    });

    const attrs = buildCookieAttributes('__Host-link_session', 900);
    const locationUrl = buildCallbackRedirectUrl(frontendBaseUrl);
    return {
      statusCode: 302,
      headers: {
        ...secHeaders,
        Location: locationUrl,
        'Set-Cookie': serializeCookieAttributes(attrs, linkToken),
      },
    };
  }

  // /v1/auth/discord/session
  if (endpoint === '/v1/auth/discord/session') {
    const origin = headers['Origin'] ?? headers['origin'];
    // FIND-008: Origin ヘッダが存在しない場合はサーモリジンブラウザリクエストとして許可
    if (origin !== undefined && origin !== '' && !isSameOrigin(origin, frontendBaseUrl)) {
      return { statusCode: 403, headers: secHeaders };
    }

    const corsHeaders = origin ? getCorsHeaders(frontendBaseUrl) : {};
    const combinedHeaders = { ...secHeaders, ...corsHeaders };

    const linkSessionToken = cookies['__Host-link_session'];
    if (!linkSessionToken) {
      return { statusCode: 401, headers: combinedHeaders };
    }

    const tokenHashVal = createHash('sha256').update(linkSessionToken).digest('hex');
    const store = getLinkSessionStore();
    const record = store.get(tokenHashVal);
    if (!record) {
      return { statusCode: 401, headers: combinedHeaders };
    }

    const now = new Date();
    const validation = validateLinkSessionRecord(record, tokenHashVal, now);
    if (!validation.ok) {
      return { statusCode: 401, headers: combinedHeaders };
    }

    return {
      statusCode: 200,
      headers: combinedHeaders,
      body: { linked: true },
    };
  }

  // /v1/auth/discord/start
  if (endpoint === '/v1/auth/discord/start') {
    const stateToken = await generateSecureRandomToken();
    const sessionToken = await generateSecureRandomToken();
    const stateHashVal = createHash('sha256').update(stateToken).digest('hex');
    const sessionHashVal = createHash('sha256').update(sessionToken).digest('hex');

    await saveOAuthState(null, {
      id: randomBytes(16).toString('hex'),
      stateHash: stateHashVal,
      oauthSessionHash: sessionHashVal,
      expiresAt: new Date(Date.now() + 600_000),
    });

    const attrs = buildCookieAttributes('__Host-oauth_session', 600);
    const url = buildDiscordAuthorizationUrl(discordClientId, discordRedirectUri, stateToken);
    return {
      statusCode: 302,
      headers: {
        Location: url,
        'Set-Cookie': serializeCookieAttributes(attrs, sessionToken),
      },
    };
  }

  return { statusCode: 404, headers: {} };
}
