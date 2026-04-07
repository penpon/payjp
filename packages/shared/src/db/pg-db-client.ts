import type pg from 'pg';
import type { LinkSessionRecord, Member, OAuthStateRecord } from '../types.js';

export interface DbClient {
  findMemberByDiscordUserId(discordUserId: string): Promise<Member | null>;
  upsertProvisionalMember(discordUserId: string, email: string): Promise<Member>;
  findLinkSession(tokenHash: string): Promise<LinkSessionRecord | null>;
  consumeLinkSession(tokenHash: string, now: Date): Promise<void>;
  setInflightOperation(
    memberId: string,
    operationId: string,
    operationType: 'subscribe' | 'cancel',
    now: Date,
  ): Promise<void>;
  clearInflightOperation(memberId: string): Promise<void>;
  updateMemberCustomerId(memberId: string, payjpCustomerId: string): Promise<void>;
  updateMemberChargeId(memberId: string, chargeId: string, paidAt: Date): Promise<void>;
  updateMemberAfterSubscribe(
    memberId: string,
    params: {
      payjp_initial_charge_id: string | null;
      initial_charge_paid_at: Date | null;
      payjp_subscription_id: string;
      payjp_plan_id: string;
      subscription_status: 'active' | 'trial';
      first_trial_granted_at: Date | null;
      access_end_at: Date;
      next_billing_at: Date;
      role_state: 'granted' | 'unknown';
      last_synced_at: Date;
      privacy_consented_at: Date;
    },
  ): Promise<Member>;
  updateMemberRoleState(memberId: string, roleState: 'granted' | 'revoked' | 'unknown'): Promise<void>;
  updateMemberAfterCancel(
    memberId: string,
    params: {
      cancel_requested_at: Date;
      subscription_status: 'canceled';
      access_end_at: Date;
      inflight_operation_id: null;
      inflight_operation_type: null;
      inflight_operation_started_at: null;
    },
  ): Promise<Member>;
  acquireAdvisoryLock(discordUserId: string): Promise<boolean>;
  releaseAdvisoryLock(discordUserId: string): Promise<void>;
  withTransactionLock<T>(discordUserId: string, fn: (txDb: TransactionDbClient) => Promise<T>): Promise<T>;
}

/** Subset of DbClient available inside a transaction (no nested transactions/locks) */
export interface TransactionDbClient {
  findMemberByDiscordUserId(discordUserId: string): Promise<Member | null>;
  upsertProvisionalMember(discordUserId: string, email: string): Promise<Member>;
  findLinkSession(tokenHash: string): Promise<LinkSessionRecord | null>;
  consumeLinkSession(tokenHash: string, now: Date): Promise<void>;
  setInflightOperation(
    memberId: string,
    operationId: string,
    operationType: 'subscribe' | 'cancel',
    now: Date,
  ): Promise<void>;
  clearInflightOperation(memberId: string): Promise<void>;
  updateMemberCustomerId(memberId: string, payjpCustomerId: string): Promise<void>;
  updateMemberChargeId(memberId: string, chargeId: string, paidAt: Date): Promise<void>;
  updateMemberAfterSubscribe(
    memberId: string,
    params: Parameters<DbClient['updateMemberAfterSubscribe']>[1],
  ): Promise<Member>;
  updateMemberAfterCancel(
    memberId: string,
    params: Parameters<DbClient['updateMemberAfterCancel']>[1],
  ): Promise<Member>;
  updateMemberRoleState(memberId: string, roleState: 'granted' | 'revoked' | 'unknown'): Promise<void>;
}

// --- Row mapping helpers ---

function assertString(v: unknown, field: string): string {
  if (typeof v !== 'string') throw new Error(`DB field "${field}" expected string, got ${typeof v}`);
  return v;
}

