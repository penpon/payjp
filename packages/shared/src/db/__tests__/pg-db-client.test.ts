import type pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../migrate.js';
import { PgDbClient } from '../pg-db-client.js';
import { closePool, createPool } from '../pool.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://localhost:5432/hayane_test';

let pool: pg.Pool;
let db: PgDbClient;
let dbAvailable = false;

async function cleanDatabase() {
  await pool.query(
    'TRUNCATE cancel_form_tokens, member_sessions, members, payjp_events, oauth_states, discord_link_sessions, member_impact_logs CASCADE',
  );
}

beforeAll(async () => {
  pool = createPool(DATABASE_URL);
  try {
    await runMigrations(pool);
    db = new PgDbClient(pool);
    dbAvailable = true;
  } catch {
    // DB not available — tests will be skipped
  }
});

beforeEach((ctx) => {
  if (!dbAvailable) ctx.skip();
});

afterEach(async () => {
  if (dbAvailable) await cleanDatabase();
});

afterAll(async () => {
  if (dbAvailable) await closePool(pool);
});

describe('PgDbClient - members CRUD', () => {
  it('upsertProvisionalMember inserts a new member', async () => {
    const member = await db.upsertProvisionalMember('discord-001', 'test@example.com');
    expect(member.discord_user_id).toBe('discord-001');
    expect(member.email).toBe('test@example.com');
    expect(member.role_state).toBe('unknown');
    expect(member.subscription_status).toBeNull();
    expect(member.id).toBeTruthy();
  });

  it('upsertProvisionalMember updates email on conflict', async () => {
    await db.upsertProvisionalMember('discord-002', 'first@example.com');
    const updated = await db.upsertProvisionalMember('discord-002', 'second@example.com');
    expect(updated.email).toBe('second@example.com');
  });

  it('findMemberByDiscordUserId returns member', async () => {
    await db.upsertProvisionalMember('discord-003', 'find@example.com');
    const found = await db.findMemberByDiscordUserId('discord-003');
    expect(found).not.toBeNull();
    expect(found!.email).toBe('find@example.com');
  });

  it('findMemberByDiscordUserId returns null for missing member', async () => {
    const found = await db.findMemberByDiscordUserId('nonexistent');
    expect(found).toBeNull();
  });

  it('findMemberById returns member', async () => {
    const inserted = await db.upsertProvisionalMember('discord-by-id', 'byid@example.com');
    const found = await db.findMemberById(inserted.id);
    expect(found).not.toBeNull();
    expect(found!.email).toBe('byid@example.com');
  });

  it('findMemberById returns null for missing member', async () => {
    const found = await db.findMemberById('00000000-0000-0000-0000-000000000000');
    expect(found).toBeNull();
  });

  it('updateMemberCustomerId sets payjp_customer_id', async () => {
    const member = await db.upsertProvisionalMember('discord-004', 'cust@example.com');
    await db.updateMemberCustomerId(member.id, 'cus_test123');
    const found = await db.findMemberByDiscordUserId('discord-004');
    expect(found!.payjp_customer_id).toBe('cus_test123');
  });

  it('updateMemberChargeId sets charge id and paid_at', async () => {
    const member = await db.upsertProvisionalMember('discord-005', 'charge@example.com');
    const paidAt = new Date('2025-01-15T00:00:00Z');
    await db.updateMemberChargeId(member.id, 'ch_test123', paidAt);
    const found = await db.findMemberByDiscordUserId('discord-005');
    expect(found!.payjp_initial_charge_id).toBe('ch_test123');
    expect(found!.initial_charge_paid_at!.getTime()).toBe(paidAt.getTime());
  });
});

describe('PgDbClient - inflight operations', () => {
  it('setInflightOperation and clearInflightOperation', async () => {
    const member = await db.upsertProvisionalMember('discord-010', 'inflight@example.com');
    const now = new Date();
    await db.setInflightOperation(member.id, 'op-001', 'subscribe', now);

    let found = await db.findMemberByDiscordUserId('discord-010');
    expect(found!.inflight_operation_id).toBe('op-001');
    expect(found!.inflight_operation_type).toBe('subscribe');
    expect(found!.inflight_operation_started_at).not.toBeNull();

    await db.clearInflightOperation(member.id);
    found = await db.findMemberByDiscordUserId('discord-010');
    expect(found!.inflight_operation_id).toBeNull();
    expect(found!.inflight_operation_type).toBeNull();
    expect(found!.inflight_operation_started_at).toBeNull();
  });
});

