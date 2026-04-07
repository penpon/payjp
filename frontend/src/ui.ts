import type { BillingCallbacks } from './billing-ui.js';
import { renderBilling, renderSubscribed } from './billing-ui.js';
import { el } from './dom.js';
import type { AppState, BillingFormState, PayjpAdapter, PlanDef, SubscriptionInfo } from './types.js';

function createDiscordLogoSvg(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '24');
  svg.setAttribute('height', '24');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'white');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute(
    'd',
    'M19.27 5.33C17.94 4.71 16.5 4.26 15 4a.09.09 0 0 0-.07.03c-.18.33-.39.76-.53 1.09a16.09 16.09 0 0 0-4.8 0c-.14-.34-.36-.76-.54-1.09c-.01-.02-.04-.03-.07-.03c-1.5.26-2.93.71-4.27 1.33c-.01 0-.02.01-.03.02c-2.72 4.07-3.47 8.03-3.1 11.95c0 .02.01.04.03.05c1.8 1.32 3.53 2.12 5.24 2.65c.03.01.06 0 .07-.02c.4-.55.76-1.13 1.07-1.74c.02-.04 0-.08-.04-.09c-.57-.22-1.11-.48-1.64-.78c-.04-.02-.04-.08-.01-.11c.11-.08.22-.17.33-.25c.02-.02.05-.02.07-.01c3.44 1.57 7.15 1.57 10.55 0c.02-.01.05-.01.07.01c.11.09.22.17.33.26c.04.03.04.09-.01.11c-.52.31-1.07.56-1.64.78c-.04.01-.05.06-.04.09c.32.61.68 1.19 1.07 1.74c.03.01.06.02.09.01c1.72-.53 3.45-1.33 5.25-2.65c.02-.01.03-.03.03-.05c.44-4.53-.73-8.46-3.1-11.95c-.01-.01-.02-.02-.04-.02zM8.52 14.91c-1.03 0-1.89-.95-1.89-2.12s.84-2.12 1.89-2.12c1.06 0 1.9.96 1.89 2.12c0 1.17-.84 2.12-1.89 2.12zm6.97 0c-1.03 0-1.89-.95-1.89-2.12s.84-2.12 1.89-2.12c1.06 0 1.9.96 1.89 2.12c0 1.17-.83 2.12-1.89 2.12z',
  );
  svg.appendChild(path);
  return svg;
}

function createDiscordButton(onConnect: () => void): HTMLButtonElement {
  const button = el('button', { type: 'button', class: 'discord-button' }, [
    createDiscordLogoSvg(),
    el('span', {}, ['Discordで連携する']),
  ]);
  button.addEventListener('click', onConnect);
  return button;
}

function createCard(children: Node[]): HTMLDivElement {
  return el('div', { class: 'card' }, children);
}

function renderLoading(): HTMLDivElement {
  return createCard([
    el('div', { class: 'loading-container', role: 'status', 'aria-label': 'セッションを確認中' }, [
      el('div', { class: 'spinner', 'aria-hidden': 'true' }, []),
      el('p', { class: 'body-text' }, ['セッションを確認中...']),
    ]),
  ]);
}

function renderNotLinked(onConnect: () => void): HTMLDivElement {
  return createCard([
    el('h1', { class: 'heading' }, ['Discord連携']),
    el('p', { class: 'body-text' }, ['サービスを利用するには、Discordアカウントとの連携が必要です。']),
    createDiscordButton(onConnect),
  ]);
}

function renderLinked(onStartBilling?: () => void): HTMLDivElement {
  const badge = el('div', { class: 'badge success-badge', role: 'status' }, [
    el('span', { class: 'success-icon', 'aria-hidden': 'true' }, ['\u2713']),
    el('span', {}, ['Discord連携済み']),
  ]);

  const children: Node[] = [el('h1', { class: 'heading' }, ['Discord連携']), badge];

  if (onStartBilling) {
    const startBtn = el('button', { type: 'button', class: 'submit-button start-billing-button' }, [
      'プランを選択して登録する',
    ]);
    startBtn.addEventListener('click', onStartBilling);
    children.push(el('div', { class: 'plan-placeholder' }, [startBtn]));
  } else {
    children.push(
      el('div', { class: 'plan-placeholder' }, [
        el('p', { class: 'body-text' }, ['プラン選択は次のステップで利用可能になります。']),
      ]),
    );
  }

  return createCard(children);
}

function renderError(onConnect: () => void, message?: string): HTMLDivElement {
  return createCard([
    el('h1', { class: 'heading' }, ['Discord連携']),
    el('div', { class: 'badge error-badge', role: 'alert' }, [
      message ?? '連携状態の確認に失敗しました。再度お試しください。',
    ]),
    createDiscordButton(onConnect),
  ]);
}

// --- Billing context (optional, for billing state) ---

export interface BillingContext {
  billingState: BillingFormState;
  billingCallbacks: BillingCallbacks;
  payjpAdapter: PayjpAdapter | null;
  plans: PlanDef[];
}

export interface SubscribedContext {
  subscription: SubscriptionInfo;
  plans: PlanDef[];
}

export function renderState(
  container: HTMLElement,
  state: AppState,
  onConnect: () => void,
  extra?: {
    onStartBilling?: () => void;
    billing?: BillingContext;
    subscribed?: SubscribedContext;
    errorMessage?: string;
  },
): void {
  container.replaceChildren();
  switch (state) {
    case 'loading':
      container.appendChild(renderLoading());
      break;
    case 'not_linked':
      container.appendChild(renderNotLinked(onConnect));
      break;
    case 'linked':
      if (extra?.subscribed) {
        renderSubscribed(container, extra.subscribed.subscription, extra.subscribed.plans);
      } else {
        container.appendChild(renderLinked(extra?.onStartBilling));
      }
      break;
    case 'error':
      container.appendChild(renderError(onConnect, extra?.errorMessage));
      break;
    case 'billing':
      if (extra?.billing) {
        renderBilling(
          container,
          extra.billing.billingState,
          extra.billing.billingCallbacks,
          extra.billing.payjpAdapter,
          extra.billing.plans,
        );
      }
      break;
  }
}
