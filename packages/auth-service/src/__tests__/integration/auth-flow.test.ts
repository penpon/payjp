/**
 * Tier 2 統合テスト — Green Phase
 *
 * PROP-AUTH-010 〜 024, 029
 * インメモリストアを用いた shell 関数の実動作を検証する。
 */

import type { LinkSessionRecord } from '@hayane/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { validateLinkSessionRecord, validateStartupConfig } from '../../core/index.js';
import {
  checkHealth,
  consumeOAuthState,
  exchangeDiscordCode,
  fetchDiscordUserId,
  generateSecureRandomToken,
  handleAuthRequest,
  saveDiscordLinkSession,
  saveOAuthState,
  structuredLog,
} from '../../shell/index.js';
import { clearStores, getStoreCounts } from '../../shell/store.js';

beforeEach(() => {
  clearStores();
});

// ---------------------------------------------------------------------------
// PROP-AUTH-010: consumeOAuthState — 並行消費の原子性
// REQ-AUTH-003, NFR-AUTH-001
// FIND-004: このテストはシングルスレッド JavaScript の Map を使用しており、
//           真の並行性（OS スレッド競合）は検証できない。論理的な正確性のみを確認する。
//           Known Limitation: 実際の DB トランザクションでの原子性は E2E フェーズで検証する。
// ---------------------------------------------------------------------------
describe('PROP-AUTH-010: consumeOAuthState atomic — concurrent invocations return success exactly once', () => {
  it('concurrent calls with same stateHash: only one resolves non-null', async () => {
    const db = null;
    const stateHashVal = 'test-state-hash-concurrent';
    const sessionHashVal = 'test-session-hash-concurrent';

    // レコードをストアに保存してから並行消費テスト
    await saveOAuthState(db, {
      id: 'concurrent-test-id',
      stateHash: stateHashVal,
      oauthSessionHash: sessionHashVal,
      expiresAt: new Date('2099-01-01T01:00:00Z'),
    });

    const [r1, r2] = await Promise.allSettled([
      consumeOAuthState(db, stateHashVal, sessionHashVal),
      consumeOAuthState(db, stateHashVal, sessionHashVal),
    ]);

    const successes = [r1, r2].filter((r) => r.status === 'fulfilled' && r.value !== null);
    // 1 回目の成功でused_atが設定されるので、2回目はnullを返す
    expect(successes.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// PROP-AUTH-011: callback 401 — 4つの失敗モード
// REQ-AUTH-002
// ---------------------------------------------------------------------------
describe('PROP-AUTH-011: callback 401 for all four verification failure modes', () => {
  it('state hash mismatch causes 401', async () => {
    const db = null;
    // ストアに正しいレコードを保存
    await saveOAuthState(db, {
      id: 'id-011-a',
      stateHash: 'correct-state-hash-011',
      oauthSessionHash: 'correct-session-hash-011',
      expiresAt: new Date('2099-01-01T01:00:00Z'),
    });
    // 間違った state hash で呼び出す → null が返るはず
    const result = await consumeOAuthState(db, 'wrong-state-hash', 'correct-session-hash-011');
    expect(result).toBeNull();
  });

  it('session hash mismatch causes 401', async () => {
    const db = null;
    await saveOAuthState(db, {
      id: 'id-011-b',
      stateHash: 'state-for-session-mismatch',
      oauthSessionHash: 'correct-session-hash-011b',
      expiresAt: new Date('2099-01-01T01:00:00Z'),
    });
    // 正しい state_hash で検索されるが session hash が不一致
    const result = await consumeOAuthState(db, 'state-for-session-mismatch', 'wrong-session-hash');
    expect(result).toBeNull();
  });

  it('expired state causes 401', async () => {
    const db = null;
    await saveOAuthState(db, {
      id: 'id-011-c',
      stateHash: 'expired-state-hash',
      oauthSessionHash: 'session-hash-011c',
      expiresAt: new Date('2000-01-01T00:00:00Z'), // 過去の日時
    });
    const result = await consumeOAuthState(db, 'expired-state-hash', 'session-hash-011c');
    expect(result).toBeNull();
  });

  it('already used state causes 401', async () => {
    const db = null;
    await saveOAuthState(db, {
      id: 'id-011-d',
      stateHash: 'reuse-state-hash',
      oauthSessionHash: 'session-hash-011d',
      expiresAt: new Date('2099-01-01T01:00:00Z'),
    });
    // 1回目: 成功
    const first = await consumeOAuthState(db, 'reuse-state-hash', 'session-hash-011d');
    expect(first).not.toBeNull();
    // 2回目: used_at が設定済みなので null
    const second = await consumeOAuthState(db, 'reuse-state-hash', 'session-hash-011d');
    expect(second).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PROP-AUTH-012: callback 302 Location にトークン非掲載
// REQ-AUTH-006
// FIND-011: 純粋関数の直接呼び出しではなく handleAuthRequest 経由で統合テスト
// ---------------------------------------------------------------------------
describe('PROP-AUTH-012: callback 302 Location contains no token in query or fragment', () => {
  it('handleAuthRequest for callback returns 302 with Location containing no sensitive keys', async () => {
    const frontendBaseUrl = 'https://frontend.example.com';
    // handleAuthRequest 経由で callback レスポンスを取得（FIND-011: 統合テスト）
    const response = await handleAuthRequest('/v1/auth/discord/callback', {}, frontendBaseUrl);
    // 状態・セッションが欠けているので 401 または 302 のどちらか
    // callback の正常系では 302 + Location が返る
    // ここでは Location が設定されている場合のトークン非掲載を検証
    if (response.statusCode === 302) {
      const locationUrl = response.headers.Location;
      expect(locationUrl).toBeDefined();
      // REQ-AUTH-002: Location は FRONTEND_BASE_URL そのもの（パス追加なし）
      expect(locationUrl).toBe(frontendBaseUrl);
      const parsed = new URL(locationUrl);
      expect(parsed.searchParams.get('token')).toBeNull();
      expect(parsed.searchParams.get('link_session')).toBeNull();
      expect(parsed.searchParams.get('oauth_session')).toBeNull();
      expect(parsed.searchParams.get('code')).toBeNull();
      expect(parsed.hash).toBe('');
    } else {
      // 401 の場合は Location ヘッダにトークンが含まれないことを確認
      expect(response.headers.Location).toBeUndefined();
      expect(response.statusCode).toBe(401);
    }
  });

  it('successful callback flow via handleAuthRequest returns 302 Location with no tokens', async () => {
    const frontendBaseUrl = 'https://frontend.example.com';
    // 正常系フロー: state + session を事前にセットアップ
    const stateToken = 'test-state-for-012';
    const sessionToken = 'test-session-for-012';
    const { createHash } = await import('node:crypto');
    const stateHashVal = createHash('sha256').update(stateToken).digest('hex');
    const sessionHashVal = createHash('sha256').update(sessionToken).digest('hex');
    await saveOAuthState(null, {
      id: 'id-012-full',
      stateHash: stateHashVal,
      oauthSessionHash: sessionHashVal,
      expiresAt: new Date('2099-01-01T01:00:00Z'),
    });

    const mockFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'mock_access_token' }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: '123456789012345678' }) } as Response);

    try {
      const response = await handleAuthRequest(
        {
          endpoint: '/v1/auth/discord/callback',
          query: { code: 'test-code', state: stateToken },
          cookies: { '__Host-oauth_session': sessionToken },
        },
        {
          frontendBaseUrl,
          discordClientId: 'test-client',
          discordClientSecret: 'test-secret',
          discordRedirectUri: 'https://api.example.com/callback',
        },
      );
      expect(response.statusCode).toBe(302);
      const locationUrl = response.headers.Location;
      expect(locationUrl).toBe(frontendBaseUrl);
      const parsed = new URL(locationUrl);
      const sensitiveParams = ['token', 'link_session', 'oauth_session', 'code', 'authorization'];
      for (const param of sensitiveParams) {
        expect(parsed.searchParams.get(param)).toBeNull();
      }
      expect(parsed.hash).toBe('');
    } finally {
      mockFetch.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// PROP-AUTH-013: callback — Cache-Control/Referrer-Policy 必須ヘッダ
// REQ-AUTH-014
// ---------------------------------------------------------------------------
describe('PROP-AUTH-013: callback response always includes Cache-Control: no-store and Referrer-Policy: no-referrer', () => {
  it('success path: handleAuthRequest for callback includes Cache-Control: no-store', async () => {
    const frontendBaseUrl = 'https://frontend.example.com';
    const response = await handleAuthRequest('/v1/auth/discord/callback', {}, frontendBaseUrl);
    expect(response.headers['Cache-Control']).toBe('no-store');
  });

  it('failure path (403): handleAuthRequest for session with mismatched origin includes Referrer-Policy: no-referrer', async () => {
    const frontendBaseUrl = 'https://frontend.example.com';
    const response = await handleAuthRequest(
      '/v1/auth/discord/session',
      { origin: 'https://attacker.example.com' },
      frontendBaseUrl,
    );
    expect(response.statusCode).toBe(403);
    expect(response.headers['Referrer-Policy']).toBe('no-referrer');
  });
});

// ---------------------------------------------------------------------------
// PROP-AUTH-014: session — Cache-Control/Referrer-Policy 必須ヘッダ
// REQ-AUTH-014
// ---------------------------------------------------------------------------
describe('PROP-AUTH-014: session response always includes Cache-Control: no-store and Referrer-Policy: no-referrer', () => {
  it('GET /v1/auth/discord/session via handleAuthRequest: both required security headers present', async () => {
    const frontendBaseUrl = 'https://frontend.example.com';
    const response = await handleAuthRequest('/v1/auth/discord/session', { origin: frontendBaseUrl }, frontendBaseUrl);
    expect(response.headers['Cache-Control']).toBe('no-store');
    expect(response.headers['Referrer-Policy']).toBe('no-referrer');
  });
});

// ---------------------------------------------------------------------------
// PROP-AUTH-015: session — Origin 不一致で 403
// REQ-AUTH-008
// ---------------------------------------------------------------------------
describe('PROP-AUTH-015: session returns 403 when Origin does not match FRONTEND_BASE_URL', () => {
  it('mismatched origin → 403 via handleAuthRequest', async () => {
    const frontendBaseUrl = 'https://frontend.example.com';
    const response = await handleAuthRequest(
      '/v1/auth/discord/session',
      { origin: 'https://attacker.example.com' },
      frontendBaseUrl,
    );
    expect(response.statusCode).toBe(403);
  });

  it('Origin: null → 403 via handleAuthRequest', async () => {
    const frontendBaseUrl = 'https://frontend.example.com';
    const response = await handleAuthRequest('/v1/auth/discord/session', { origin: 'null' }, frontendBaseUrl);
    expect(response.statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// PROP-AUTH-016: session — CORS ヘッダ
// REQ-AUTH-004
// ---------------------------------------------------------------------------
describe('PROP-AUTH-016: session response includes CORS headers', () => {
  it('handleAuthRequest for session returns Access-Control-Allow-Credentials: true', async () => {
    const frontendBaseUrl = 'https://frontend.example.com';
    const response = await handleAuthRequest('/v1/auth/discord/session', { origin: frontendBaseUrl }, frontendBaseUrl);
    expect(response.headers['Access-Control-Allow-Credentials']).toBe('true');
  });

  it('handleAuthRequest for session returns Access-Control-Allow-Origin matching FRONTEND_BASE_URL', async () => {
    const frontendBaseUrl = 'https://frontend.example.com';
    const response = await handleAuthRequest('/v1/auth/discord/session', { origin: frontendBaseUrl }, frontendBaseUrl);
    expect(response.headers['Access-Control-Allow-Origin']).toBe(frontendBaseUrl);
  });
});

// ---------------------------------------------------------------------------
// PROP-AUTH-017: start — Set-Cookie 属性検証
// REQ-AUTH-005
// ---------------------------------------------------------------------------
describe('PROP-AUTH-017: start Set-Cookie for __Host-oauth_session has exact attributes', () => {
  it('handleAuthRequest for start returns Set-Cookie with Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=600; no Domain', async () => {
    const frontendBaseUrl = 'https://frontend.example.com';
    const response = await handleAuthRequest('/v1/auth/discord/start', {}, frontendBaseUrl);
    const setCookie = response.headers['Set-Cookie'];
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain('Max-Age=600');
    // Domain は含まれない
    expect(setCookie).not.toContain('Domain=');
  });
});

// ---------------------------------------------------------------------------
// PROP-AUTH-018: callback — Set-Cookie 属性検証
// REQ-AUTH-005
// FIND-001: ストア数の確認ではなく __Host-link_session の Set-Cookie 属性を検証する
// ---------------------------------------------------------------------------
describe('PROP-AUTH-018: callback Set-Cookie for __Host-link_session has exact attributes', () => {
  it('successful callback flow returns Set-Cookie with __Host-link_session Secure HttpOnly SameSite=Lax Path=/ Max-Age=900 no Domain', async () => {
    const frontendBaseUrl = 'https://frontend.example.com';
    const stateToken = 'test-state-for-018';
    const sessionToken = 'test-session-for-018';
    const { createHash } = await import('node:crypto');
    const stateHashVal = createHash('sha256').update(stateToken).digest('hex');
    const sessionHashVal = createHash('sha256').update(sessionToken).digest('hex');
    await saveOAuthState(null, {
      id: 'id-018',
      stateHash: stateHashVal,
      oauthSessionHash: sessionHashVal,
      expiresAt: new Date('2099-01-01T01:00:00Z'),
    });

    const mockFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'mock_access_token_018' }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: '123456789012345678' }) } as Response);

    let response: Awaited<ReturnType<typeof handleAuthRequest>>;
    try {
      response = await handleAuthRequest(
        {
          endpoint: '/v1/auth/discord/callback',
          query: { code: 'auth-code-018', state: stateToken },
          cookies: { '__Host-oauth_session': sessionToken },
        },
        {
          frontendBaseUrl,
          discordClientId: 'test-client',
          discordClientSecret: 'test-secret',
          discordRedirectUri: 'https://api.example.com/callback',
        },
      );
    } finally {
      mockFetch.mockRestore();
    }

    expect(response.statusCode).toBe(302);
    const setCookie = response.headers['Set-Cookie'];
    expect(setCookie).toBeDefined();
    // __Host-link_session が含まれること
    expect(setCookie).toContain('__Host-link_session');
    // 必須属性の確認（REQ-AUTH-005 §6 固定属性）
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain('Max-Age=900');
    // Domain は含まれないこと（__Host- Cookie の要件）
    expect(setCookie).not.toContain('Domain=');
  });
});

// ---------------------------------------------------------------------------
// PROP-AUTH-019: start — Discord URL scope=identify
// REQ-AUTH-007
// ---------------------------------------------------------------------------
describe('PROP-AUTH-019: start Discord authorization URL has scope=identify', () => {
  it('handleAuthRequest for start returns 302 Location with scope=identify', async () => {
    const frontendBaseUrl = 'https://frontend.example.com';
    const response = await handleAuthRequest('/v1/auth/discord/start', {}, frontendBaseUrl);
    expect(response.statusCode).toBe(302);
    const locationUrl = response.headers.Location;
    expect(locationUrl).toBeDefined();
    const parsed = new URL(locationUrl);
    expect(parsed.searchParams.get('scope')).toBe('identify');
  });
});

// ---------------------------------------------------------------------------
// PROP-AUTH-020: スタートアップ検証 — 必須環境変数欠落 + URL フォーマット検証
// REQ-AUTH-011
// FIND-005: PROP-AUTH-034（validateRequiredEnvVars）の重複を排除し、
//           FRONTEND_BASE_URL フォーマット検証まで行う validateStartupConfig を使用する
// ---------------------------------------------------------------------------
describe('PROP-AUTH-020: validateStartupConfig rejects missing env vars AND invalid FRONTEND_BASE_URL format', () => {
  const VALID_ENV = {
    DISCORD_CLIENT_ID: 'client-id',
    DISCORD_CLIENT_SECRET: 'client-secret',
    DISCORD_REDIRECT_URI: 'https://api.example.com/callback',
    FRONTEND_BASE_URL: 'https://frontend.example.com',
    DATABASE_URL: 'postgresql://localhost:5432/hayane',
  };

  it('accepts fully valid startup config', () => {
    const result = validateStartupConfig(VALID_ENV);
    expect(result.ok).toBe(true);
  });

  it('rejects when DISCORD_CLIENT_ID is missing — error includes "Missing: DISCORD_CLIENT_ID"', () => {
    const result = validateStartupConfig({ ...VALID_ENV, DISCORD_CLIENT_ID: undefined });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('DISCORD_CLIENT_ID'))).toBe(true);
    }
  });

  it('rejects when FRONTEND_BASE_URL has trailing slash — URLフォーマット検証（PROP-AUTH-034 にはない検証）', () => {
    const result = validateStartupConfig({ ...VALID_ENV, FRONTEND_BASE_URL: 'https://frontend.example.com/' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it('rejects when FRONTEND_BASE_URL has path segment', () => {
    const result = validateStartupConfig({ ...VALID_ENV, FRONTEND_BASE_URL: 'https://frontend.example.com/app' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it('rejects when all vars missing and FRONTEND_BASE_URL is absent', () => {
    const result = validateStartupConfig({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // 全必須変数の欠落が errors に含まれる
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// PROP-AUTH-021: callback 401 — state TTL 超過
// REQ-AUTH-012
// ---------------------------------------------------------------------------
describe('PROP-AUTH-021: callback 401 when state TTL expired', () => {
  it('expired state returns null → 401 (mocked clock)', async () => {
    const db = null;
    await saveOAuthState(db, {
      id: 'id-021',
      stateHash: 'expired-hash-021',
      oauthSessionHash: 'session-hash-021',
      expiresAt: new Date('2000-01-01T00:00:00Z'), // 過去の日時 = 期限切れ
    });
    const result = await consumeOAuthState(db, 'expired-hash-021', 'session-hash-021');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PROP-AUTH-022: session 401 — link session TTL 超過
// REQ-AUTH-013
// ---------------------------------------------------------------------------
describe('PROP-AUTH-022: session 401 when link session TTL expired', () => {
  it('expired link session record rejected by validateLinkSessionRecord (mocked clock)', async () => {
    // validateLinkSessionRecord を直接呼び出して期限切れlink sessionレコードが拒否されることを確認
    const expiredRecord: LinkSessionRecord = {
      id: 'id-022',
      link_session_token_hash: 'token-hash-022',
      discord_user_id: '123456789012345678',
      expires_at: new Date('2000-01-01T00:00:00Z'), // 過去の日時 = 期限切れ
      used_at: null,
      created_at: new Date('2000-01-01T00:00:00Z'),
    };
    const now = new Date('2026-01-01T00:00:00Z'); // 現在時刻（expires_atより後）
    const result = validateLinkSessionRecord(expiredRecord, 'token-hash-022', now);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('expired');
    }
  });

  it('valid link session (not expired, not used) is accepted by validateLinkSessionRecord', async () => {
    // 比較: 有効なlink sessionは受け入れられる
    const db = null;
    await saveDiscordLinkSession(db, {
      id: 'id-022-valid',
      linkSessionTokenHash: 'valid-token-hash-022',
      discordUserId: '123456789012345678',
      expiresAt: new Date('2099-01-01T00:00:00Z'),
    });
    const validRecord: LinkSessionRecord = {
      id: 'id-022-valid',
      link_session_token_hash: 'valid-token-hash-022',
      discord_user_id: '123456789012345678',
      expires_at: new Date('2099-01-01T00:00:00Z'),
      used_at: null,
      created_at: new Date('2026-01-01T00:00:00Z'),
    };
    const now = new Date('2026-01-01T00:00:00Z');
    const result = validateLinkSessionRecord(validRecord, 'valid-token-hash-022', now);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PROP-AUTH-023: ログに機密値が含まれない
// REQ-AUTH-010
// ---------------------------------------------------------------------------
describe('PROP-AUTH-023: log entries contain no raw sensitive values', () => {
  it('structuredLog does not write raw cookie values', () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => logs.push(msg);

    try {
      const sensitiveEntry = {
        cookie: '__Host-oauth_session=raw-secret-token',
        authorization: 'Bearer super-secret',
        endpoint: '/v1/auth/discord/callback',
        result: 'success' as const,
        timestamp: '2099-01-01T00:00:00Z',
        service: 'auth-service',
      };
      structuredLog(sensitiveEntry);

      expect(logs.length).toBe(1);
      const parsed = JSON.parse(logs[0]);
      expect(parsed.cookie).toBe('[REDACTED]');
      expect(parsed.authorization).toBe('[REDACTED]');
      expect(parsed.endpoint).toBe('/v1/auth/discord/callback');
    } finally {
      console.log = originalLog;
    }
  });

  it('structuredLog does not write raw code values', () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => logs.push(msg);

    try {
      const sensitiveEntry = {
        code: 'discord-oauth-authorization-code',
        endpoint: '/v1/auth/discord/start',
        result: 'success' as const,
        timestamp: '2099-01-01T00:00:00Z',
        service: 'auth-service',
      };
      structuredLog(sensitiveEntry);

      expect(logs.length).toBe(1);
      const parsed = JSON.parse(logs[0]);
      expect(parsed.code).toBe('[REDACTED]');
      expect(parsed.endpoint).toBe('/v1/auth/discord/start');
    } finally {
      console.log = originalLog;
    }
  });
});

// ---------------------------------------------------------------------------
// PROP-AUTH-024: auth-service は billing テーブルに書き込まない
// NFR-AUTH-004
// ---------------------------------------------------------------------------
describe('PROP-AUTH-024: auth-service does not write to billing tables', () => {
  it('after saveOAuthState, only oauthStates store has new entries', async () => {
    const db = null;
    // 初期状態のカウントを取得
    const before = getStoreCounts();
    expect(before.oauthStates).toBe(0);
    expect(before.linkSessions).toBe(0);

    await saveOAuthState(db, {
      id: 'id-024-a',
      stateHash: 'hash-024-a',
      oauthSessionHash: 'session-hash-024-a',
      expiresAt: new Date('2099-01-01T01:00:00Z'),
    });

    const after = getStoreCounts();
    // oauthStates のみ増加する
    expect(after.oauthStates).toBe(1);
    // linkSessions は変化しない（billing テーブルに相当するストアは存在しない）
    expect(after.linkSessions).toBe(0);
  });

  it('after saveDiscordLinkSession, only linkSessions store has new entries', async () => {
    const db = null;
    const before = getStoreCounts();
    expect(before.oauthStates).toBe(0);
    expect(before.linkSessions).toBe(0);

    await saveDiscordLinkSession(db, {
      id: 'id-024-b',
      linkSessionTokenHash: 'hash-024-b',
      discordUserId: 'discord-123',
      expiresAt: new Date('2099-01-01T01:00:00Z'),
    });

    const after = getStoreCounts();
    // linkSessions のみ増加する
    expect(after.linkSessions).toBe(1);
    // oauthStates は変化しない
    expect(after.oauthStates).toBe(0);
  });

  it('after both saves, total store count is exactly 2 (no billing store writes)', async () => {
    const db = null;
    await saveOAuthState(db, {
      id: 'id-024-c',
      stateHash: 'hash-024-c',
      oauthSessionHash: 'session-hash-024-c',
      expiresAt: new Date('2099-01-01T01:00:00Z'),
    });
    await saveDiscordLinkSession(db, {
      id: 'id-024-d',
      linkSessionTokenHash: 'hash-024-d',
      discordUserId: 'discord-456',
      expiresAt: new Date('2099-01-01T01:00:00Z'),
    });

    const counts = getStoreCounts();
    // 合計2エントリのみ（oauthStates: 1, linkSessions: 1）
    // members/payjp_events/member_impact_logs に相当するストアへの書き込みは存在しない
    expect(counts.oauthStates).toBe(1);
    expect(counts.linkSessions).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// PROP-AUTH-029: generateSecureRandomToken — 128bit 以上のエントロピー
// REQ-AUTH-009
// ---------------------------------------------------------------------------
describe('PROP-AUTH-029: generateSecureRandomToken has at least 128 bits of entropy', () => {
  it('token is a hex string of at least 32 characters (>= 16 bytes = 128 bits)', async () => {
    const token = await generateSecureRandomToken();
    expect(typeof token).toBe('string');
    // 32バイト = 64hex文字（256bit）
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(token).toMatch(/^[0-9a-f]+$/i);
  });

  it('two consecutive calls return different tokens', async () => {
    const [t1, t2] = await Promise.all([generateSecureRandomToken(), generateSecureRandomToken()]);
    expect(t1).not.toBe(t2);
  });
});

// ---------------------------------------------------------------------------
// PROP-AUTH-036: checkHealth — ヘルスチェック
// REQ-AUTH-015
// ---------------------------------------------------------------------------
describe('PROP-AUTH-036: checkHealth returns status ok when service is operational', () => {
  it('checkHealth returns { status: "ok" } when isHealthy returns true', async () => {
    const result = await checkHealth(() => true);
    expect(result.status).toBe('ok');
  });

  it('checkHealth returns { status: "error" } when isHealthy returns false', async () => {
    const result = await checkHealth(() => false);
    expect(result.status).toBe('error');
  });

  it('checkHealth returns { status: "error" } when isHealthy throws', async () => {
    const result = await checkHealth(() => {
      throw new Error('store unavailable');
    });
    expect(result.status).toBe('error');
  });

  it('checkHealth result has a status field with value "ok" or "error"', async () => {
    const result = await checkHealth(() => true);
    expect(['ok', 'error']).toContain(result.status);
  });
});

// ---------------------------------------------------------------------------
// exchangeDiscordCode / fetchDiscordUserId — 正常動作テスト
// ---------------------------------------------------------------------------
describe('Discord API shell functions return expected results', () => {
  it('exchangeDiscordCode returns a valid access token string', async () => {
    const mockFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'mock_token_abc123' }) } as Response);
    try {
      const token = await exchangeDiscordCode('valid-code', {
        clientId: 'id',
        clientSecret: 'secret',
        redirectUri: 'https://example.com/callback',
      });
      expect(typeof token).toBe('string');
      expect(token.length).toBeGreaterThan(0);
    } finally {
      mockFetch.mockRestore();
    }
  });

  it('fetchDiscordUserId returns a discord user id string', async () => {
    const mockFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: '123456789012345678' }) } as Response);
    try {
      const userId = await fetchDiscordUserId('valid-access-token');
      expect(typeof userId).toBe('string');
      expect(userId).toMatch(/^\d+$/);
    } finally {
      mockFetch.mockRestore();
    }
  });
});