describe('PgDbClient - discord_link_sessions', () => {
  it('findLinkSession returns null for missing session', async () => {
    const found = await db.findLinkSession('nonexistent-hash');
    expect(found).toBeNull();
  });

  it('findLinkSession and consumeLinkSession', async () => {
    await pool.query(
      `INSERT INTO discord_link_sessions (link_session_token_hash, discord_user_id, expires_at)
       VALUES ($1, $2, $3)`,
      ['hash-001', 'discord-020', new Date(Date.now() + 900_000)],
    );

    const found = await db.findLinkSession('hash-001');
    expect(found).not.toBeNull();
    expect(found!.discord_user_id).toBe('discord-020');
    expect(found!.used_at).toBeNull();

    await db.consumeLinkSession('hash-001', new Date());
    const after = await db.findLinkSession('hash-001');
    expect(after!.used_at).not.toBeNull();
  });

  it('consumeLinkSession throws on already consumed session', async () => {
    await pool.query(
      `INSERT INTO discord_link_sessions (link_session_token_hash, discord_user_id, expires_at)
       VALUES ($1, $2, $3)`,
      ['hash-002', 'discord-021', new Date(Date.now() + 900_000)],
    );
    await db.consumeLinkSession('hash-002', new Date());
    await expect(db.consumeLinkSession('hash-002', new Date())).rejects.toThrow(
      'Link session not found, already consumed, or expired',
    );
  });

  it('consumeLinkSession throws on expired session', async () => {
    await pool.query(
      `INSERT INTO discord_link_sessions (link_session_token_hash, discord_user_id, expires_at)
       VALUES ($1, $2, $3)`,
      ['hash-003', 'discord-022', new Date(Date.now() - 1000)],
    );
    await expect(db.consumeLinkSession('hash-003', new Date())).rejects.toThrow(
      'Link session not found, already consumed, or expired',
    );
  });
});

describe('PgDbClient - cancel_form_tokens', () => {
  it('insertCancelFormToken, findCancelFormToken and consumeCancelFormToken', async () => {
    const member = await db.upsertProvisionalMember('discord-cancel-form-01', 'cancel-form@example.com');
    const expiresAt = new Date(Date.now() + 900_000);

    await db.insertCancelFormToken({
      id: '00000000-0000-0000-0000-000000000123',
      memberId: member.id,
      email: member.email,
      expiresAt,
    });

    const found = await db.findCancelFormToken('00000000-0000-0000-0000-000000000123');
    expect(found).not.toBeNull();
    expect(found!.member_id).toBe(member.id);
    expect(found!.used_at).toBeNull();

    await db.consumeCancelFormToken('00000000-0000-0000-0000-000000000123', new Date());
    const consumed = await db.findCancelFormToken('00000000-0000-0000-0000-000000000123');
    expect(consumed!.used_at).not.toBeNull();
  });

  it('consumeCancelFormToken throws on expired token', async () => {
    const member = await db.upsertProvisionalMember('discord-cancel-form-02', 'expired-cancel@example.com');
    await db.insertCancelFormToken({
      id: '00000000-0000-0000-0000-000000000124',
      memberId: member.id,
      email: member.email,
      expiresAt: new Date(Date.now() - 1000),
    });

    await expect(db.consumeCancelFormToken('00000000-0000-0000-0000-000000000124', new Date())).rejects.toThrow(
      'Cancel form token not found, already consumed, or expired',
    );
  });
});

describe('PgDbClient - updateMemberAfterSubscribe', () => {
  it('updates subscribe fields and does not modify inflight columns', async () => {
    const member = await db.upsertProvisionalMember('discord-030', 'sub@example.com');
    await db.updateMemberCustomerId(member.id, 'cus_sub');
    const now = new Date();
    await db.setInflightOperation(member.id, 'op-subscribe-ongoing', 'subscribe', now);

    const updated = await db.updateMemberAfterSubscribe(member.id, {
      payjp_initial_charge_id: 'ch_sub',
      initial_charge_paid_at: now,
      payjp_subscription_id: 'sub_test',
      payjp_plan_id: 'plan_monthly',
      subscription_status: 'active',
      first_trial_granted_at: null,
      access_end_at: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
      next_billing_at: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
      role_state: 'granted',
      last_synced_at: now,
      privacy_consented_at: now,
    });

    expect(updated.subscription_status).toBe('active');
    expect(updated.payjp_subscription_id).toBe('sub_test');
    expect(updated.role_state).toBe('granted');
    expect(updated.inflight_operation_id).toBe('op-subscribe-ongoing');
    expect(updated.inflight_operation_type).toBe('subscribe');
    expect(updated.inflight_operation_started_at!.getTime()).toBe(now.getTime());
  });
});

