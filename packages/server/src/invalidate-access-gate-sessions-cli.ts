/**
 * Emergency: truncate `access_gate_sessions` so every `__Host-access_gate` cookie becomes invalid.
 *
 * Usage (from repo root): `npm run invalidate-access-gate` with `DATABASE_URL` set.
 */
import pg from 'pg';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    process.stderr.write('DATABASE_URL is required\n');
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    await pool.query('TRUNCATE access_gate_sessions');
    console.log(
      JSON.stringify({
        level: 'info',
        service: 'invalidate-access-gate-sessions',
        message: 'access_gate_sessions truncated',
        timestamp: new Date().toISOString(),
      }),
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
