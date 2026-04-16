import { describe, expect, it } from 'vitest';
import { CancelError } from '../api.js';
import { mapCancelError } from '../map-cancel-error.js';

describe('mapCancelError', () => {
  it('maps INFLIGHT_OPERATION to inflight with operationId', () => {
    const err = new CancelError(503, 'INFLIGHT_OPERATION', 'op-123', 'In progress');
    expect(mapCancelError(err)).toEqual({
      kind: 'inflight',
      message: '処理中の操作があります。',
      operationId: 'op-123',
    });
  });

  it('maps INVALID_LINK_SESSION to session_expired', () => {
    const err = new CancelError(401, 'INVALID_LINK_SESSION', undefined, 'Not found');
    expect(mapCancelError(err)).toEqual({
      kind: 'session_expired',
      message: 'セッションが無効です。再度Discordでログインしてください。',
    });
  });

  it('maps INVALID_MEMBER_SESSION to session_expired', () => {
    const err = new CancelError(401, 'INVALID_MEMBER_SESSION', undefined, 'Not found');
    expect(mapCancelError(err).kind).toBe('session_expired');
  });

  it('maps EXPIRED_LINK_SESSION to session_expired', () => {
    const err = new CancelError(401, 'EXPIRED_LINK_SESSION', undefined, 'Expired');
    expect(mapCancelError(err).kind).toBe('session_expired');
  });

  it('maps CONSUMED_LINK_SESSION to session_expired', () => {
    const err = new CancelError(401, 'CONSUMED_LINK_SESSION', undefined, 'Used');
    expect(mapCancelError(err).kind).toBe('session_expired');
  });

  it('maps NO_SUBSCRIPTION to no_subscription', () => {
    const err = new CancelError(409, 'NO_SUBSCRIPTION', undefined, 'No subscription');
    expect(mapCancelError(err).kind).toBe('no_subscription');
  });

  it('maps PAYJP_CANCEL_FAILED to server_error with definitive message (not transient wait)', () => {
    const err = new CancelError(
      422,
      'PAYJP_CANCEL_FAILED',
      undefined,
      'Cancel not applied (confirmed by reconciliation)',
    );
    expect(mapCancelError(err)).toEqual({
      kind: 'server_error',
      message: '決済サービスで退会を完了できませんでした。サポートまでお問い合わせください。',
    });
  });

  it('maps ROLE_REVOKE_FAILED to inflight with support message', () => {
    const err = new CancelError(503, 'ROLE_REVOKE_FAILED', 'op-789', 'Role revoke failed');
    expect(mapCancelError(err)).toEqual({
      kind: 'inflight',
      message: '退会処理は進みましたが、Discordロール削除の確認が必要です。以下のIDをサポートにお知らせください。',
      operationId: 'op-789',
    });
  });

  it('maps DB_UPDATE_FAILED without operationId to inflight (support-only message)', () => {
    const err = new CancelError(503, 'DB_UPDATE_FAILED', undefined, 'Failed to set inflight operation');
    expect(mapCancelError(err)).toEqual({
      kind: 'inflight',
      message: '退会処理は完了しましたが、状態の記録に失敗しました。サポートまでお問い合わせください。',
    });
  });

  it('maps unknown 503 with operationId to inflight', () => {
    const err = new CancelError(503, 'PAYJP_UNCERTAIN', 'op-456', 'Uncertain');
    expect(mapCancelError(err)).toEqual({
      kind: 'inflight',
      message: 'サーバーエラーが発生しました。',
      operationId: 'op-456',
    });
  });

  it('maps unknown error without operationId to server_error', () => {
    const err = new CancelError(500, 'INTERNAL_ERROR', undefined, 'Internal error');
    expect(mapCancelError(err)).toEqual({
      kind: 'server_error',
      message: 'サーバーエラーが発生しました。しばらくお待ちください。',
    });
  });

  it('maps TimeoutError to inflight', () => {
    const err = new DOMException('timeout', 'TimeoutError');
    expect(mapCancelError(err)).toEqual({
      kind: 'inflight',
      message: 'リクエストがタイムアウトしました。処理が完了している可能性があるため、自動再試行は行われません。',
    });
  });

  it('maps non-CancelError to server_error', () => {
    expect(mapCancelError(new Error('network error'))).toEqual({
      kind: 'server_error',
      message: '予期しないエラーが発生しました。',
    });
  });
});
