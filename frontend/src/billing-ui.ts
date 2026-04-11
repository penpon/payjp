import { el } from './dom.js';
import {
  createBackToTopButton,
  renderInflightSection,
  renderOperationIdBox,
  renderSessionExpiredSection,
  renderWarningBanner,
} from './error-ui.js';
import { formatDate } from './format.js';
import type {
  BillingError,
  BillingFormState,
  MemberRoleState,
  PayjpAdapter,
  PayjpCardElement,
  PlanDef,
  SubscribeResponse,
  SubscriptionInfo,
} from './types.js';

// --- Callbacks interface ---

export interface BillingCallbacks {
  onSubmit: (data: {
    planId: string;
    email: string;
    cardholderName: string;
    privacyConsented: boolean;
  }) => void | Promise<void>;
  onRetry: () => void;
  /** Return to app home (re-run session / subscription checks). Not for OAuth. */
  onBackToTop: () => void;
  /** Start Discord OAuth (e.g. session expired). */
  onReAuth: () => void;
  onCardElementReady?: (element: PayjpCardElement) => void;
}

// --- Main render function ---

/** Appends billing UI into `container`. Caller should clear the container first (e.g. `replaceChildren()`). */
export function renderBilling(
  container: HTMLElement,
  state: BillingFormState,
  callbacks: BillingCallbacks,
  payjpAdapter: PayjpAdapter | null,
  plans: PlanDef[],
): void {
  switch (state.step) {
    case 'form':
      renderBillingForm(container, state, callbacks, payjpAdapter, plans);
      break;
    case 'submitting':
      container.appendChild(renderSubmitting());
      break;
    case 'success':
      if (!state.result) {
        console.error('[billing] step=success but result is null — state machine error');
        container.appendChild(
          renderError(
            { kind: 'server_error', message: '表示エラーが発生しました。ページを再読み込みしてください。' },
            callbacks,
          ),
        );
      } else {
        container.appendChild(renderSuccess(state.result, plans, callbacks.onBackToTop));
      }
      break;
    case 'error':
      if (!state.error) {
        console.error('[billing] step=error but error is null — state machine error');
        container.appendChild(
          renderError(
            { kind: 'server_error', message: '予期しないエラーが発生しました。ページを再読み込みしてください。' },
            callbacks,
          ),
        );
      } else {
        container.appendChild(renderError(state.error, callbacks));
      }
      break;
  }
}

// --- Subscribed state (for returning users) ---

