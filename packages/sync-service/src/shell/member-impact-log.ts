/**
 * member_impact_logs helpers — shared by webhook handler and resync CLI.
 * Aligns with packages/shared/src/db/pg-db-client.ts insertMemberImpactLog SQL.
 */
import type { DbPool } from './types.js';

export const ROLE_SYNC_FAILED_WEBHOOK = 'role_sync_failed_webhook';

export async function insertImpactLog(
  db: DbPool,
  memberId: string,
  issueCode: string,
  operationId?: string,
  detail?: unknown,
): Promise<void> {
  await db.query(
    `INSERT INTO member_impact_logs (member_id, issue_code, detail, operation_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (member_id, issue_code) WHERE resolved_at IS NULL DO NOTHING`,
    [memberId, issueCode, detail !== undefined ? JSON.stringify(detail) : null, operationId ?? null],
  );
}

export async function resolveImpactLog(db: DbPool, memberId: string, issueCode: string): Promise<void> {
  await db.query(
    `UPDATE member_impact_logs
     SET resolved_at = now()
     WHERE member_id = $1 AND issue_code = $2 AND resolved_at IS NULL`,
    [memberId, issueCode],
  );
}