function toMember(row: Record<string, unknown>): Member {
  return {
    id: assertString(row.id, 'id'),
    discord_user_id: assertString(row.discord_user_id, 'discord_user_id'),
    email: assertString(row.email, 'email'),
    payjp_customer_id: (row.payjp_customer_id as string) ?? null,
    payjp_subscription_id: (row.payjp_subscription_id as string) ?? null,
    payjp_initial_charge_id: (row.payjp_initial_charge_id as string) ?? null,
    payjp_plan_id: (row.payjp_plan_id as string) ?? null,
    subscription_status: (row.subscription_status as Member['subscription_status']) ?? null,
    first_trial_granted_at: (row.first_trial_granted_at as Date) ?? null,
    initial_charge_paid_at: (row.initial_charge_paid_at as Date) ?? null,
    cancel_requested_at: (row.cancel_requested_at as Date) ?? null,
    inflight_operation_id: (row.inflight_operation_id as string) ?? null,
    inflight_operation_type: (row.inflight_operation_type as Member['inflight_operation_type']) ?? null,
    inflight_operation_started_at: (row.inflight_operation_started_at as Date) ?? null,
    privacy_consented_at: (row.privacy_consented_at as Date) ?? null,
    access_end_at: (row.access_end_at as Date) ?? null,
    next_billing_at: (row.next_billing_at as Date) ?? null,
    role_state: row.role_state as Member['role_state'],
    last_synced_at: row.last_synced_at as Date,
    last_payjp_event_created_at:
      row.last_payjp_event_created_at != null ? Number(row.last_payjp_event_created_at) : null,
    created_at: row.created_at as Date,
    updated_at: row.updated_at as Date,
  };
}

function toOAuthState(row: Record<string, unknown>): OAuthStateRecord {
  return {
    id: row.id as string,
    state_hash: row.state_hash as string,
    oauth_session_hash: row.oauth_session_hash as string,
    expires_at: row.expires_at as Date,
    used_at: (row.used_at as Date) ?? null,
    created_at: row.created_at as Date,
  };
}

function toLinkSession(row: Record<string, unknown>): LinkSessionRecord {
  return {
    id: row.id as string,
    link_session_token_hash: row.link_session_token_hash as string,
    discord_user_id: row.discord_user_id as string,
    expires_at: row.expires_at as Date,
    used_at: (row.used_at as Date) ?? null,
    created_at: row.created_at as Date,
  };
}

// --- Shared query functions (used by both PgDbClient and PgTransactionClient) ---
// pg.Pool and pg.PoolClient both implement .query(), so we use a common Queryable type.

type Queryable = Pick<pg.Pool, 'query'>;

async function queryFindMemberByDiscordUserId(q: Queryable, discordUserId: string): Promise<Member | null> {
  const result = await q.query('SELECT * FROM members WHERE discord_user_id = $1', [discordUserId]);
  return result.rows[0] ? toMember(result.rows[0] as Record<string, unknown>) : null;
}

async function queryUpsertProvisionalMember(q: Queryable, discordUserId: string, email: string): Promise<Member> {
  const result = await q.query(
    `INSERT INTO members (discord_user_id, email, role_state, last_synced_at)
     VALUES ($1, $2, 'unknown', now())
     ON CONFLICT (discord_user_id)
     DO UPDATE SET email = EXCLUDED.email, updated_at = now()
     RETURNING *`,
    [discordUserId, email],
  );
  return toMember(result.rows[0] as Record<string, unknown>);
}

async function queryFindLinkSession(q: Queryable, tokenHash: string): Promise<LinkSessionRecord | null> {
  const result = await q.query('SELECT * FROM discord_link_sessions WHERE link_session_token_hash = $1', [tokenHash]);
  return result.rows[0] ? toLinkSession(result.rows[0] as Record<string, unknown>) : null;
}

async function queryConsumeLinkSession(q: Queryable, tokenHash: string, now: Date): Promise<void> {
  const result = await q.query(
    `UPDATE discord_link_sessions SET used_at = $2
     WHERE link_session_token_hash = $1
       AND used_at IS NULL
       AND expires_at > $2`,
    [tokenHash, now],
  );
  if ((result.rowCount ?? 0) === 0) {
    throw new Error('Link session not found, already consumed, or expired');
  }
}

async function querySetInflightOperation(
  q: Queryable,
  memberId: string,
  operationId: string,
  operationType: 'subscribe' | 'cancel',
  now: Date,
): Promise<void> {
  const result = await q.query(
    `UPDATE members
     SET inflight_operation_id = $2,
         inflight_operation_type = $3,
         inflight_operation_started_at = $4,
         updated_at = now()
     WHERE id = $1 AND inflight_operation_id IS NULL`,
    [memberId, operationId, operationType, now],
  );
  if ((result.rowCount ?? 0) === 0) {
    throw new Error(`Member not found or inflight operation already set: ${memberId}`);
  }
}