describe('PgDbClient - updateMemberAfterCancel', () => {
  it('updates cancel fields and clears inflight', async () => {
    const member = await db.upsertProvisionalMember('discord-031', 'cancel@example.com');
    const now = new Date();

    const updated = await db.updateMemberAfterCancel(member.id, {
      cancel_requested_at: now,
      subscription_status: 'canceled',
      access_end_at: now,
      next_billing_at: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
      inflight_operation_id: null,
      inflight_operation_type: null,
      inflight_operation_started_at: null,
    });

    expect(updated.subscription_status).toBe('canceled');
    expect(updated.cancel_requested_at).not.toBeNull();
    expect(updated.access_end_at!.getTime()).toBe(now.getTime());
    expect(updated.next_billing_at).not.toBeNull();
    expect(updated.inflight_operation_id).toBeNull();
  });
});

describe('PgDbClient - advisory lock', () => {
  // Discord Snowflake IDs (bigint) used directly — no hashtext
  const LOCK_ID_1 = '123456789012345678';
  const LOCK_ID_2 = '987654321098765432';

  it('acquireAdvisoryLock returns true on first acquire', async () => {
    const acquired = await db.acquireAdvisoryLock(LOCK_ID_1);
    expect(acquired).toBe(true);
    await db.releaseAdvisoryLock(LOCK_ID_1);
  });

  it('second acquire with same key on different connection returns false', async () => {
    const db1 = new PgDbClient(pool);
    const db2 = new PgDbClient(pool);

    const first = await db1.acquireAdvisoryLock(LOCK_ID_1);
    expect(first).toBe(true);

    const second = await db2.acquireAdvisoryLock(LOCK_ID_1);
    expect(second).toBe(false);

    await db1.releaseAdvisoryLock(LOCK_ID_1);
  });

  it('lock can be reacquired after release', async () => {
    const acquired1 = await db.acquireAdvisoryLock(LOCK_ID_1);
    expect(acquired1).toBe(true);
    await db.releaseAdvisoryLock(LOCK_ID_1);

    const acquired2 = await db.acquireAdvisoryLock(LOCK_ID_1);
    expect(acquired2).toBe(true);
    await db.releaseAdvisoryLock(LOCK_ID_1);
  });

  it('same client can hold different advisory locks at once', async () => {
    const acquired1 = await db.acquireAdvisoryLock(LOCK_ID_1);
    expect(acquired1).toBe(true);

    const acquired2 = await db.acquireAdvisoryLock(LOCK_ID_2);
    expect(acquired2).toBe(true);

    await db.releaseAdvisoryLock(LOCK_ID_2);
    await db.releaseAdvisoryLock(LOCK_ID_1);
  });

  it('releaseAdvisoryLock throws on key mismatch', async () => {
    await db.acquireAdvisoryLock(LOCK_ID_1);
    await expect(db.releaseAdvisoryLock(LOCK_ID_2)).rejects.toThrow('Lock key mismatch');
    await db.releaseAdvisoryLock(LOCK_ID_1);
  });
});

describe('PgDbClient - oauth_states', () => {
  it('insertOAuthState and consumeOAuthState', async () => {
    const record = await db.insertOAuthState({
      stateHash: 'state-hash-001',
      oauthSessionHash: 'session-hash-001',
      expiresAt: new Date(Date.now() + 600_000),
    });
    expect(record.state_hash).toBe('state-hash-001');
    expect(record.used_at).toBeNull();

    const consumed = await db.consumeOAuthState('state-hash-001', 'session-hash-001', new Date());
    expect(consumed).not.toBeNull();
    expect(consumed!.used_at).not.toBeNull();
  });

  it('consumeOAuthState returns null for already consumed state', async () => {
    await db.insertOAuthState({
      stateHash: 'state-hash-002',
      oauthSessionHash: 'session-hash-002',
      expiresAt: new Date(Date.now() + 600_000),
    });
    await db.consumeOAuthState('state-hash-002', 'session-hash-002', new Date());
    const second = await db.consumeOAuthState('state-hash-002', 'session-hash-002', new Date());
    expect(second).toBeNull();
  });

  it('consumeOAuthState returns null for expired state', async () => {
    await db.insertOAuthState({
      stateHash: 'state-hash-003',
      oauthSessionHash: 'session-hash-003',
      expiresAt: new Date(Date.now() - 1000),
    });
    const result = await db.consumeOAuthState('state-hash-003', 'session-hash-003', new Date());
    expect(result).toBeNull();
  });

  it('consumeOAuthState returns null for session hash mismatch', async () => {
    await db.insertOAuthState({
      stateHash: 'state-hash-004',
      oauthSessionHash: 'session-hash-004',
      expiresAt: new Date(Date.now() + 600_000),
    });
    const result = await db.consumeOAuthState('state-hash-004', 'wrong-session', new Date());
    expect(result).toBeNull();
  });
});

