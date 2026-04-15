import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../migrate.js';
import { closePool, createPool } from '../pool.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://localhost:5432/hayane_test';

let pool: pg.Pool;
let dbAvailable = false;

beforeAll(async () => {
  pool = createPool(DATABASE_URL);
  try {
    await pool.query('SELECT 1');
    dbAvailable = true;
  } catch {
    // DB not available — tests will be skipped
  }
});

beforeEach((ctx) => {
  if (!dbAvailable) ctx.skip();
});

afterAll(async () => {
  if (dbAvailable) await closePool(pool);
});

describe('runMigrations', () => {
  it('creates all core tables including access gate and legacy invite DDL', async () => {
    await runMigrations(pool);

    const result = await pool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
      AND table_name IN (
        'members',
        'payjp_events',
        'oauth_states',
        'discord_link_sessions',
        'cancel_form_tokens',
        'member_sessions',
        'member_impact_logs',
        'invite_tokens',
        'invite_sessions',
        'access_gate_sessions'
      )
      ORDER BY table_name
    `);

    const tables = result.rows.map((r: { table_name: string }) => r.table_name);
    expect(tables).toContain('members');
    expect(tables).toContain('payjp_events');
    expect(tables).toContain('oauth_states');
    expect(tables).toContain('discord_link_sessions');
    expect(tables).toContain('cancel_form_tokens');
    expect(tables).toContain('member_sessions');
    expect(tables).toContain('member_impact_logs');
    expect(tables).toContain('invite_tokens');
    expect(tables).toContain('invite_sessions');
    expect(tables).toContain('access_gate_sessions');
  });

  it('is idempotent (running twice does not error)', async () => {
    await runMigrations(pool);
    await expect(runMigrations(pool)).resolves.not.toThrow();
  });

  it('payjp_events has process_status and data_metadata_operation_id columns', async () => {
    const result = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'payjp_events'
      AND column_name IN ('process_status', 'data_metadata_operation_id')
    `);
    const columns = result.rows.map((r: { column_name: string }) => r.column_name);
    expect(columns).toContain('process_status');
    expect(columns).toContain('data_metadata_operation_id');
  });

  it('members does not include deprecated privacy_consented_at column', async () => {
    const result = await pool.query(`
      SELECT 1
      FROM information_schema.columns
      WHERE table_name = 'members'
      AND column_name = 'privacy_consented_at'
    `);
    expect(result.rowCount ?? 0).toBe(0);
  });
});
