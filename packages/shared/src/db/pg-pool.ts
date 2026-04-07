import type pg from 'pg';

export type DbPoolQueryFn = (text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;

export interface DbPool {
  query: DbPoolQueryFn;
  /** Execute fn within a single-connection BEGIN/COMMIT transaction. ROLLBACK on error. */
  withTransaction: <T>(fn: (query: DbPoolQueryFn) => Promise<T>) => Promise<T>;
}

export function createPgPool(pool: pg.Pool): DbPool {
  return {
    async query(text: string, params?: unknown[]) {
      const result = await pool.query(text, params);
      return { rows: result.rows, rowCount: result.rowCount ?? 0 };
    },
    async withTransaction<T>(fn: (query: DbPoolQueryFn) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const txQuery: DbPoolQueryFn = async (text, params) => {
          const result = await client.query(text, params);
          return { rows: result.rows, rowCount: result.rowCount ?? 0 };
        };
        const result = await fn(txQuery);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackErr) {
          console.error(
            JSON.stringify({
              level: 'error',
              service: 'db-pool',
              message: 'ROLLBACK failed after transaction error',
              rollbackError: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
              originalError: err instanceof Error ? err.message : String(err),
            }),
          );
        }
        throw err;
      } finally {
        client.release();
      }
    },
  };
}
