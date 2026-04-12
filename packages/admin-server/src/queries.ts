import type { Pool } from 'pg';

export interface AdminOverview {
  membersByStatus: Record<string, number>;
  unresolvedImpactCount: number;
  inflightMemberCount: number;
}

export interface AdminMemberListRow {
  id: string;
  email: string;
  discord_user_id: string | null;
  subscription_status: string | null;
  payjp_plan_id: string | null;
  role_state: string;
  created_at: string;
  last_synced_at: string;
  inflight_operation_id: string | null;
  unresolved_impact_count: number;
}

export interface AdminMemberDetail extends AdminMemberListRow {
  payjp_customer_id: string | null;
  payjp_subscription_id: string | null;
  access_end_at: string | null;
  next_billing_at: string | null;
  cancel_requested_at: string | null;
  inflight_operation_type: string | null;
  inflight_operation_started_at: string | null;
  inflight_subscribe_plan_id: string | null;
  privacy_consented_at: string | null;
  updated_at: string;
}

export interface AdminImpactLogRow {
  id: string;
  member_id: string;
  issue_code: string;
  detail: unknown;
  operation_id: string | null;
  resolved_at: string | null;
  created_at: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Escape `%`, `_`, and `\` for use in a PostgreSQL LIKE/ILIKE pattern with `ESCAPE '\\'`. */
export function escapePgLikePattern(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

export function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

export async function queryAdminOverview(pool: Pool): Promise<AdminOverview> {
  const byStatus = await pool.query<{ subscription_status: string | null; c: string }>(
    `SELECT subscription_status, COUNT(*)::text AS c FROM members GROUP BY subscription_status`,
  );
  const membersByStatus: Record<string, number> = {};
  for (const row of byStatus.rows) {
    const k = row.subscription_status ?? 'null';
    membersByStatus[k] = Number.parseInt(row.c, 10);
  }

  const unresolved = await pool.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM member_impact_logs WHERE resolved_at IS NULL`,
  );
  const inflight = await pool.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM members WHERE inflight_operation_id IS NOT NULL`,
  );

  return {
    membersByStatus,
    unresolvedImpactCount: Number.parseInt(unresolved.rows[0]?.c ?? '0', 10),
    inflightMemberCount: Number.parseInt(inflight.rows[0]?.c ?? '0', 10),
  };
}

export interface MemberListQuery {
  page: number;
  limit: number;
  q: string | null;
  subscriptionStatus: string | null;
  roleState: string | null;
  hasInflight: boolean | null;
}

export async function queryMembersList(
  pool: Pool,
  opts: MemberListQuery,
): Promise<{ rows: AdminMemberListRow[]; total: number }> {
  const page = Math.max(1, opts.page);
  const limit = Math.min(100, Math.max(1, opts.limit));
  const offset = (page - 1) * limit;

  const where: string[] = ['TRUE'];
  const params: unknown[] = [];
  let next = 1;

  if (opts.q?.trim()) {
    const t = opts.q.trim();
    const likePattern = `%${escapePgLikePattern(t)}%`;
    where.push(
      `(m.email ILIKE $${next} ESCAPE '\\' OR m.id::text = $${next + 1} OR m.discord_user_id = $${next + 2} OR m.payjp_customer_id = $${next + 3} OR m.payjp_subscription_id = $${next + 4} OR m.inflight_operation_id = $${next + 5})`,
    );
    params.push(likePattern, t, t, t, t, t);
    next += 6;
  }
  if (opts.subscriptionStatus?.trim()) {
    where.push(`m.subscription_status IS NOT DISTINCT FROM $${next}::text`);
    params.push(opts.subscriptionStatus.trim());
    next += 1;
  }
  if (opts.roleState?.trim()) {
    where.push(`m.role_state = $${next}`);
    params.push(opts.roleState.trim());
    next += 1;
  }
  if (opts.hasInflight === true) {
    where.push('(m.inflight_operation_id IS NOT NULL)');
  } else if (opts.hasInflight === false) {
    where.push('(m.inflight_operation_id IS NULL)');
  }

  const whereSql = where.join(' AND ');

  const countRes = await pool.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM members m WHERE ${whereSql}`,
    params,
  );
  const total = Number.parseInt(countRes.rows[0]?.c ?? '0', 10);

  const listParams = [...params, limit, offset];
  const limIdx = params.length + 1;
  const offIdx = params.length + 2;

  const listSql = `
    SELECT
      m.id,
      m.email,
      m.discord_user_id,
      m.subscription_status,
      m.payjp_plan_id,
      m.role_state,
      m.created_at,
      m.last_synced_at,
      m.inflight_operation_id,
      COALESCE((
        SELECT COUNT(*)::int FROM member_impact_logs mil
        WHERE mil.member_id = m.id AND mil.resolved_at IS NULL
      ), 0) AS unresolved_impact_count
    FROM members m
    WHERE ${whereSql}
    ORDER BY m.created_at DESC
    LIMIT $${limIdx} OFFSET $${offIdx}
  `;

  const listRes = await pool.query<AdminMemberListRow>(listSql, listParams);
  return { rows: listRes.rows, total };
}

export async function queryMemberDetail(pool: Pool, memberId: string): Promise<AdminMemberDetail | null> {
  const res = await pool.query<AdminMemberDetail>(
    `
    SELECT
      m.id,
      m.email,
      m.discord_user_id,
      m.subscription_status,
      m.payjp_plan_id,
      m.role_state,
      m.created_at,
      m.last_synced_at,
      m.inflight_operation_id,
      COALESCE((
        SELECT COUNT(*)::int FROM member_impact_logs mil
        WHERE mil.member_id = m.id AND mil.resolved_at IS NULL
      ), 0) AS unresolved_impact_count,
      m.payjp_customer_id,
      m.payjp_subscription_id,
      m.access_end_at,
      m.next_billing_at,
      m.cancel_requested_at,
      m.inflight_operation_type,
      m.inflight_operation_started_at,
      m.inflight_subscribe_plan_id,
      m.privacy_consented_at,
      m.updated_at
    FROM members m
    WHERE m.id = $1::uuid
    `,
    [memberId],
  );
  return res.rows[0] ?? null;
}

export type ImpactLogFilterMode = 'unresolved' | 'resolved' | 'all';

export async function queryMemberImpactLogs(
  pool: Pool,
  memberId: string,
  mode: ImpactLogFilterMode,
): Promise<AdminImpactLogRow[]> {
  let filter = '';
  if (mode === 'unresolved') filter = 'AND resolved_at IS NULL';
  else if (mode === 'resolved') filter = 'AND resolved_at IS NOT NULL';
  const res = await pool.query<AdminImpactLogRow>(
    `
    SELECT id, member_id, issue_code, detail, operation_id, resolved_at, created_at
    FROM member_impact_logs
    WHERE member_id = $1::uuid
    ${filter}
    ORDER BY created_at DESC
    LIMIT 500
    `,
    [memberId],
  );
  return res.rows;
}