describe('PgDbClient - payjp_events', () => {
  it('insertPayjpEvent and findPayjpEventById', async () => {
    const inserted = await db.insertPayjpEvent({
      id: 'evt_test_001',
      event_type: 'subscription.created',
      payload: { foo: 'bar' },
      processing_result: 'processed',
      data_metadata_operation_id: 'op-001',
    });
    expect(inserted).toBe(true);

    const found = await db.findPayjpEventById('evt_test_001');
    expect(found).not.toBeNull();
    expect(found!.event_type).toBe('subscription.created');
    expect(found!.processing_result).toBe('processed');
  });

  it('insertPayjpEvent is idempotent (ON CONFLICT DO NOTHING)', async () => {
    await db.insertPayjpEvent({
      id: 'evt_test_002',
      event_type: 'subscription.created',
      payload: {},
      processing_result: 'processed',
    });
    const second = await db.insertPayjpEvent({
      id: 'evt_test_002',
      event_type: 'subscription.updated',
      payload: {},
      processing_result: 'ignored',
    });
    expect(second).toBe(false);

    const found = await db.findPayjpEventById('evt_test_002');
    expect(found!.event_type).toBe('subscription.created');
  });

  it('findPayjpEventById returns null for missing event', async () => {
    const found = await db.findPayjpEventById('evt_nonexistent');
    expect(found).toBeNull();
  });
});

describe('PgDbClient - member_impact_logs', () => {
  it('insertMemberImpactLog and findUnresolvedImpactLogs', async () => {
    const member = await db.upsertProvisionalMember('discord-impact-01', 'impact@example.com');
    const inserted = await db.insertMemberImpactLog({
      member_id: member.id,
      issue_code: 'role_sync_failed',
      detail: { reason: 'Discord API 500' },
      operation_id: 'op-impact-001',
    });
    expect(inserted).toBe(true);

    const logs = await db.findUnresolvedImpactLogs(member.id);
    expect(logs).toHaveLength(1);
    expect(logs[0].issue_code).toBe('role_sync_failed');
    expect(logs[0].operation_id).toBe('op-impact-001');
  });

  it('insertMemberImpactLog prevents duplicate unresolved logs', async () => {
    const member = await db.upsertProvisionalMember('discord-impact-02', 'dup@example.com');
    await db.insertMemberImpactLog({ member_id: member.id, issue_code: 'charge_uncertain' });
    const second = await db.insertMemberImpactLog({ member_id: member.id, issue_code: 'charge_uncertain' });
    expect(second).toBe(false);

    const logs = await db.findUnresolvedImpactLogs(member.id);
    expect(logs).toHaveLength(1);
  });

  it('resolveMemberImpactLog marks log as resolved', async () => {
    const member = await db.upsertProvisionalMember('discord-impact-03', 'resolve@example.com');
    await db.insertMemberImpactLog({ member_id: member.id, issue_code: 'role_sync_failed' });

    const resolved = await db.resolveMemberImpactLog(member.id, 'role_sync_failed');
    expect(resolved).toBe(true);

    const logs = await db.findUnresolvedImpactLogs(member.id);
    expect(logs).toHaveLength(0);
  });

  it('resolved log allows new unresolved log with same issue_code', async () => {
    const member = await db.upsertProvisionalMember('discord-impact-04', 'reinsert@example.com');
    await db.insertMemberImpactLog({ member_id: member.id, issue_code: 'role_sync_failed' });
    await db.resolveMemberImpactLog(member.id, 'role_sync_failed');

    const reinserted = await db.insertMemberImpactLog({ member_id: member.id, issue_code: 'role_sync_failed' });
    expect(reinserted).toBe(true);

    const logs = await db.findUnresolvedImpactLogs(member.id);
    expect(logs).toHaveLength(1);
  });
});
