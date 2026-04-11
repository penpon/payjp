import { CancelError } from './api.js';
import type { CancelUIError } from './types.js';

export function mapCancelError(err: unknown): CancelUIError {
  if (err instanceof DOMException && err.name === 'TimeoutError') {
    return {
      kind: 'inflight',
      message: 'リクエストがタイムアウトしました。処理が完了している可能性があるため、自動再試行は行われません。',
    };
  }
  if (err instanceof TypeError) {
    return {
      kind: 'server_error',
      message: 'ネットワークエラーが発生しました。処理が完了しているか確認するため、ページを再読み込みしてください。',
    };
  }
  if (!(err instanceof CancelError)) {
    return { kind: 'server_error', message: '予期しないエラーが発生しました。' };
  }
  switch (err.errorCode) {
    case 'INVALID_MEMBER_SESSION':
    case 'EXPIRED_MEMBER_SESSION':
    case 'INVALID_LINK_SESSION':
    case 'EXPIRED_LINK_SESSION':
    case 'CONSUMED_LINK_SESSION':
    case 'INVALID_CANCEL_FORM_TOKEN':
    case 'EXPIRED_CANCEL_FORM_TOKEN':
    case 'CONSUMED_CANCEL_FORM_TOKEN':
      return { kind: 'session_expired', message: 'セッションが無効です。再度Discordでログインしてください。' };
    case 'NO_SUBSCRIPTION':
    case 'NO_PAYJP_SUBSCRIPTION':
    case 'ACCESS_END_AT_NULL':
      return {
        kind: 'no_subscription',
        message: '退会対象の購読が見つかりませんでした。サポートまでお問い合わせください。',
      };
    case 'INFLIGHT_OPERATION':
      return { kind: 'inflight', message: '処理中の操作があります。', operationId: err.operationId };
    case 'FORBIDDEN_ORIGIN':
      return {
        kind: 'server_error',
        message: 'アクセス元のサイトが許可されていません。サービスが案内するURLから再度お試しください。',
      };
    case 'LOCK_UNAVAILABLE':
      return {
        kind: 'server_error',
        message: 'サーバーが一時的に処理できません。しばらく経ってから再度お試しください。',
      };
    case 'DB_UPDATE_FAILED':
      // PAY.JP cancel succeeded but DB update failed — user IS cancelled but state wasn't persisted
      return {
        kind: 'inflight',
        message: err.operationId
          ? '退会処理は完了しましたが、状態の記録に失敗しました。以下のIDをサポートにお知らせください。'
          : '退会処理は完了しましたが、状態の記録に失敗しました。サポートまでお問い合わせください。',
        operationId: err.operationId,
      };
    case 'PAYJP_CANCEL_FAILED':
      // Definite PAY.JP rejection + reconcile confirmed cancel not applied (422) — not a transient "retry later" case
      return {
        kind: 'server_error',
        message: '決済サービスで退会を完了できませんでした。サポートまでお問い合わせください。',
      };
    case 'ROLE_REVOKE_FAILED':
      return {
        kind: 'inflight',
        message: err.operationId
          ? '退会処理は進みましたが、Discordロール削除の確認が必要です。以下のIDをサポートにお知らせください。'
          : '退会処理は進みましたが、Discordロール削除の確認が必要です。サポートまでお問い合わせください。',
        operationId: err.operationId,
      };
    default:
      if (err.operationId) {
        return { kind: 'inflight', message: 'サーバーエラーが発生しました。', operationId: err.operationId };
      }
      return { kind: 'server_error', message: 'サーバーエラーが発生しました。しばらくお待ちください。' };
  }
}
