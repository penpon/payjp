import { el } from './dom.js';
import {
  createBackToTopButton,
  renderInflightSection,
  renderSessionExpiredSection,
  renderWarningBanner,
} from './error-ui.js';
import { formatDate } from './format.js';
import type { CancelResponse, CancelUIError } from './types.js';
import { createDiscordLogoSvg } from './widgets.js';

// --- Cancel confirm modal ---

/** Shows cancel confirmation modal overlay appended to `container`. Returns a dismiss function. */
export function showCancelConfirmModal(
  container: HTMLElement,
  callbacks: { onConfirm: () => void; onDismiss: () => void },
): () => void {
  const confirmBtn = el('button', { type: 'button', class: 'discord-button cancel-modal-confirm' }, [
    createDiscordLogoSvg(20),
    el('span', {}, ['Discordで認証']),
  ]);
  confirmBtn.addEventListener('click', callbacks.onConfirm);

  const dismissBtn = el('button', { type: 'button', class: 'ghost-neutral-button' }, ['キャンセル']);
  dismissBtn.addEventListener('click', callbacks.onDismiss);

  const overlay = el(
    'div',
    {
      class: 'modal-overlay',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'cancel-modal-title',
    },
    [
      el('div', { class: 'modal' }, [
        el('h2', { class: 'modal-title', id: 'cancel-modal-title' }, ['退会の確認']),
        el('p', { class: 'modal-body' }, [
          '退会するにはDiscordで認証が必要です。認証後、退会手続きが完了します。退会後も現在の期間終了日まではサービスをご利用いただけます。',
        ]),
        el('div', { class: 'modal-actions' }, [confirmBtn, dismissBtn]),
      ]),
    ],
  );

  // Dismiss on overlay click (outside modal)
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) callbacks.onDismiss();
  });

  // Idempotent dismiss: safe to call multiple times (ESC + overlay click race, onConfirm + ESC race)
  let dismissed = false;
  const dismiss = (): void => {
    if (dismissed) return;
    dismissed = true;
    document.removeEventListener('keydown', handleKeydown);
    overlay.remove();
  };

  // Dismiss on ESC key
  const handleKeydown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') callbacks.onDismiss();
  };
  document.addEventListener('keydown', handleKeydown);

  container.appendChild(overlay);

  // Focus the confirm button on open
  queueMicrotask(() => confirmBtn.focus());

  return dismiss;
}

// --- Cancel complete screen ---

export function renderCancelComplete(container: HTMLElement, result: CancelResponse, onBackToTop: () => void): void {
  const backBtn = el('button', { type: 'button', class: 'secondary-button' }, ['トップに戻る']);
  backBtn.addEventListener('click', onBackToTop);

  const card = el('div', { class: 'card' }, [
    el('div', { class: 'success-container' }, [
      el('div', { class: 'cancel-complete-icon', 'aria-hidden': 'true' }, ['\u2713']),
      el('h1', { class: 'success-heading' }, ['退会が完了しました']),
    ]),
    el('div', { class: 'cancel-info-card' }, [
      el('div', { class: 'result-row' }, [
        el('span', { class: 'result-label' }, ['課金停止日']),
        el('span', { class: 'result-value' }, [formatDate(result.cancelEffectiveAt)]),
      ]),
      el('div', { class: 'result-row' }, [
        el('span', { class: 'result-label' }, ['ロール削除日']),
        el('span', { class: 'result-value' }, [formatDate(result.roleRemovalAt)]),
      ]),
    ]),
    backBtn,
  ]);

  container.appendChild(card);
}

// --- Cancel error screen ---

export function renderCancelError(
  container: HTMLElement,
  error: CancelUIError,
  callbacks: { onBackToTop: () => void; onReAuth: () => void },
): void {
  const children: (Node | string)[] = [el('h1', { class: 'heading' }, ['退会できませんでした'])];

  if (error.kind === 'not_in_period') {
    children.push(renderWarningBanner(error.message));
    children.push(createBackToTopButton(callbacks.onBackToTop));
  } else if (error.kind === 'session_expired') {
    children.push(...renderSessionExpiredSection(error.message, callbacks.onReAuth));
  } else if (error.kind === 'inflight') {
    children.push(...renderInflightSection(error));
  } else {
    // no_subscription or server_error
    children.push(el('div', { class: 'error-banner', role: 'alert' }, [error.message]));
    children.push(createBackToTopButton(callbacks.onBackToTop));
  }

  container.appendChild(el('div', { class: 'card' }, children));
}
