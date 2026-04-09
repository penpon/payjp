import type { BillingCallbacks } from './billing-ui.js';
import { renderBilling, renderSubscribed, renderSuccess } from './billing-ui.js';
import { renderCancelComplete, renderCancelError } from './cancel-ui.js';
import { el } from './dom.js';
import type {
  AppState,
  BillingFormState,
  CancelResponse,
  CancelUIError,
  PayjpAdapter,
  PlanDef,
  SubscribeResponse,
  SubscriptionInfo,
} from './types.js';
import { createDiscordLogoSvg } from './widgets.js';

function createDiscordButton(onConnect: () => void): HTMLButtonElement {
  const button = el('button', { type: 'button', class: 'discord-button' }, [
    createDiscordLogoSvg(24),
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
  onStartCancel?: () => void;
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
    registerComplete?: { result: SubscribeResponse; plans: PlanDef[]; onBackToTop: () => void };
    cancelComplete?: { result: CancelResponse };
    cancelError?: CancelUIError;
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
        renderSubscribed(
          container,
          extra.subscribed.subscription,
          extra.subscribed.plans,
          extra.subscribed.onStartCancel,
        );
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
      } else {
        console.error('[ui] renderState("billing") called without billing context');
        container.appendChild(renderError(onConnect, 'ページの表示に失敗しました。再読み込みしてください。'));
      }
      break;
    case 'register_complete':
      if (extra?.registerComplete) {
        container.appendChild(
          renderSuccess(
            extra.registerComplete.result,
            extra.registerComplete.plans,
            extra.registerComplete.onBackToTop,
          ),
        );
      } else {
        console.error('[ui] renderState("register_complete") called without registerComplete context');
        container.appendChild(renderError(onConnect, 'ページの表示に失敗しました。再読み込みしてください。'));
      }
      break;
    case 'cancel_complete':
      if (extra?.cancelComplete) {
        renderCancelComplete(container, extra.cancelComplete.result, () => {
          window.location.reload();
        });
      } else {
        console.error('[ui] renderState("cancel_complete") called without cancelComplete context');
        container.appendChild(renderError(onConnect, 'ページの表示に失敗しました。再読み込みしてください。'));
      }
      break;
    case 'cancel_error':
      if (extra?.cancelError) {
        renderCancelError(container, extra.cancelError, {
          onBackToTop: () => {
            window.location.reload();
          },
          onReAuth: onConnect,
        });
      } else {
        console.error('[ui] renderState("cancel_error") called without cancelError context');
        container.appendChild(renderError(onConnect, 'ページの表示に失敗しました。再読み込みしてください。'));
      }
      break;
  }
}
