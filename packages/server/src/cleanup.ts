import './load-env.js';
import { createPgPool } from '@hayane/shared';
import pg from 'pg';

/**
 * DB クリーンアップスクリプト — PCI DSS Req 3.2.1 データ保持ポリシー準拠
 *
 * 対象テーブルと保持ポリシー:
 * - oauth_states: expires_at 経過後即削除
 * - discord_link_sessions: expires_at 経過後即削除
 * - access_gate_sessions: expires_at 経過後即削除
 * - invite_sessions / invite_tokens: レガシーDDL互換のため残存する場合のみ期限切れ削除
 * - payjp_events: received_at から90日経過後削除
 * - member_impact_logs: resolved_at から90日経過後削除（未解決は保持）
 */
async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: databaseUrl });
  const db = createPgPool(pool);

  try {
    const results = await db.withTransaction(async (query) => {
      const expired_oauth = await query('DELETE FROM oauth_states WHERE expires_at < NOW()');
      const expired_sessions = await query('DELETE FROM discord_link_sessions WHERE expires_at < NOW()');
      const expired_access_gate_sessions = await query('DELETE FROM access_gate_sessions WHERE expires_at < NOW()');
      const old_events = await query("DELETE FROM payjp_events WHERE received_at < NOW() - INTERVAL '90 days'");
      const old_logs = await query(
        "DELETE FROM member_impact_logs WHERE resolved_at IS NOT NULL AND resolved_at < NOW() - INTERVAL '90 days'",
      );
      return {
        oauth_states: expired_oauth.rowCount,
        discord_link_sessions: expired_sessions.rowCount,
        access_gate_sessions: expired_access_gate_sessions.rowCount,
        payjp_events: old_events.rowCount,
        member_impact_logs: old_logs.rowCount,
      };
    });

    let invite_sessions = 0;
    let invite_tokens = 0;
    try {
      const r1 = await pool.query('DELETE FROM invite_sessions WHERE expires_at < NOW()');
      invite_sessions = r1.rowCount ?? 0;
    } catch (e) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          service: 'cleanup',
          message: 'invite_sessions cleanup skipped (table missing or error)',
          error: e instanceof Error ? e.message : String(e),
          timestamp: new Date().toISOString(),
        }),
      );
    }
    try {
      const r2 = await pool.query('DELETE FROM invite_tokens WHERE expires_at < NOW()');
      invite_tokens = r2.rowCount ?? 0;
    } catch (e) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          service: 'cleanup',
          message: 'invite_tokens cleanup skipped (table missing or error)',
          error: e instanceof Error ? e.message : String(e),
          timestamp: new Date().toISOString(),
        }),
      );
    }

    console.log(
      JSON.stringify({
        level: 'info',
        service: 'cleanup',
        message: 'Database cleanup completed',
        deleted: { ...results, invite_sessions, invite_tokens },
        timestamp: new Date().toISOString(),
      }),
    );
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        service: 'cleanup',
        message: 'Database cleanup failed',
        error: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      }),
    );
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
