import type { LogEntry } from '@hayane/shared';
import { formatRfc3339Utc } from '../core/index.js';
import type { CliDeps } from './cli.js';
import { runResyncCli } from './cli.js';

export interface DailyResyncDeps {
  cliDeps: CliDeps;
  log: (entry: LogEntry) => void;
}

/**
 * Daily resync handler: runs `--all` reconciliation.
 * inflight_operation は手動 CLI (--operation-id) でのみ解除可能。
 * 自動解除するとデータ不整合リスクがあるため、日次ジョブでは解除しない。
 */
export async function runDailyResync(deps: DailyResyncDeps): Promise<void> {
  const { cliDeps, log } = deps;
  let output: Awaited<ReturnType<typeof runResyncCli>>;
  try {
    output = await runResyncCli(['--all'], cliDeps);
  } catch (err) {
    log({
      timestamp: formatRfc3339Utc(cliDeps.now()),
      service: 'sync-service',
      endpoint: 'daily-resync',
      result: 'error',
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  log({
    timestamp: formatRfc3339Utc(cliDeps.now()),
    service: 'sync-service',
    endpoint: 'daily-resync',
    result: output.exitCode === 0 ? 'success' : 'failure',
    ...output.result,
  });

  if (output.exitCode !== 0) {
    throw new Error(`daily-resync exited with code ${output.exitCode}`);
  }
}