/** Appends subscribed summary into `container`. Caller should clear the container first (e.g. `replaceChildren()`). */
export function renderSubscribed(
  container: HTMLElement,
  subscription: SubscriptionInfo,
  plans: PlanDef[],
  onStartCancel?: () => void,
  memberRoleState?: MemberRoleState | null,
): void {
  const plan = plans.find((p) => p.id === subscription.planId);
  const planName = plan?.name ?? subscription.planId ?? '不明';

  const STATUS_LABELS: Record<string, string> = {
    active: '有効',
    trial: 'トライアル',
    canceled: '退会済み',
  };
  const statusLabel = STATUS_LABELS[subscription.status] ?? subscription.status;
  const isWithdrawn = subscription.status === 'canceled';
  const needsDiscordRoleConfirmation = isWithdrawn && (memberRoleState === 'unknown' || memberRoleState === 'granted');

  const statusRowChildren: (Node | string)[] = [
    el('div', { class: 'success-icon-large', 'aria-hidden': 'true' }, ['\u2713']),
    el('p', { class: 'subscribed-plan-name' }, [planName]),
    el('div', { class: 'status-badge', role: 'status' }, [statusLabel]),
  ];

  const cardChildren: (Node | string)[] = [
    el('h1', { class: 'heading' }, ['購読状況']),
    ...(needsDiscordRoleConfirmation
      ? [
          renderWarningBanner(
            '課金停止は反映済みです。Discordロールの削除を確認中です。しばらくしてからページを再読み込みしてください。',
          ),
        ]
      : []),
    el(
      'div',
      {
        class: `subscribed-status${needsDiscordRoleConfirmation ? ' subscribed-status--pending-discord' : ''}`,
      },
      statusRowChildren,
    ),
    ...(subscription.accessEndAt
      ? [
          el('p', { class: 'subscribed-detail' }, [
            isWithdrawn
              ? `ご利用終了日: ${formatDate(subscription.accessEndAt)}`
              : `次回更新日: ${formatDate(subscription.accessEndAt)}`,
          ]),
        ]
      : []),
  ];

  cardChildren.push(el('p', { class: 'subscribed-detail discord-linked-badge' }, ['Discord: 連携済み ✓']));

  if (isWithdrawn) {
    cardChildren.push(
      el('hr', { class: 'cancel-separator' }),
      el('div', { class: 'cancel-section' }, [
        el('h2', { class: 'cancel-section-title' }, ['退会']),
        el('p', { class: 'cancel-section-desc' }, [
          '退会手続きが完了しています。現在の期間終了日までサービスをご利用いただけます。',
        ]),
        el('p', { class: 'cancel-section-withdrawn', role: 'status' }, ['退会済み']),
      ]),
    );
  } else if (onStartCancel) {
    const cancelBtn = el('button', { type: 'button', class: 'cancel-button' }, ['退会する']);
    cancelBtn.addEventListener('click', onStartCancel);

    cardChildren.push(
      el('hr', { class: 'cancel-separator' }),
      el('div', { class: 'cancel-section' }, [
        el('h2', { class: 'cancel-section-title' }, ['退会']),
        el('p', { class: 'cancel-section-desc' }, [
          '退会後も現在の期間終了日までサービスをご利用いただけます。Google Formにて退会理由を送信すると、送信後に課金停止とDiscordロールの反映が行われます。',
        ]),
        cancelBtn,
      ]),
    );
  }

  container.appendChild(el('div', { class: 'card' }, cardChildren));
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
  let cardNumberComplete = false;
  let cardExpiryComplete = false;
  let cardCvcComplete = false;

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
      updateSubmitState();
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

  // PAY.JP card element mount points
  const cardNumberMount = el('div', { id: 'payjp-card-number', class: 'payjp-mount' });
  const cardExpiryMount = el('div', { id: 'payjp-card-expiry', class: 'payjp-mount' });
  const cardCvcMount = el('div', { id: 'payjp-card-cvc', class: 'payjp-mount' });

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
    const cardComplete = cardNumberComplete && cardExpiryComplete && cardCvcComplete;
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
    Promise.resolve(
      callbacks.onSubmit({
        planId: selectedPlanId,
        email: email.trim(),
        cardholderName: cardholderName.trim(),
        privacyConsented: consented,
      }),
    ).catch((err) => {
      console.error('[billing] onSubmit rejected unexpectedly:', err);
      callbacks.onRetry();
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
        el('label', { class: 'form-label', for: 'billing-email' }, [
          'メールアドレス',
          el('span', { class: 'required-badge' }, ['必須']),
        ]),
        emailInput,
      ]),
      el('div', { class: 'form-group' }, [
        el('label', { class: 'form-label', for: 'billing-name' }, [
          'カード名義（半角英字）',
          el('span', { class: 'required-badge' }, ['必須']),
        ]),
        nameInput,
      ]),
      el('div', { class: 'form-group' }, [
        el('label', { class: 'form-label' }, ['カード番号', el('span', { class: 'required-badge' }, ['必須'])]),
        cardNumberMount,
      ]),
      el('div', { class: 'card-row' }, [
        el('div', { class: 'card-row-field' }, [
          el('label', { class: 'form-label' }, ['有効期限', el('span', { class: 'required-badge' }, ['必須'])]),
          cardExpiryMount,
        ]),
        el('div', { class: 'card-row-field' }, [
          el('label', { class: 'form-label' }, [
            'セキュリティコード',
            el('span', { class: 'required-badge' }, ['必須']),
          ]),
          cardCvcMount,
        ]),
      ]),
    ]),
    el('div', { class: 'consent-row' }, [
      checkbox,
      el('label', { class: 'consent-label', for: 'billing-consent' }, [
        el('a', { href: '/privacy.html', target: '_blank', rel: 'noopener noreferrer', class: 'consent-link' }, [
          '個人情報の取り扱い',
        ]),
        'に同意する',
      ]),
    ]),
    submitBtn,
  ]);

  container.appendChild(form);

  // Mount PAY.JP card elements after DOM insertion
  if (payjpAdapter) {
    queueMicrotask(() => {
      if (
        !container.querySelector('#payjp-card-number') ||
        !container.querySelector('#payjp-card-expiry') ||
        !container.querySelector('#payjp-card-cvc')
      ) {
        console.error('[billing] Card mount points not found in DOM');
        cardNumberMount.textContent = 'カード入力欄の初期化に失敗しました。ページを再読み込みしてください。';
        return;
      }
      try {
        const cardElements = payjpAdapter.createCardElements({
          cardNumber: '#payjp-card-number',
          cardExpiry: '#payjp-card-expiry',
          cardCvc: '#payjp-card-cvc',
        });
        callbacks.onCardElementReady?.(cardElements.cardNumber);

        const wireChange = (
          element: import('./types.js').PayjpCardElement,
          mountPoint: HTMLElement,
          setComplete: (v: boolean) => void,
        ): void => {
          element.on('change', (e) => {
            setComplete(e.complete);
            updateSubmitState();

            const existing = mountPoint.nextElementSibling;
            if (e.error) {
              if (existing?.classList.contains('card-error')) {
                existing.textContent = e.error.message;
              } else {
                const errEl = el('div', { class: 'card-error', role: 'alert' }, [e.error.message]);
                mountPoint.after(errEl);
              }
            } else if (existing?.classList.contains('card-error')) {
              existing.remove();
            }
          });
        };

        wireChange(cardElements.cardNumber, cardNumberMount, (v) => {
          cardNumberComplete = v;
        });
        wireChange(cardElements.cardExpiry, cardExpiryMount, (v) => {
          cardExpiryComplete = v;
        });
        wireChange(cardElements.cardCvc, cardCvcMount, (v) => {
          cardCvcComplete = v;
        });
      } catch (err) {
        console.error('[billing] PAY.JP card element creation failed:', err);
        cardNumberMount.textContent = 'カード入力欄の初期化に失敗しました。ページを再読み込みしてください。';
      }
    });
  } else {
    cardNumberMount.textContent = 'カード入力欄を読み込めませんでした。ページを再読み込みしてください。';
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

function safeTrim(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function renderSuccess(result: SubscribeResponse, plans: PlanDef[], onBackToTop?: () => void): HTMLDivElement {
  const planIdNorm = safeTrim(result.planId);
  const plan = planIdNorm ? plans.find((p) => p.id === planIdNorm) : undefined;
  const planName = plan?.name ?? (planIdNorm ? planIdNorm : 'プラン（参照できません）');
  const accessEndNorm = safeTrim(result.accessEndAt);

  const statusLabel = result.trialApplied ? 'トライアル' : '有効';

  const children: (Node | string)[] = [
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
              el('span', { class: 'result-value' }, [accessEndNorm ? `${formatDate(accessEndNorm)} まで` : '—']),
            ]),
          ]
        : [
            el('div', { class: 'result-row' }, [
              el('span', { class: 'result-label' }, ['次回更新日']),
              el('span', { class: 'result-value' }, [accessEndNorm ? formatDate(accessEndNorm) : '—']),
            ]),
          ]),
    ]),
  ];

  if (onBackToTop) {
    const backBtn = el('button', { type: 'button', class: 'secondary-button' }, ['トップに戻る']);
    backBtn.addEventListener('click', onBackToTop);
    children.push(backBtn);
  }

  return el('div', { class: 'card' }, children);
}

