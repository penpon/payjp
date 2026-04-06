// auth-service effectful shell — すべてスタブ（Not implemented）
// REQ-AUTH-009: crypto.randomBytes による安全なトークン生成
export async function generateSecureRandomToken(): Promise<string> {
  throw new Error('Not implemented');
}

// REQ-AUTH-001: oauth_states への INSERT
export async function saveOAuthState(
  _db: unknown,
  _record: {
    id: string;
    stateHash: string;
    oauthSessionHash: string;
    expiresAt: Date;
  },
): Promise<void> {
  throw new Error('Not implemented');
}

// REQ-AUTH-002: oauth_states の原子的検証・消費（1トランザクション）
export async function consumeOAuthState(
  _db: unknown,
  _stateHash: string,
  _sessionHash: string,
): Promise<{
  id: string;
  state_hash: string;
  oauth_session_hash: string;
  expires_at: Date;
  used_at: Date | null;
  created_at: Date;
} | null> {
  throw new Error('Not implemented');
}

// REQ-AUTH-002: discord_link_sessions への INSERT
export async function saveDiscordLinkSession(
  _db: unknown,
  _record: {
    id: string;
    linkSessionTokenHash: string;
    discordUserId: string;
    expiresAt: Date;
  },
): Promise<void> {
  throw new Error('Not implemented');
}

// REQ-AUTH-002: Discord code → access_token 交換
export async function exchangeDiscordCode(
  _code: string,
  _env: { clientId: string; clientSecret: string; redirectUri: string },
): Promise<string> {
  throw new Error('Not implemented');
}

// REQ-AUTH-002: Discord /users/@me → discord_user_id 取得
export async function fetchDiscordUserId(
  _accessToken: string,
): Promise<string> {
  throw new Error('Not implemented');
}

// REQ-AUTH-010: 構造化ログ出力（機密マスク適用後）
export function structuredLog(
  _entry: Record<string, unknown>,
): void {
  throw new Error('Not implemented');
}
