/**
 * Ephemeral Postgres (Docker) に対して migrate → truncate を実行し、CLI 経路を検証する。
 * Usage: `bash scripts/run-verify-truncate-app-data.sh`（スクリプト側で Docker を起動）
 */
import { closePool, createPool, runMigrations, truncateAllAppData } from '@hayane/shared';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    process.stderr.write('DATABASE_URL is required\n');
    process.exit(1);
  }
  const pool = createPool(url, url.includes('sslmode=disable') ? { ssl: false } : undefined);
  try {
    await runMigrations(pool);
    await truncateAllAppData(pool);
    console.log(JSON.stringify({ ok: true, step: 'migrate_then_truncate' }));
  } finally {
    await closePool(pool);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
