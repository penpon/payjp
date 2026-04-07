import { el } from './dom.js';
import type {
  BillingError,
  BillingFormState,
  PayjpAdapter,
  PayjpCardElement,
  PlanDef,
  SubscribeResponse,
  SubscriptionInfo,
} from './types.js';

// --- Callbacks interface ---

export interface BillingCallbacks {
  onSubmit: (data: { planId: string; email: string; cardholderName: string; privacyConsented: boolean }) => void;
  onRetry: () => void;
  onBackToTop: () => void;
  onCardElementReady?: (element: PayjpCardElement) => void;
}

// --- Main render function ---

export function renderBilling(
  container: HTMLElement,
  state: BillingFormState,
  callbacks: BillingCallbacks,
  payjpAdapter: PayjpAdapter | null,
  plans: PlanDef[],
): void {
  container.replaceChildren();

  switch (state.step) {
    case 'form':
      renderBillingForm(container, state, callbacks, payjpAdapter, plans);
      break;
    case 'submitting':
      container.appendChild(renderSubmitting());
      break;
    case 'success':
      container.appendChild(renderSuccess(state.result!, plans, callbacks));
      break;
    case 'error':
      container.appendChild(renderError(state.error!, callbacks));
      break;
  }
}

// --- Subscribed state (for returning users) ---

export function renderSubscribed(container: HTMLElement, subscription: SubscriptionInfo, plans: PlanDef[]): void {
  container.replaceChildren();
  const plan = plans.find((p) => p.id === subscription.planId);
  const planName = plan?.name ?? subscription.planId ?? '不明';

  const statusLabel =
    subscription.status === 'active'
      ? '有効'
      : subscription.status === 'trial'
        ? 'トライアル'
        : subscription.status === 'canceled'
          ? '解約予定'
          : subscription.status;

  const card = el('div', { class: 'card' }, [
    el('h1', { class: 'heading' }, ['購読状況']),
    el('div', { class: 'subscribed-status' }, [
      el('div', { class: 'success-icon-large', 'aria-hidden': 'true' }, ['\u2713']),
      el('p', { class: 'subscribed-plan-name' }, [planName]),
      el('div', { class: 'status-badge', role: 'status' }, [statusLabel]),
    ]),
    ...(subscription.accessEndAt
      ? [el('p', { class: 'subscribed-detail' }, [`次回更新日: ${formatDate(subscription.accessEndAt)}`])]
      : []),
  ]);

  container.appendChild(card);
}

// --- Form step ---

