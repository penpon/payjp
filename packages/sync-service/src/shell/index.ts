/**
 * sync-service Shell — Phase 2b (Green)
 * Effectful functions wrapping pure core with I/O
 */

export { runResyncCli } from './cli.js';
export { runDailyResync } from './daily-resync.js';
export type * from './types.js';
export { handleWebhook } from './webhook.js';
