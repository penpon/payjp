/**
 * Test-only utilities for auth-service.
 * Do not import from application or library production code.
 */
import type { LinkSessionRecord, OAuthStateRecord } from '@hayane/shared';
import { validateOAuthStateRecord } from './core/index.js';
import type { AuthDb } from './shell/index.js';

/** In-memory AuthDb implementation for unit/integration tests */
export function createInMemoryAuthDb(): AuthDb {
  const oauthStates = new Map<string, OAuthStateRecord>();
  const linkSessions = new Map<string, LinkSessionRecord>();

  return {
    async insertOAuthState(record) {
      const storeRecord: OAuthStateRecord = {
        id: crypto.randomUUID(),
        state_hash: record.stateHash,
        oauth_session_hash: record.oauthSessionHash,
        expires_at: record.expiresAt,
        used_at: null,
        created_at: new Date(),
      };
      oauthStates.set(record.stateHash, storeRecord);
      return storeRecord;
    },
    async consumeOAuthState(stateHash, sessionHash, now) {
      const record = oauthStates.get(stateHash);
      if (!record) return null;
      const validation = validateOAuthStateRecord(record, sessionHash, stateHash, now);
      if (!validation.ok) return null;
      record.used_at = now;
      return record;
    },
    async insertDiscordLinkSession(record) {
      const storeRecord: LinkSessionRecord = {
        id: crypto.randomUUID(),
        link_session_token_hash: record.linkSessionTokenHash,
        discord_user_id: record.discordUserId,
        discord_access_token_encrypted: record.discordAccessTokenEncrypted ?? null,
        expires_at: record.expiresAt,
        used_at: null,
        created_at: new Date(),
      };
      linkSessions.set(record.linkSessionTokenHash, storeRecord);
      return storeRecord;
    },
    async findLinkSession(tokenHash) {
      return linkSessions.get(tokenHash) ?? null;
    },
  };
}
