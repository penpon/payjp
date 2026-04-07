import { SubscribeError } from './api.js';
import type { BillingError } from './types.js';

export function mapSubscribeError(err: unknown): BillingError {
  if (err instanceof DOMException && err.name === 'TimeoutError') {
    return {
      kind: 'inflight',
      message: 'リクエストがタイムアウトしました。処理が完了している可能性があるため、自動再試行は行われません。',
    };
  }
  if (!(err instanceof SubscribeError)) {
    return { kind: 'server_error', message: '予期しないエラーが発生しました。' };
  }
  switch (err.errorCode) {
    case 'INVALID_LINK_SESSION':
    case 'EXPIRED_LINK_SESSION':
    case 'CONSUMED_LINK_SESSION':
      return { kind: 'session_expired', message: 'セッションが無効です。再度Discordでログインしてください。' };
    case 'FORBIDDEN_ORIGIN':
      return {
        kind: 'forbidden_origin',
        message: 'アクセス元のサイトが許可されていません。サービスが案内するURLから再度お試しください。',
      };
    case 'DISCORD_NOT_MEMBER':
      return { kind: 'discord_not_member', message: 'Discordサーバーに参加してからお試しください。' };
    case 'TOKEN_ALREADY_USED':
    case 'THREE_D_SECURE_REQUIRED':
      if (err.operationId) {
        return {
          kind: 'three_ds_failed',
          message: '3Dセキュア認証または決済トークンの検証に失敗しました。',
          operationId: err.operationId,
        };
      }
      return { kind: 'three_ds_failed', message: '3Dセキュア認証に失敗しました。もう一度お試しください。' };
    case 'INFLIGHT_OPERATION':
      return { kind: 'inflight', message: '処理中の操作があります。', operationId: err.operationId };
    case 'PAYJP_TOKEN_INVALID':
      return { kind: 'card_invalid', message: '決済トークンの取得に失敗しました。再度カード情報を入力してください。' };
    case 'LOCK_UNAVAILABLE':
    case 'DISCORD_ROLE_CAPABILITY':
      return {
        kind: 'server_error',
        message: 'サーバーが一時的に処理できません。しばらく経ってから再度お試しください。',
      };
    case 'DISCORD_ROLE_SYNC_FAILED':
      return { kind: 'inflight', message: 'ロールの付与に失敗しました。', operationId: err.operationId };
    case 'CONSENT_REQUIRED':
      return {
        kind: 'server_error',
        message: '個人情報の取り扱いへの同意が必要です。チェックを入れて再度お試しください。',
      };
    case 'INVALID_EMAIL':
      return {
        kind: 'server_error',
        message: 'メールアドレスの形式が正しくありません。確認して再度お試しください。',
      };
    case 'INVALID_PLAN_ID':
      return {
        kind: 'server_error',
        message: '選択したプランが無効です。別のプランを選び直して再度お試しください。',
      };
    default:
      if (err.status === 409) return { kind: 'already_subscribed', message: 'すでに購読済みです。' };
      if (err.status === 422)
        return { kind: 'card_invalid', message: 'カード情報が無効です。確認して再度お試しください。' };
      if (err.operationId) {
        return { kind: 'inflight', message: 'サーバーエラーが発生しました。', operationId: err.operationId };
      }
      return { kind: 'server_error', message: 'サーバーエラーが発生しました。しばらくお待ちください。' };
  }
}