async function queryClearInflightOperation(q: Queryable, memberId: string): Promise<void> {
  const result = await q.query(
    `UPDATE members
     SET inflight_operation_id = NULL,
         inflight_operation_type = NULL,
         inflight_operation_started_at = NULL,
         updated_at = now()
     WHERE id = $1`,
    [memberId],
  );
  if ((result.rowCount ?? 0) === 0) {
    throw new Error(`Member not found: ${memberId}`);
  }
}

async function queryUpdateMemberRoleState(q: Queryable, memberId: string, roleState: string): Promise<void> {
  const result = await q.query('UPDATE members SET role_state = $2, updated_at = now() WHERE id = $1', [
    memberId,
    roleState,
  ]);
  if ((result.rowCount ?? 0) === 0) {
    throw new Error(`Member not found: ${memberId}`);
  }
}

async function queryUpdateMemberCustomerId(q: Queryable, memberId: string, payjpCustomerId: string): Promise<void> {
  const result = await q.query('UPDATE members SET payjp_customer_id = $2, updated_at = now() WHERE id = $1', [
    memberId,
    payjpCustomerId,
  ]);
  if ((result.rowCount ?? 0) === 0) {
    throw new Error(`Member not found: ${memberId}`);
  }
}

async function queryUpdateMemberChargeId(
  q: Queryable,
  memberId: string,
  chargeId: string,
  paidAt: Date,
): Promise<void> {
  const result = await q.query(
    'UPDATE members SET payjp_initial_charge_id = $2, initial_charge_paid_at = $3, updated_at = now() WHERE id = $1',
    [memberId, chargeId, paidAt],
  );
  if ((result.rowCount ?? 0) === 0) {
    throw new Error(`Member not found: ${memberId}`);
  }
}

async function queryUpdateMemberAfterSubscribe(
  q: Queryable,
  memberId: string,
  params: Parameters<DbClient['updateMemberAfterSubscribe']>[1],
): Promise<Member> {
  const result = await q.query(
    `UPDATE members SET
       payjp_initial_charge_id = $2,
       initial_charge_paid_at = $3,
       payjp_subscription_id = $4,
       payjp_plan_id = $5,
       subscription_status = $6,
       first_trial_granted_at = $7,
       access_end_at = $8,
       next_billing_at = $9,
       role_state = $10,
       last_synced_at = $11,
       privacy_consented_at = $12,
       updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [
      memberId,
      params.payjp_initial_charge_id,
      params.initial_charge_paid_at,
      params.payjp_subscription_id,
      params.payjp_plan_id,
      params.subscription_status,
      params.first_trial_granted_at,
      params.access_end_at,
      params.next_billing_at,
      params.role_state,
      params.last_synced_at,
      params.privacy_consented_at,
    ],
  );
  if (!result.rows[0]) throw new Error(`Member not found: ${memberId}`);
  return toMember(result.rows[0] as Record<string, unknown>);
}

async function queryUpdateMemberAfterCancel(
  q: Queryable,
  memberId: string,
  params: Parameters<DbClient['updateMemberAfterCancel']>[1],
): Promise<Member> {
  const result = await q.query(
    `UPDATE members SET
       cancel_requested_at = $2,
       subscription_status = $3,
       access_end_at = $4,
       inflight_operation_id = NULL,
       inflight_operation_type = NULL,
       inflight_operation_started_at = NULL,
       updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [memberId, params.cancel_requested_at, params.subscription_status, params.access_end_at],
  );
  if (!result.rows[0]) throw new Error(`Member not found: ${memberId}`);
  return toMember(result.rows[0] as Record<string, unknown>);
}

// --- PgDbClient (pool-based, with advisory lock support) ---

export class PgDbClient implements DbClient {
  // Session-scoped advisory locks keyed by discord user id.
  // Used by subscribe/cancel for cross-API-call locking.
  // withTransactionLock is available for transaction-scoped locking (e.g. webhook).
  private lockClients = new Map<string, pg.PoolClient>();

  constructor(private pool: pg.Pool) {}

