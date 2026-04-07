import { el } from './dom.js';
import { createCopyButton, createDiscordLogoSvg } from './widgets.js';

/**
 * Renders the session_expired error section: error banner + Discord re-auth button.
 * Used by both billing and cancel error flows.
 */
export function renderSessionExpiredSection(message: string, onReAuth: () => void): (Node | string)[] {
  const reAuthBtn = el('button', { type: 'button', class: 'discord-button' }, [
    createDiscordLogoSvg(20),
    el('span', {}, ['再度Discordで連携する']),
  ]);
  reAuthBtn.addEventListener('click', onReAuth);
  return [el('div', { class: 'error-banner', role: 'alert' }, [message]), reAuthBtn];
}

/**
 * Renders the inflight (503) error section: operationId box (optional) + no auto-retry message.
 * Used by both billing and cancel error flows.
 * NOTE: Banner text is determined solely by operationId presence; error.message is not displayed.
 */
export function renderInflightSection(error: { operationId?: string }): (Node | string)[] {
  const bannerText = error.operationId
    ? '処理中の操作があります。以下のIDをサポートにお知らせください。'
    : '処理中の操作があります。サポートまでお問い合わせください。';

  const nodes: (Node | string)[] = [el('div', { class: 'error-banner', role: 'alert' }, [bannerText])];

  if (error.operationId) {
    nodes.push(renderOperationIdBox(error.operationId));
  }

  nodes.push(el('p', { class: 'body-text' }, ['自動再試行は行われません。サポートにて状況を確認いたします。']));
  return nodes;
}

/**
 * Renders the operationId display box with copy button.
 */
export function renderOperationIdBox(operationId: string): HTMLElement {
  return el('div', { class: 'operation-id-box' }, [
    el('code', { class: 'operation-id-value' }, [operationId]),
    createCopyButton(operationId),
  ]);
}

/**
 * Renders a warning banner (409-type: already_subscribed, not_in_period).
 * Uses Lemon color scheme (#9b6829).
 */
export function renderWarningBanner(message: string): HTMLElement {
  return el('div', { class: 'warning-banner', role: 'alert' }, [message]);
}

/**
 * Creates a "トップに戻る" secondary button wired to the given callback.
 * Shared across billing and cancel error screens.
 */
export function createBackToTopButton(onClick: () => void): HTMLButtonElement {
  const btn = el('button', { type: 'button', class: 'secondary-button' }, ['トップに戻る']);
  btn.addEventListener('click', onClick);
  return btn;
}
