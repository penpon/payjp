/**
 * スキーマは保持したまま、アプリテーブルの全行を TRUNCATE する（`schema_migrations` は対象外）。
 *
 * Usage (repo root): `TRUNCATE_APP_DATA_CONFIRM=1 npm run truncate-app-data`
 * or: `npm run truncate-app-data -- --yes`
 * or: `./scripts/truncate-app-data-cli --yes` (executable wrapper; not on PATH unless you symlink).
 *
 * If `.env` uses `op://` for secrets, dotenv does not resolve them — use:
 * `op run --env-file=.env -- npm run truncate-app-data -- --yes`
 *
 * Required env: `DATABASE_URL` **or** `POSTGRES_USER` + `POSTGRES_PASSWORD` + `POSTGRES_DB` (see below).
 *
 * **1Password (`op://`)**: `dotenv` does not resolve references — always use `op run --env-file=.env -- …`.
 * If `DATABASE_URL`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` are **different** `op://` items,
 * they must describe the **same** Postgres (same host, user, password, database). If unsure, prefer **only**
 * `DATABASE_URL` (resolved to a full `postgres://…` URL): `op run --env-file=.env -- npm run truncate-app-data -- --yes`
 * **without** `--from-postgres-env`.
 *
 * When building from `POSTGRES_*` (`--from-postgres-env`), host/port default to `localhost`/`5432` **unless**
 * `POSTGRES_HOST` / `POSTGRES_PORT` (or `PGHOST` / `PGPORT`) are set. If `DATABASE_URL` is already resolved
 * (e.g. by `op run`) and does not contain `op://`, **host and port are taken from `DATABASE_URL`** when host
 * is not set explicitly — so you connect to the same server as the app.
 *
 * `PGUSER` / `PGPASSWORD` / `PGDATABASE` / `PGHOST` / `PGPORT` are used as fallbacks when building from parts.
 *
 * `TRUNCATE_SKIP_DOTENV=1` — do not load repo `.env` (use only variables already in the process, e.g. from `op run`).
 * If `DATABASE_URL` is already set and does **not** contain `op://` (resolved by `op run` or your shell), loading `.env`
 * is skipped automatically so a stale on-disk `.env` cannot affect the connection string.
 *
 * `TRUNCATE_VERBOSE_CONNECTION=1` or `--verbose-connection` — print host/port/db/user and password length (no secrets).
 *
 * `--ping` — only run `SELECT 1` (no TRUNCATE). Does **not** require `--yes`. Use to verify `DATABASE_URL` / auth.
 *
 * 警告: PAY.JP の顧客・サブスクは消えない。DB だけ空にすると運用不整合になるため、本番では通常使わない。
 */
import { closePool, createPool, truncateAllAppData } from '@hayane/shared';

function argvList(): string[] {
  return process.argv.slice(2);
}

function wantsPing(): boolean {
  return argvList().includes('--ping');
}

function wantsConfirm(): boolean {
  const argv = argvList();
  if (argv.includes('--yes') || argv.includes('-y')) return true;
  const v = process.env.TRUNCATE_APP_DATA_CONFIRM?.trim();
  return v === '1' || v === 'yes' || v === 'true';
}

function usePostgresParts(): boolean {
  const v = process.env.TRUNCATE_USE_POSTGRES_VARS?.trim();
  return v === '1' || v === 'true' || v === 'yes' || argvList().includes('--from-postgres-env');
}

function verboseConnection(): boolean {
  return process.env.TRUNCATE_VERBOSE_CONNECTION === '1' || argvList().includes('--verbose-connection');
}

function writeConnectionDebug(
  label: string,
  info: {
    source: 'from-postgres-parts' | 'database-url';
    host: string;
    port: string;
    user: string;
    database: string;
    passwordLength: number;
    passwordHasOpMarker: boolean;
  },
): void {
  if (!verboseConnection()) return;
  process.stderr.write(
    `[truncate-app-data] ${label}: source=${info.source} host=${info.host} port=${info.port} user=${info.user} database=${info.database} passwordLength=${info.passwordLength} passwordHasOpMarker=${info.passwordHasOpMarker}\n`,
  );
}

/** When `op run` has resolved `DATABASE_URL`, reuse host/port for `--from-postgres-env` if POSTGRES_HOST is unset. */
function parseHostPortFromResolvedDatabaseUrl(): { host: string; port: string } | null {
  const url = process.env.DATABASE_URL;
  if (!url || url.includes('op://')) return null;
  try {
    const u = new URL(url);
    if (!u.hostname) return null;
    return { host: u.hostname, port: u.port || '5432' };
  } catch {
    return null;
  }
}

