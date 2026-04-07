import { CancelError } from './api.js';
import type { CancelUIError } from './types.js';

export function mapCancelError(err: unknown): CancelUIError {
  if (err instanceof DOMException && err.name === 'TimeoutError') {
    return {
      kind: 'inflight',
      message: 'リクエストがタイムアウトしました。処理が完了している可能性があるため、自動再試行は行われません。',
    };
  }
  if (!(err instanceof CancelError)) {
    return { kind: 'server_error', message: '予期しないエラーが発生しました。' };
  }
  switch (err.errorCode) {
    case 'INVALID_LINK_SESSION':
    case 'EXPIRED_LINK_SESSION':
    case 'CONSUMED_LINK_SESSION':
      return { kind: 'session_expired', message: 'セッションが無効です。再度Discordでログインしてください。' };
    case 'BEFORE_ACCEPTANCE_BOUNDARY':
      return {
        kind: 'not_in_period',
        message: '現在は退会申請の受付期間外です。受付は次回更新日の1ヶ月前から開始されます。',
      };
    case 'NO_SUBSCRIPTION':
    case 'NO_PAYJP_SUBSCRIPTION':
    case 'ACCESS_END_AT_NULL':
      return {
        kind: 'no_subscription',
        message: '退会対象の購読が見つかりませんでした。サポートまでお問い合わせください。',
      };
    case 'INFLIGHT_OPERATION':
      return { kind: 'inflight', message: '処理中の操作があります。', operationId: err.operationId };
    default:
      if (err.operationId) {
        return { kind: 'inflight', message: 'サーバーエラーが発生しました。', operationId: err.operationId };
      }
      return { kind: 'server_error', message: 'サーバーエラーが発生しました。しばらくお待ちください。' };
  }
}