  findMemberByDiscordUserId(discordUserId: string) {
    return queryFindMemberByDiscordUserId(this.pool, discordUserId);
  }
  upsertProvisionalMember(discordUserId: string, email: string) {
    return queryUpsertProvisionalMember(this.pool, discordUserId, email);
  }
  findLinkSession(tokenHash: string) {
    return queryFindLinkSession(this.pool, tokenHash);
  }
  consumeLinkSession(tokenHash: string, now: Date) {
    return queryConsumeLinkSession(this.pool, tokenHash, now);
  }
  setInflightOperation(memberId: string, operationId: string, operationType: 'subscribe' | 'cancel', now: Date) {
    return querySetInflightOperation(this.pool, memberId, operationId, operationType, now);
  }
  clearInflightOperation(memberId: string) {
    return queryClearInflightOperation(this.pool, memberId);
  }
  updateMemberCustomerId(memberId: string, payjpCustomerId: string) {
    return queryUpdateMemberCustomerId(this.pool, memberId, payjpCustomerId);
  }
  updateMemberChargeId(memberId: string, chargeId: string, paidAt: Date) {
    return queryUpdateMemberChargeId(this.pool, memberId, chargeId, paidAt);
  }
  updateMemberAfterSubscribe(memberId: string, params: Parameters<DbClient['updateMemberAfterSubscribe']>[1]) {
    return queryUpdateMemberAfterSubscribe(this.pool, memberId, params);
  }
  updateMemberAfterCancel(memberId: string, params: Parameters<DbClient['updateMemberAfterCancel']>[1]) {
    return queryUpdateMemberAfterCancel(this.pool, memberId, params);
  }
  updateMemberRoleState(memberId: string, roleState: 'granted' | 'revoked' | 'unknown') {
    return queryUpdateMemberRoleState(this.pool, memberId, roleState);
  }

  async acquireAdvisoryLock(discordUserId: string): Promise<boolean> {
    if (this.lockClients.has(discordUserId)) {
      return false;
    }
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ pg_try_advisory_lock: boolean }>(
        'SELECT pg_try_advisory_lock(0, hashtext($1))',
        [discordUserId],
      );
      if (result.rows[0].pg_try_advisory_lock) {
        this.lockClients.set(discordUserId, client);
        return true;
      }
      client.release();
      return false;
    } catch (err) {
      client.release();
      throw err;
    }
  }

  async releaseAdvisoryLock(discordUserId: string): Promise<void> {
    const client = this.lockClients.get(discordUserId);
    if (!client) {
      if (this.lockClients.size > 0) {
        const heldKeys = Array.from(this.lockClients.keys()).join(', ');
        throw new Error(`Lock key mismatch: holding "${heldKeys}", tried to release "${discordUserId}"`);
      }
      throw new Error('No advisory lock is currently held');
    }
    this.lockClients.delete(discordUserId);
    try {
      await client.query('SELECT pg_advisory_unlock(0, hashtext($1))', [discordUserId]);
    } finally {
      client.release();
    }
  }

  async withTransactionLock<T>(discordUserId: string, fn: (txDb: TransactionDbClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(0, hashtext($1))', [discordUserId]);
      const txDb = new PgTransactionClient(client);
      const result = await fn(txDb);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        console.error(
          JSON.stringify({
            level: 'error',
            message: 'ROLLBACK failed after transaction error',
            rollbackError: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
            originalError: err instanceof Error ? err.message : String(err),
            lockKey: discordUserId,
          }),
        );
      }
      throw err;
    } finally {
      client.release();
    }
  }

  // --- oauth_states ---

  async insertOAuthState(record: {
    stateHash: string;
    oauthSessionHash: string;
    expiresAt: Date;
  }): Promise<OAuthStateRecord> {
    const result = await this.pool.query(
      `INSERT INTO oauth_states (state_hash, oauth_session_hash, expires_at)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [record.stateHash, record.oauthSessionHash, record.expiresAt],
    );
    return toOAuthState(result.rows[0] as Record<string, unknown>);
  }

  // Atomic consume: WHERE conditions prevent TOCTOU races
  async consumeOAuthState(stateHash: string, sessionHash: string, now: Date): Promise<OAuthStateRecord | null> {
    const result = await this.pool.query(
      `UPDATE oauth_states SET used_at = $3
       WHERE state_hash = $1
         AND oauth_session_hash = $2
         AND used_at IS NULL
         AND expires_at > $3
       RETURNING *`,
      [stateHash, sessionHash, now],
    );
    return result.rows[0] ? toOAuthState(result.rows[0] as Record<string, unknown>) : null;
  }

  // --- payjp_events ---

  async findPayjpEventById(eventId: string): Promise<{
    id: string;
    event_type: string;
    processing_result: string;
    received_at: Date;
  } | null> {
    const result = await this.pool.query(
      'SELECT id, event_type, processing_result, received_at FROM payjp_events WHERE id = $1',
      [eventId],
    );
    if (!result.rows[0]) return null;
    const row = result.rows[0] as Record<string, unknown>;
    return {
      id: row.id as string,
      event_type: row.event_type as string,
      processing_result: row.processing_result as string,
      received_at: row.received_at as Date,
    };
  }

  async insertPayjpEvent(event: {
    id: string;
    event_type: string;
    payload: unknown;
    processing_result: 'processed' | 'ignored' | 'failed';
    data_metadata_operation_id?: string | null;
    member_id?: string | null;
  }): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO payjp_events (id, event_type, payload, processing_result, data_metadata_operation_id, member_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO NOTHING`,
      [
        event.id,
        event.event_type,
        JSON.stringify(event.payload),
        event.processing_result,
        event.data_metadata_operation_id ?? null,
        event.member_id ?? null,
      ],
    );
    return (result.rowCount ?? 0) > 0;
  }

  // --- member_impact_logs ---

  async insertMemberImpactLog(log: {
    member_id: string;
    issue_code: string;
    detail?: unknown;
    operation_id?: string;
  }): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO member_impact_logs (member_id, issue_code, detail, operation_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (member_id, issue_code) WHERE resolved_at IS NULL DO NOTHING`,
      [log.member_id, log.issue_code, log.detail ? JSON.stringify(log.detail) : null, log.operation_id ?? null],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async resolveMemberImpactLog(memberId: string, issueCode: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE member_impact_logs SET resolved_at = now()
       WHERE member_id = $1 AND issue_code = $2 AND resolved_at IS NULL`,
      [memberId, issueCode],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async findUnresolvedImpactLogs(memberId: string): Promise<
    Array<{
      id: string;
      member_id: string;
      issue_code: string;
      detail: unknown;
      operation_id: string | null;
      created_at: Date;
    }>
  > {
    const result = await this.pool.query(
      `SELECT id, member_id, issue_code, detail, operation_id, created_at
       FROM member_impact_logs
       WHERE member_id = $1 AND resolved_at IS NULL`,
      [memberId],
    );
    return result.rows.map((row) => {
      const r = row as Record<string, unknown>;
      return {
        id: r.id as string,
        member_id: r.member_id as string,
        issue_code: r.issue_code as string,
        detail: r.detail,
        operation_id: (r.operation_id as string) ?? null,
        created_at: r.created_at as Date,
      };
    });
  }
}