function buildDatabaseUrlFromPostgresEnv(): string | null {
  const user = process.env.POSTGRES_USER?.trim() || process.env.PGUSER?.trim();
  const pass = process.env.POSTGRES_PASSWORD ?? process.env.PGPASSWORD;
  const db = process.env.POSTGRES_DB?.trim() || process.env.PGDATABASE?.trim();
  if (!user || pass === undefined || pass === '' || !db) return null;
  if (pass.includes('op://')) {
    process.stderr.write(
      'POSTGRES_PASSWORD / PGPASSWORD still contains op:// — dotenv does not resolve it. Use: op run --env-file=.env -- npm run truncate-app-data -- --yes --from-postgres-env\n',
    );
    process.exit(1);
  }
  const fromUrl = parseHostPortFromResolvedDatabaseUrl();
  const hostExplicit = Boolean(process.env.POSTGRES_HOST?.trim() || process.env.PGHOST?.trim());
  const host = process.env.POSTGRES_HOST?.trim() || process.env.PGHOST?.trim() || fromUrl?.host || 'localhost';
  const port = process.env.POSTGRES_PORT?.trim() || process.env.PGPORT?.trim() || fromUrl?.port || '5432';
  if (fromUrl && !hostExplicit) {
    process.stderr.write(
      `[truncate-app-data] Using host=${host} port=${port} from resolved DATABASE_URL (POSTGRES_HOST unset).\n`,
    );
  }
  writeConnectionDebug('connecting', {
    source: 'from-postgres-parts',
    host,
    port,
    user,
    database: db,
    passwordLength: pass.length,
    passwordHasOpMarker: false,
  });
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}/${encodeURIComponent(db)}?sslmode=disable`;
}

function resolveDatabaseUrl(): string {
  if (usePostgresParts()) {
    if (process.env.DATABASE_URL?.trim()) {
      process.stderr.write(
        '[truncate-app-data] Hint: separate op:// fields must match one database. If auth fails, use only DATABASE_URL: op run --env-file=.env -- npm run truncate-app-data -- --yes (omit --from-postgres-env).\n',
      );
    }
    const built = buildDatabaseUrlFromPostgresEnv();
    if (!built) {
      process.stderr.write(
        '--from-postgres-env / TRUNCATE_USE_POSTGRES_VARS requires POSTGRES_USER (or PGUSER), POSTGRES_PASSWORD (or PGPASSWORD), POSTGRES_DB (or PGDATABASE).\n',
      );
      process.exit(1);
    }
    return built;
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    process.stderr.write(
      'DATABASE_URL is required (or set POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB and use --from-postgres-env).\n',
    );
    process.exit(1);
  }
  if (verboseConnection()) {
    try {
      const u = new URL(databaseUrl);
      const pass = u.password ? decodeURIComponent(u.password) : '';
      writeConnectionDebug('connecting', {
        source: 'database-url',
        host: u.hostname,
        port: u.port || '5432',
        user: u.username ? decodeURIComponent(u.username) : '',
        database: u.pathname.replace(/^\//, '').split('/')[0] || '',
        passwordLength: pass.length,
        passwordHasOpMarker: databaseUrl.includes('op://'),
      });
    } catch {
      process.stderr.write('[truncate-app-data] DATABASE_URL could not be parsed for verbose output (non-fatal).\n');
    }
  }
  return databaseUrl;
}

/** Load repo `.env` unless `op run` (or the shell) already set a resolved `DATABASE_URL`. */
function shouldLoadDotenv(): boolean {
  if (process.env.TRUNCATE_SKIP_DOTENV === '1') return false;
  const db = process.env.DATABASE_URL?.trim();
  if (db && !db.includes('op://')) return false;
  return true;
}

function writeAuthFailureHelp(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string }).code;
  if (code !== '28P01' && !msg.includes('password authentication failed')) return;
  process.stderr.write(
    '[truncate-app-data] PostgreSQL rejected the password.\n' +
      '  - The CLI and SQL are fine if `npm run verify:truncate` passes on this repo (ephemeral Docker Postgres).\n' +
      '  - Your environment: the password in 1Password (DATABASE_URL) does not match the running Postgres user. Align the credential, or run ALTER USER … WITH PASSWORD … on the server, or reset the Docker volume if the DB was initialized with an older password.\n' +
      '  - If you use Docker: the data volume keeps the password from the *first* `docker compose up`. Changing POSTGRES_PASSWORD in .env later does not change the DB user password — reset the volume or ALTER USER … WITH PASSWORD … inside Postgres.\n' +
      '  - Diagnose: `op run --env-file=.env -- npm run truncate-app-data -- --ping` (no data change) and TRUNCATE_VERBOSE_CONNECTION=1 to see host/port.\n' +
      '  - With multiple op:// items: try DATABASE_URL only — op run --env-file=.env -- npm run truncate-app-data -- --yes (no --from-postgres-env).\n' +
      '  - If a stale .env might affect the run: TRUNCATE_SKIP_DOTENV=1 op run --env-file=.env -- npm run truncate-app-data -- --yes (or rely on auto-skip when DATABASE_URL is already resolved).\n',
  );
}

async function main(): Promise<void> {
  if (shouldLoadDotenv()) {
    await import('./load-env.js');
  }

  const databaseUrl = resolveDatabaseUrl();

  if (!usePostgresParts() && databaseUrl.includes('op://')) {
    process.stderr.write(
      'DATABASE_URL still contains op:// — dotenv does not resolve 1Password references.\n' +
        'Run: op run --env-file=.env -- npm run truncate-app-data -- --yes\n',
    );
    process.exit(1);
  }

  const sslDisabled = databaseUrl.includes('sslmode=disable');
  const pool = createPool(databaseUrl, sslDisabled ? { ssl: false } : undefined);

  if (wantsPing()) {
    try {
      await pool.query('SELECT 1');
      console.log(
        JSON.stringify({
          level: 'info',
          service: 'truncate-app-data',
          message: 'connection ok (ping)',
          timestamp: new Date().toISOString(),
        }),
      );
    } finally {
      await closePool(pool);
    }
    return;
  }

  if (!wantsConfirm()) {
    process.stderr.write(
      'Refusing to truncate: set TRUNCATE_APP_DATA_CONFIRM=1 or pass --yes (this deletes all app rows; schema_migrations is kept).\n',
    );
    process.exit(2);
  }

  try {
    await truncateAllAppData(pool);
    console.log(
      JSON.stringify({
        level: 'info',
        service: 'truncate-app-data',
        message: 'app tables truncated (schema preserved; schema_migrations untouched)',
        timestamp: new Date().toISOString(),
      }),
    );
  } finally {
    await closePool(pool);
  }
}

main().catch((err) => {
  writeAuthFailureHelp(err);
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
