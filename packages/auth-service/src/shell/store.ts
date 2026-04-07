import type { LinkSessionRecord, OAuthStateRecord } from '@hayane/shared';

// Green フェーズ用インメモリストア — 実 DB 接続前の代替実装
// REQ-AUTH-003: consumeOAuthState の原子性はロックで担保

const MAX_STORE_SIZE = 10_000;
const EVICTION_INTERVAL_MS = 60_000; // 1 minute

const oauthStates = new Map<string, OAuthStateRecord>();
const linkSessions = new Map<string, LinkSessionRecord>();

/** Remove expired entries and enforce size cap (evicts oldest entries first) */
function evictExpired<T extends { expires_at: Date }>(store: Map<string, T>): void {
  const now = new Date();
  for (const [key, record] of store) {
    if (record.expires_at <= now) {
      store.delete(key);
    }
  }
  // If still over capacity after TTL eviction, remove oldest entries (FIFO order of Map)
  if (store.size > MAX_STORE_SIZE) {
    const excess = store.size - MAX_STORE_SIZE;
    const keys = store.keys();
    for (let i = 0; i < excess; i++) {
      const { value, done } = keys.next();
      if (done) break;
      store.delete(value);
    }
  }
}

// Periodic eviction timer (unref'd so it doesn't block process exit)
const evictionTimer = setInterval(() => {
  evictExpired(oauthStates);
  evictExpired(linkSessions);
}, EVICTION_INTERVAL_MS);
evictionTimer.unref();

export function getOAuthStore(): Map<string, OAuthStateRecord> {
  // Evict on access to enforce TTL before reads
  if (oauthStates.size > MAX_STORE_SIZE) {
    evictExpired(oauthStates);
  }
  return oauthStates;
}

export function getLinkSessionStore(): Map<string, LinkSessionRecord> {
  if (linkSessions.size > MAX_STORE_SIZE) {
    evictExpired(linkSessions);
  }
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
