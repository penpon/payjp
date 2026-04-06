/**
 * PAY.JP 書き込み失敗の不確定判定
 *
 * timeout, ECONNRESET, socket error → 不確定（inflight 保持）
 * それ以外 → 確定失敗（リコンシリエーション可能）
 */
export function isUncertainError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return msg.includes('timeout') || msg.includes('econnreset') || msg.includes('socket');
  }
  return false;
}
