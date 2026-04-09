import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../migrate.js';
import type { DbPool } from '../pg-pool.js';
import { createPgPool } from '../pg-pool.js';
import { closePool, createPool } from '../pool.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://localhost:5432/hayane_test';

let rawPool: pg.Pool;
let dbPool: DbPool;
let dbAvailable = false;

beforeAll(async () => {
  rawPool = createPool(DATABASE_URL);
  try {
    await runMigrations(rawPool);
    dbPool = createPgPool(rawPool);
    dbAvailable = true;
  } catch {
    // DB not available — tests will be skipped
  }
});

beforeEach((ctx) => {
  if (!dbAvailable) ctx.skip();
});

afterAll(async () => {
  if (dbAvailable) await closePool(rawPool);
});

describe('PgPool (DbPool adapter)', () => {
  it('query returns rows and rowCount', async () => {
    const result = await dbPool.query('SELECT 1 AS num');
    expect(result.rows).toHaveLength(1);
    expect((result.rows[0] as { num: number }).num).toBe(1);
    expect(result.rowCount).toBe(1);
  });

  it('query with params works', async () => {
    const result = await dbPool.query('SELECT $1::text AS val', ['hello']);
    expect((result.rows[0] as { val: string }).val).toBe('hello');
  });

  it('rowCount is 0 for empty result', async () => {
    const result = await dbPool.query("SELECT * FROM members WHERE discord_user_id = 'nonexistent-pool-test'");
    expect(result.rows).toHaveLength(0);
    expect(result.rowCount).toBe(0);
  });
});
