/**
 * Emergency: truncate `access_gate_sessions` so every `__Host-access_gate` cookie becomes invalid.
 *
 * Usage (from repo root): `npm run invalidate-access-gate` with `DATABASE_URL` set.
 */
import './load-env.js';
import pg from 'pg';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    process.stderr.write('DATABASE_URL is required\n');
    process.exit(1);
  }

  if (!process.argv.includes('--yes') && process.env.INVALIDATE_CONFIRM !== '1') {
    process.stderr.write(
      'This will TRUNCATE access_gate_sessions, invalidating ALL active sessions.\nPass --yes or set INVALIDATE_CONFIRM=1 to confirm.\n',
    );
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
