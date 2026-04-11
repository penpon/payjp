import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderCancelComplete, renderCancelError, showCancelConfirmModal } from '../cancel-ui.js';
import type { CancelResponse, CancelUIError } from '../types.js';

const CANCEL_RESULT: CancelResponse = {
  ok: true,
  memberId: 'uuid-789',
  cancelEffectiveAt: '2026-05-07T00:00:00Z',
  roleRemovalAt: '2026-05-07T00:00:00Z',
};

describe('cancel-ui', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  describe('showCancelConfirmModal', () => {
    it('should render modal overlay with title and body', () => {
      const dismiss = showCancelConfirmModal(container, { onConfirm: vi.fn(), onDismiss: vi.fn() });

      expect(container.querySelector('.modal-overlay')).not.toBeNull();
      expect(container.querySelector('.modal-title')?.textContent).toBe('退会の確認');
      expect(container.querySelector('.modal-body')).not.toBeNull();

      dismiss();
    });

    it('should render Google Form button and cancel button', () => {
      const dismiss = showCancelConfirmModal(container, { onConfirm: vi.fn(), onDismiss: vi.fn() });

      expect(container.querySelector('.cancel-modal-confirm')).not.toBeNull();
      expect(container.querySelector('.cancel-modal-confirm')?.textContent).toContain('Google Formへ進む');
      expect(container.querySelector('.ghost-neutral-button')?.textContent).toBe('キャンセル');

      dismiss();
    });

    it('should call onConfirm when Google Form button is clicked', () => {
      const onConfirm = vi.fn();
      const dismiss = showCancelConfirmModal(container, { onConfirm, onDismiss: vi.fn() });

      (container.querySelector('.cancel-modal-confirm') as HTMLButtonElement).click();

      expect(onConfirm).toHaveBeenCalledOnce();
      dismiss();
    });

    it('should call onDismiss when cancel button is clicked', () => {
      const onDismiss = vi.fn();
      const dismiss = showCancelConfirmModal(container, { onConfirm: vi.fn(), onDismiss });

      (container.querySelector('.ghost-neutral-button') as HTMLButtonElement).click();

      expect(onDismiss).toHaveBeenCalledOnce();
      dismiss();
    });

    it('should call onDismiss when overlay background is clicked', () => {
      const onDismiss = vi.fn();
      const dismiss = showCancelConfirmModal(container, { onConfirm: vi.fn(), onDismiss });

      const overlay = container.querySelector('.modal-overlay') as HTMLElement;
      overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(onDismiss).toHaveBeenCalledOnce();
      dismiss();
    });

    it('should remove overlay when dismiss function is called', () => {
      const dismiss = showCancelConfirmModal(container, { onConfirm: vi.fn(), onDismiss: vi.fn() });
      expect(container.querySelector('.modal-overlay')).not.toBeNull();

      dismiss();

      expect(container.querySelector('.modal-overlay')).toBeNull();
    });

    it('should have role=dialog and aria-modal on overlay', () => {
      const dismiss = showCancelConfirmModal(container, { onConfirm: vi.fn(), onDismiss: vi.fn() });

      const overlay = container.querySelector('.modal-overlay');
      expect(overlay?.getAttribute('role')).toBe('dialog');
      expect(overlay?.getAttribute('aria-modal')).toBe('true');

      dismiss();
    });
  });

  describe('renderCancelComplete', () => {
    it('should show cancel complete heading', () => {
      renderCancelComplete(container, CANCEL_RESULT, vi.fn());

      expect(container.querySelector('.success-heading')?.textContent).toBe('退会が完了しました');
    });

    it('should show cancel complete icon with primary color class', () => {
      renderCancelComplete(container, CANCEL_RESULT, vi.fn());

      expect(container.querySelector('.cancel-complete-icon')).not.toBeNull();
    });

    it('should show cancelEffectiveAt as 課金停止日', () => {
      renderCancelComplete(container, CANCEL_RESULT, vi.fn());

      const rows = container.querySelectorAll('.result-row');
      const labels = Array.from(rows).map((r) => r.querySelector('.result-label')?.textContent);
      expect(labels).toContain('課金停止日');
    });

    it('should show roleRemovalAt as ロール削除日', () => {
      renderCancelComplete(container, CANCEL_RESULT, vi.fn());

      const rows = container.querySelectorAll('.result-row');
      const labels = Array.from(rows).map((r) => r.querySelector('.result-label')?.textContent);
      expect(labels).toContain('ロール削除日');
    });

    it('should format date in Asia/Tokyo', () => {
      renderCancelComplete(container, { ...CANCEL_RESULT, cancelEffectiveAt: '2026-05-06T15:00:00.000Z' }, vi.fn());

      expect(container.textContent).toContain('2026/05/07');
    });

    it('should render info card with cancel-info-card class', () => {
      renderCancelComplete(container, CANCEL_RESULT, vi.fn());

      expect(container.querySelector('.cancel-info-card')).not.toBeNull();
    });

    it('should render back-to-top button and call callback on click', () => {
      const onBackToTop = vi.fn();
      renderCancelComplete(container, CANCEL_RESULT, onBackToTop);

      const btn = container.querySelector('.secondary-button') as HTMLButtonElement;
      expect(btn).not.toBeNull();
      btn.click();
      expect(onBackToTop).toHaveBeenCalledOnce();
    });
  });

  describe('renderCancelError', () => {
    const baseCallbacks = { onBackToTop: vi.fn(), onReAuth: vi.fn() };

    it('should show session_expired with Discord re-auth button', () => {
      const onReAuth = vi.fn();
      const error: CancelUIError = { kind: 'session_expired', message: 'セッション無効' };
      renderCancelError(container, error, { ...baseCallbacks, onReAuth });

      const btn = container.querySelector('.discord-button') as HTMLButtonElement;
      expect(btn).not.toBeNull();
      btn.click();
      expect(onReAuth).toHaveBeenCalledOnce();
    });

    it('should show inflight with operationId and copy button', () => {
      const error: CancelUIError = {
        kind: 'inflight',
        message: '処理中の操作があります。',
        operationId: 'op-cancel-789',
      };
      renderCancelError(container, error, baseCallbacks);

      expect(container.querySelector('.operation-id-value')?.textContent).toBe('op-cancel-789');
      expect(container.querySelector('.copy-button')).not.toBeNull();
      expect(container.textContent).toContain('自動再試行は行われません');
    });

    it('should show inflight without operationId — no operation-id-box', () => {
      const error: CancelUIError = { kind: 'inflight', message: '処理中' };
      renderCancelError(container, error, baseCallbacks);

      expect(container.querySelector('.operation-id-box')).toBeNull();
      expect(container.textContent).toContain('サポートまでお問い合わせください');
    });

    it('should show server_error with back button', () => {
      const onBackToTop = vi.fn();
      const error: CancelUIError = { kind: 'server_error', message: 'サーバーエラー' };
      renderCancelError(container, error, { ...baseCallbacks, onBackToTop });

      const btn = container.querySelector('.secondary-button') as HTMLButtonElement;
      expect(btn).not.toBeNull();
      btn.click();
      expect(onBackToTop).toHaveBeenCalledOnce();
    });
  });
});
