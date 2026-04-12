/**
 * Load repository-root `.env` into `process.env` for local `tsx` / CLI runs.
 * - Does not override variables already set (Docker, CI, or `op run`).
 * - Skipped under Vitest so tests do not pick up a developer machine `.env`.
 * - `op://` references are not resolved here; use `op run --env-file=.env -- <cmd>` or `scripts/docker-compose-op.sh`.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

const dir = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(dir, '../../../.env');

if (process.env.VITEST !== 'true' && existsSync(envPath)) {
  config({ path: envPath });
}
