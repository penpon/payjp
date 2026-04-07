import { describe, expect, it } from 'vitest';
import { SubscribeError } from '../api.js';
import { mapSubscribeError } from '../map-subscribe-error.js';

describe('mapSubscribeError', () => {
  it('maps TimeoutError to inflight to avoid automatic retry', () => {
    const err = new DOMException('timeout', 'TimeoutError');
    expect(mapSubscribeError(err)).toEqual({
      kind: 'inflight',
      message: 'リクエストがタイムアウトしました。処理が完了している可能性があるため、自動再試行は行われません。',
    });
  });

  it('maps CONSENT_REQUIRED (422) to server_error, not card_invalid', () => {
    const err = new SubscribeError(422, 'CONSENT_REQUIRED', undefined, 'Privacy consent is required');
    expect(mapSubscribeError(err)).toEqual({
      kind: 'server_error',
      message: '個人情報の取り扱いへの同意が必要です。チェックを入れて再度お試しください。',
    });
  });

  it('maps INVALID_EMAIL (422) to server_error, not card_invalid', () => {
    const err = new SubscribeError(422, 'INVALID_EMAIL', undefined, 'Invalid email format');
    expect(mapSubscribeError(err)).toEqual({
      kind: 'server_error',
      message: 'メールアドレスの形式が正しくありません。確認して再度お試しください。',
    });
  });

  it('maps INVALID_PLAN_ID (422) to server_error, not card_invalid', () => {
    const err = new SubscribeError(422, 'INVALID_PLAN_ID', undefined, 'planId not in allowlist');
    expect(mapSubscribeError(err)).toEqual({
      kind: 'server_error',
      message: '選択したプランが無効です。別のプランを選び直して再度お試しください。',
    });
  });

  it('still maps unknown 422 to card_invalid', () => {
    const err = new SubscribeError(422, 'PAYJP_ERROR', undefined, 'Card declined');
    expect(mapSubscribeError(err)).toEqual({
      kind: 'card_invalid',
      message: 'カード情報が無効です。確認して再度お試しください。',
    });
  });
});
