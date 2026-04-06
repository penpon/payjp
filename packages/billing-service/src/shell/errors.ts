/**
 * PAY.JP 書き込み失敗の不確定判定
 *
 * 不確定（inflight 保持）:
 * - ネットワーク系: timeout, ECONNRESET, ECONNREFUSED, socket error
 * - HTTP 5xx: PAY.JP 側でリクエスト処理済みの可能性あり
 * - Error でない throw: 安全側に倒して不確定扱い
 *
 * 確定失敗（リコンシリエーション可能）:
 * - HTTP 4xx: クライアントエラー（カード無効、パラメータ不正等）
 */
export function isUncertainError(err: unknown): boolean {
  // Non-Error throws → treat as uncertain (safe side)
  if (!(err instanceof Error)) {
    return true;
  }

  // Node.js network error codes
  const code = (err as NodeJS.ErrnoException).code;
  if (code && ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'EAI_AGAIN'].includes(code)) {
    return true;
  }

  // Message-based detection (fallback for errors without code)
  const msg = err.message.toLowerCase();
  if (msg.includes('timeout') || msg.includes('econnreset') || msg.includes('socket hang up')) {
    return true;
  }

  // HTTP status code detection (PAY.JP SDK may attach status to error)
  const status = (err as { status?: number; statusCode?: number }).status
    ?? (err as { status?: number; statusCode?: number }).statusCode;
  if (typeof status === 'number') {
    // 5xx → uncertain (server may have processed the request)
    if (status >= 500) return true;
    // 4xx → definite failure
    if (status >= 400) return false;
  }

  // Unknown error shape → treat as uncertain (safe side)
  return true;
}
