import pg from 'pg';

export function createPool(databaseUrl: string, options?: { max?: number; ssl?: boolean }): pg.Pool {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: options?.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ...(options?.ssl !== false &&
      databaseUrl.startsWith('postgres') &&
      !databaseUrl.includes('localhost') &&
      !databaseUrl.includes('127.0.0.1') && { ssl: { rejectUnauthorized: true } }),
    statement_timeout: 30_000,
    lock_timeout: 10_000,
    idle_in_transaction_session_timeout: 60_000,
  });
  pool.on('error', (err) => {
    console.error(
      JSON.stringify({
        level: 'error',
        service: 'db-pool',
        message: 'pg pool idle client error',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  });
  return pool;
}

export async function closePool(pool: pg.Pool): Promise<void> {
  await pool.end();
}
