import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function runMigrations(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  const migrationLockKey = 'shared-schema-migrations';
  try {
    // Serialize migration execution across processes (api/admin-api/e2e helpers).
    await client.query('SELECT pg_advisory_lock(0, hashtext($1))', [migrationLockKey]);
    try {
      // Phase 1: schema.sql (CREATE TABLE IF NOT EXISTS — idempotent)
      const schemaPath = resolve(__dirname, '../schema.sql');
      const schemaSql = readFileSync(schemaPath, 'utf-8');
      await client.query('BEGIN');
      try {
        await client.query(schemaSql);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }

      // Phase 2: Incremental migrations (ALTER, etc.)
      const migrationsDir = resolve(__dirname, 'migrations');
      let migrationFiles: string[];
      try {
        migrationFiles = readdirSync(migrationsDir)
          .filter((f) => f.endsWith('.sql'))
          .sort();
      } catch {
        migrationFiles = [];
      }

      // Track applied migrations
      await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);

      for (const file of migrationFiles) {
        const applied = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
        if (applied.rows.length > 0) continue;

        const sql = readFileSync(resolve(migrationsDir, file), 'utf-8');
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query('INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [file]);
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock(0, hashtext($1))', [migrationLockKey]);
    }
  } finally {
    client.release();
  }
}
