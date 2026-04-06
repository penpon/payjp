import type { OAuthStateRecord, LinkSessionRecord } from '@hayane/shared';

// Green フェーズ用インメモリストア — 実 DB 接続前の代替実装
// REQ-AUTH-003: consumeOAuthState の原子性はロックで担保

const oauthStates = new Map<string, OAuthStateRecord>();
const linkSessions = new Map<string, LinkSessionRecord>();

export function getOAuthStore(): Map<string, OAuthStateRecord> {
  return oauthStates;
}

export function getLinkSessionStore(): Map<string, LinkSessionRecord> {
  return linkSessions;
}

export function clearStores(): void {
  oauthStates.clear();
  linkSessions.clear();
}

// PROP-AUTH-035 対象: getStoreCounts
// NFR-AUTH-004: auth-service はauth関連ストアにのみ書き込む
export function getStoreCounts(): { oauthStates: number; linkSessions: number } {
  return {
    oauthStates: oauthStates.size,
    linkSessions: linkSessions.size,
  };
}