function renderBillingForm(
  container: HTMLElement,
  state: BillingFormState,
  callbacks: BillingCallbacks,
  payjpAdapter: PayjpAdapter | null,
  plans: PlanDef[],
): void {
  let selectedPlanId = state.selectedPlanId ?? plans[0]?.id ?? '';
  let email = state.email;
  let cardholderName = state.cardholderName;
  let consented = state.privacyConsented;
  let cardComplete = false;

  // Plan selection
  const planContainer = el('div', { class: 'plan-grid', role: 'radiogroup', 'aria-label': 'プラン選択' });
  const planCards: HTMLElement[] = [];

  for (const plan of plans) {
    const card = el(
      'div',
      {
        class: `plan-card${plan.id === selectedPlanId ? ' plan-card--selected' : ''}`,
        role: 'radio',
        'aria-checked': plan.id === selectedPlanId ? 'true' : 'false',
        tabindex: '0',
      },
      [
        el('div', { class: 'plan-card-name' }, [plan.name]),
        el('div', { class: 'plan-card-price' }, [`\u00A5${plan.price.toLocaleString()}`]),
        el('div', { class: 'plan-card-interval' }, ['/月']),
        el(
          'ul',
          { class: 'plan-card-features' },
          plan.features.map((f) => el('li', {}, [f])),
        ),
      ],
    );

    card.addEventListener('click', () => {
      selectedPlanId = plan.id;
      for (const pc of planCards) {
        pc.classList.remove('plan-card--selected');
        pc.setAttribute('aria-checked', 'false');
      }
      card.classList.add('plan-card--selected');
      card.setAttribute('aria-checked', 'true');
    });

    card.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        card.click();
      }
    });

    planCards.push(card);
    planContainer.appendChild(card);
  }

  // Email input
  const emailInput = el('input', {
    type: 'email',
    class: 'form-input',
    id: 'billing-email',
    placeholder: 'mail@example.com',
    autocomplete: 'email',
    required: 'true',
    value: email,
  }) as HTMLInputElement;
  emailInput.addEventListener('input', () => {
    email = emailInput.value;
    updateSubmitState();
  });

  // Cardholder name input
  const nameInput = el('input', {
    type: 'text',
    class: 'form-input',
    id: 'billing-name',
    placeholder: 'TARO YAMADA',
    autocomplete: 'cc-name',
    required: 'true',
    value: cardholderName,
  }) as HTMLInputElement;
  nameInput.addEventListener('input', () => {
    cardholderName = nameInput.value;
    updateSubmitState();
  });

  // PAY.JP card element mount point
  const cardMountPoint = el('div', { id: 'payjp-card-element', class: 'payjp-mount' });

  // Consent checkbox
  const checkbox = el('input', {
    type: 'checkbox',
    id: 'billing-consent',
    class: 'consent-checkbox',
  }) as HTMLInputElement;
  if (consented) checkbox.checked = true;
  checkbox.addEventListener('change', () => {
    consented = checkbox.checked;
    updateSubmitState();
  });

  // Submit button
  const submitBtn = el(
    'button',
    {
      type: 'button',
      class: 'submit-button',
      disabled: 'true',
    },
    ['登録する'],
  );

  function updateSubmitState(): void {
    const valid =
      selectedPlanId !== '' && email.trim() !== '' && cardholderName.trim() !== '' && consented && cardComplete;
    if (valid) {
      submitBtn.removeAttribute('disabled');
    } else {
      submitBtn.setAttribute('disabled', 'true');
    }
  }

  submitBtn.addEventListener('click', () => {
    if (submitBtn.hasAttribute('disabled')) return;
    callbacks.onSubmit({
      planId: selectedPlanId,
      email: email.trim(),
      cardholderName: cardholderName.trim(),
      privacyConsented: consented,
    });
  });

  // Error banner (if returning from error)
  const errorBanner = state.error ? el('div', { class: 'error-banner', role: 'alert' }, [state.error.message]) : null;

  // Build form
  const form = el('div', { class: 'card billing-card' }, [
    el('h1', { class: 'heading' }, ['プランを選択']),
    ...(errorBanner ? [errorBanner] : []),
    planContainer,
    el('div', { class: 'form-section' }, [
      el('h2', { class: 'form-section-title' }, ['お支払い情報']),
      el('div', { class: 'form-group' }, [
        el('label', { class: 'form-label', for: 'billing-email' }, ['メールアドレス']),
        emailInput,
      ]),
      el('div', { class: 'form-group' }, [
        el('label', { class: 'form-label', for: 'billing-name' }, ['カード名義（半角英字）']),
        nameInput,
      ]),
      el('div', { class: 'form-group' }, [el('label', { class: 'form-label' }, ['カード情報']), cardMountPoint]),
    ]),
    el('div', { class: 'consent-row' }, [
      checkbox,
      el('label', { class: 'consent-label', for: 'billing-consent' }, [
        el('a', { href: '/privacy.html', target: '_blank', class: 'consent-link' }, ['個人情報の取り扱い']),
        'に同意する',
      ]),
    ]),
    submitBtn,
  ]);

  container.appendChild(form);

  // Mount PAY.JP card element after DOM insertion
  if (payjpAdapter) {
    queueMicrotask(() => {
      const target = container.querySelector('#payjp-card-element');
      if (target) {
        const cardElement = payjpAdapter.createCardElement(target as HTMLElement);
        callbacks.onCardElementReady?.(cardElement);
        cardElement.on('change', (e) => {
          cardComplete = e.complete;
          updateSubmitState();

          // Show/clear inline error
          const existing = container.querySelector('.card-error');
          if (e.error) {
            if (existing) {
              existing.textContent = e.error.message;
            } else {
              const errEl = el('div', { class: 'card-error', role: 'alert' }, [e.error.message]);
              cardMountPoint.after(errEl);
            }
          } else if (existing) {
            existing.remove();
          }
        });
      }
    });
  }
}

// --- Submitting step ---

function renderSubmitting(): HTMLDivElement {
  return el('div', { class: 'card' }, [
    el('div', { class: 'loading-container', role: 'status', 'aria-label': '処理中' }, [
      el('div', { class: 'spinner', 'aria-hidden': 'true' }),
      el('p', { class: 'body-text' }, ['処理中...']),
      el('p', { class: 'body-text-sub' }, ['3Dセキュア認証画面が表示される場合があります。']),
    ]),
  ]);
}

// --- Success step ---

