import type pg from 'pg';

export interface DbPool {
  query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;
}

export function createPgPool(pool: pg.Pool): DbPool {
  return {
    async query(text: string, params?: unknown[]) {
      const result = await pool.query(text, params);
      return { rows: result.rows, rowCount: result.rowCount ?? 0 };
    },
  };
}
