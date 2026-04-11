import type { BillingCallbacks } from './billing-ui.js';
import { renderBilling, renderSubscribed, renderSuccess } from './billing-ui.js';
import { renderCancelComplete, renderCancelError } from './cancel-ui.js';
import { el } from './dom.js';
import type {
  AppState,
  BillingFormState,
  CancelResponse,
  CancelUIError,
  MemberRoleState,
  PayjpAdapter,
  PlanDef,
  SubscribeResponse,
  SubscriptionInfo,
} from './types.js';
import { createDiscordLogoSvg } from './widgets.js';

function createDiscordButton(onConnect: () => void): HTMLButtonElement {
  const button = el('button', { type: 'button', class: 'discord-button' }, [
    createDiscordLogoSvg(24),
    el('span', {}, ['Discordと連携する']),
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

function renderError(message?: string): HTMLDivElement {
  const reloadBtn = el('button', { type: 'button', class: 'submit-button' }, ['再読み込み']);
  reloadBtn.addEventListener('click', () => {
    window.location.reload();
  });
  return createCard([
    el('h1', { class: 'heading' }, ['エラー']),
    el('div', { class: 'badge error-badge', role: 'alert' }, [
      message ?? '状態の確認に失敗しました。再度お試しください。',
    ]),
    reloadBtn,
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
  /** From GET /v1/members/me — Discord role revoke state when subscription is canceled */
  memberRoleState?: MemberRoleState | null;
}

export function renderState(
  container: HTMLElement,
  state: AppState,
  onConnect: () => void,
  extra?: {
    billing?: BillingContext;
    subscribed?: SubscribedContext;
    errorMessage?: string;
    registerComplete?: {
      result: SubscribeResponse;
      plans: PlanDef[];
      onLinkDiscord?: () => void;
      onBackToTop: () => void;
      linkError?: string;
    };
    linkComplete?: { roleGranted: boolean; onBackToTop: () => void };
    cancelComplete?: { result: CancelResponse };
    cancelError?: CancelUIError;
  },
): void {
  container.replaceChildren();
  switch (state) {
    case 'loading':
      container.appendChild(renderLoading());
      break;
    case 'linked':
      if (extra?.subscribed) {
        renderSubscribed(
          container,
          extra.subscribed.subscription,
          extra.subscribed.plans,
          extra.subscribed.onStartCancel,
          extra.subscribed.memberRoleState,
        );
      } else {
        container.appendChild(renderError('ページの表示に失敗しました。再読み込みしてください。'));
      }
      break;
    case 'error':
      container.appendChild(renderError(extra?.errorMessage));
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
        container.appendChild(renderError('ページの表示に失敗しました。再読み込みしてください。'));
      }
      break;
    case 'register_complete':
      if (extra?.registerComplete) {
        const { result, plans, onLinkDiscord, linkError } = extra.registerComplete;
        const successEl = renderSuccess(result, plans);
        if (onLinkDiscord) {
          const plan = plans.find((p) => p.id === result.planId);
          const planName = plan?.name ?? 'ご契約中のプラン';
          const linkChildren: (Node | string)[] = [];
          if (linkError) {
            linkChildren.push(el('div', { class: 'error-banner', role: 'alert' }, [linkError]));
          }
          linkChildren.push(
            el('span', { class: 'discord-status-badge--unlinked' }, ['Discord: 未連携']),
            createDiscordButton(onLinkDiscord),
            el('p', { class: 'body-text' }, ['Discordと連携してサーバに参加してください！']),
            el('p', { class: 'body-text-sub' }, [`${planName} に対応したDiscordロールが付与されます。`]),
          );
          successEl.appendChild(el('div', { class: 'discord-link-section' }, linkChildren));
        }
        container.appendChild(successEl);
      } else {
        console.error('[ui] renderState("register_complete") called without registerComplete context');
        container.appendChild(renderError('ページの表示に失敗しました。再読み込みしてください。'));
      }
      break;
    case 'link_complete':
      if (extra?.linkComplete) {
        const msg = extra.linkComplete.roleGranted
          ? 'Discord連携が完了し、ロールが付与されました。'
          : 'Discord連携が完了しました。';
        const backBtn = el('button', { type: 'button', class: 'submit-button' }, ['トップに戻る']);
        backBtn.addEventListener('click', extra.linkComplete.onBackToTop);
        container.appendChild(
          el('div', { class: 'card card--centered' }, [
            el('h1', { class: 'heading' }, ['連携完了']),
            el('div', { class: 'badge success-badge', role: 'status' }, [
              el('span', { class: 'success-icon', 'aria-hidden': 'true' }, ['\u2713']),
              el('span', {}, [msg]),
            ]),
            backBtn,
          ]),
        );
      } else {
        container.appendChild(renderError('ページの表示に失敗しました。再読み込みしてください。'));
      }
      break;
    case 'cancel_complete':
      if (extra?.cancelComplete) {
        renderCancelComplete(container, extra.cancelComplete.result, () => {
          window.location.reload();
        });
      } else {
        console.error('[ui] renderState("cancel_complete") called without cancelComplete context');
        container.appendChild(renderError('ページの表示に失敗しました。再読み込みしてください。'));
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
        container.appendChild(renderError('ページの表示に失敗しました。再読み込みしてください。'));
      }
      break;
  }
}