// --- PgTransactionClient (delegates to shared query functions) ---

class PgTransactionClient implements TransactionDbClient {
  constructor(private client: pg.PoolClient) {}

  findMemberByDiscordUserId(discordUserId: string) {
    return queryFindMemberByDiscordUserId(this.client, discordUserId);
  }
  upsertProvisionalMember(discordUserId: string, email: string) {
    return queryUpsertProvisionalMember(this.client, discordUserId, email);
  }
  findLinkSession(tokenHash: string) {
    return queryFindLinkSession(this.client, tokenHash);
  }
  consumeLinkSession(tokenHash: string, now: Date) {
    return queryConsumeLinkSession(this.client, tokenHash, now);
  }
  setInflightOperation(memberId: string, operationId: string, operationType: 'subscribe' | 'cancel', now: Date) {
    return querySetInflightOperation(this.client, memberId, operationId, operationType, now);
  }
  clearInflightOperation(memberId: string) {
    return queryClearInflightOperation(this.client, memberId);
  }
  updateMemberCustomerId(memberId: string, payjpCustomerId: string) {
    return queryUpdateMemberCustomerId(this.client, memberId, payjpCustomerId);
  }
  updateMemberChargeId(memberId: string, chargeId: string, paidAt: Date) {
    return queryUpdateMemberChargeId(this.client, memberId, chargeId, paidAt);
  }
  updateMemberAfterSubscribe(memberId: string, params: Parameters<DbClient['updateMemberAfterSubscribe']>[1]) {
    return queryUpdateMemberAfterSubscribe(this.client, memberId, params);
  }
  updateMemberAfterCancel(memberId: string, params: Parameters<DbClient['updateMemberAfterCancel']>[1]) {
    return queryUpdateMemberAfterCancel(this.client, memberId, params);
  }
  updateMemberRoleState(memberId: string, roleState: 'granted' | 'revoked' | 'unknown') {
    return queryUpdateMemberRoleState(this.client, memberId, roleState);
  }
}
