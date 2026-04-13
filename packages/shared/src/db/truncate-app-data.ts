import type pg from 'pg';

/**
 * 全アプリデータ行を削除（DDL / `schema_migrations` は保持）。
 * 開発・検証用。PAY.JP 側の顧客・購読とは別系統のため、本番では不整合に注意。
 *
 * TRUNCATE 順: FK 依存（子 → 親）。`CASCADE` で参照の残りも解消。
 */
export const TRUNCATE_ALL_APP_DATA_SQL = `
  TRUNCATE member_impact_logs, cancel_form_tokens, member_sessions, payjp_events, discord_link_sessions, oauth_states, access_gate_sessions, invite_sessions, invite_tokens, members
  CASCADE
`;

export async function truncateAllAppData(pool: pg.Pool): Promise<void> {
  await pool.query(TRUNCATE_ALL_APP_DATA_SQL);
}