function renderSuccess(result: SubscribeResponse, plans: PlanDef[], callbacks: BillingCallbacks): HTMLDivElement {
  const plan = plans.find((p) => p.id === result.planId);
  const planName = plan?.name ?? result.planId;

  const statusLabel = result.trialApplied ? 'トライアル' : '有効';

  const backBtn = el('button', { type: 'button', class: 'secondary-button' }, ['トップに戻る']);
  backBtn.addEventListener('click', callbacks.onBackToTop);

  return el('div', { class: 'card' }, [
    el('div', { class: 'success-container' }, [
      el('div', { class: 'success-icon-large', 'aria-hidden': 'true' }, ['\u2713']),
      el('h1', { class: 'success-heading' }, ['登録が完了しました']),
    ]),
    el('div', { class: 'result-details' }, [
      el('div', { class: 'result-row' }, [
        el('span', { class: 'result-label' }, ['プラン']),
        el('span', { class: 'result-value' }, [planName]),
      ]),
      el('div', { class: 'result-row' }, [
        el('span', { class: 'result-label' }, ['ステータス']),
        el('span', { class: 'status-badge' }, [statusLabel]),
      ]),
      ...(result.trialApplied
        ? [
            el('div', { class: 'result-row' }, [
              el('span', { class: 'result-label' }, ['トライアル期間']),
              el('span', { class: 'result-value' }, [`${formatDate(result.accessEndAt)} まで`]),
            ]),
          ]
        : []),
      el('div', { class: 'result-row' }, [
        el('span', { class: 'result-label' }, ['次回更新日']),
        el('span', { class: 'result-value' }, [formatDate(result.accessEndAt)]),
      ]),
    ]),
    backBtn,
  ]);
}

// --- Error step ---

function renderError(error: BillingError, callbacks: BillingCallbacks): HTMLDivElement {
  const children: (Node | string)[] = [el('h1', { class: 'heading' }, ['エラーが発生しました'])];

  if (error.kind === 'inflight') {
    const bannerText = error.operationId
      ? '処理中の操作があります。以下のIDをサポートにお知らせください。'
      : '処理中の操作があります。サポートまでお問い合わせください。';
    children.push(el('div', { class: 'error-banner', role: 'alert' }, [bannerText]));
    if (error.operationId) {
      children.push(
        el('div', { class: 'operation-id-box' }, [
          el('code', { class: 'operation-id-value' }, [error.operationId]),
          createCopyButton(error.operationId),
        ]),
      );
    }
    children.push(el('p', { class: 'body-text' }, ['自動再試行は行われません。サポートにて状況を確認いたします。']));
  } else if (error.kind === 'session_expired') {
    children.push(el('div', { class: 'error-banner', role: 'alert' }, [error.message]));
    const reAuthBtn = el('button', { type: 'button', class: 'discord-button' }, ['再度Discordで連携する']);
    reAuthBtn.addEventListener('click', callbacks.onBackToTop);
    children.push(reAuthBtn);
  } else if (error.kind === 'already_subscribed') {
    children.push(el('div', { class: 'info-banner', role: 'status' }, ['すでにプランに加入済みです。']));
    const topBtn = el('button', { type: 'button', class: 'secondary-button' }, ['トップに戻る']);
    topBtn.addEventListener('click', callbacks.onBackToTop);
    children.push(topBtn);
  } else {
    children.push(el('div', { class: 'error-banner', role: 'alert' }, [error.message]));
    const retryBtn = el('button', { type: 'button', class: 'submit-button' }, ['もう一度試す']);
    retryBtn.addEventListener('click', callbacks.onRetry);
    children.push(retryBtn);
  }

  return el('div', { class: 'card' }, children);
}

// --- Helpers ---

function createCopyButton(text: string): HTMLButtonElement {
  const btn = el('button', { type: 'button', class: 'copy-button', 'aria-label': 'コピー' }, ['コピー']);
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = 'コピー済み';
      setTimeout(() => {
        btn.textContent = 'コピー';
      }, 2000);
    } catch {
      // Fallback: select text
      const range = document.createRange();
      const codeEl = btn.previousElementSibling;
      if (codeEl) {
        range.selectNodeContents(codeEl);
        window.getSelection()?.removeAllRanges();
        window.getSelection()?.addRange(range);
      }
    }
  });
  return btn;
}

const JST_DATE_FORMATTER = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function formatDate(isoString: string): string {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return isoString;
  const parts = JST_DATE_FORMATTER.formatToParts(date);
  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  const d = parts.find((p) => p.type === 'day')?.value;
  if (!y || !m || !d) return isoString;
  return `${y}/${m}/${d}`;
}
