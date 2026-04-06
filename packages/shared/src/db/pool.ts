import pg from 'pg';

export function createPool(databaseUrl: string, options?: { max?: number }): pg.Pool {
  return new pg.Pool({
    connectionString: databaseUrl,
    max: options?.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

export async function closePool(pool: pg.Pool): Promise<void> {
  await pool.end();
}