// --- Error step ---

function renderError(error: BillingError, callbacks: BillingCallbacks): HTMLDivElement {
  const children: (Node | string)[] = [el('h1', { class: 'heading' }, ['エラーが発生しました'])];

  if (error.kind === 'inflight') {
    children.push(...renderInflightSection(error));
  } else if (error.kind === 'session_expired') {
    children.push(...renderSessionExpiredSection(error.message, callbacks.onReAuth));
  } else if (error.kind === 'forbidden_origin') {
    children.push(el('div', { class: 'error-banner', role: 'alert' }, [error.message]));
    children.push(createBackToTopButton(callbacks.onBackToTop));
  } else if (error.kind === 'already_subscribed') {
    children.push(renderWarningBanner(error.message));
    children.push(createBackToTopButton(callbacks.onBackToTop));
  } else if (error.kind === 'discord_not_member') {
    children.push(el('div', { class: 'error-banner', role: 'alert' }, [error.message]));
    children.push(el('p', { class: 'body-text' }, ['Discordサーバーに参加後、再度お試しください。']));
    children.push(createBackToTopButton(callbacks.onBackToTop));
  } else if (error.kind === 'three_ds_failed' && error.operationId) {
    children.push(
      el('div', { class: 'error-banner', role: 'alert' }, [
        '3Dセキュア認証または決済トークンの検証に失敗しました。すぐに再試行すると別のエラーになる場合があります。以下のIDをサポートにお知らせください。',
      ]),
    );
    children.push(renderOperationIdBox(error.operationId));
    children.push(el('p', { class: 'body-text' }, ['自動再試行は行われません。サポートにて状況を確認いたします。']));
  } else {
    children.push(el('div', { class: 'error-banner', role: 'alert' }, [error.message]));
    const retryBtn = el('button', { type: 'button', class: 'submit-button' }, ['もう一度試す']);
    retryBtn.addEventListener('click', callbacks.onRetry);
    children.push(retryBtn);
  }

  return el('div', { class: 'card' }, children);
}
