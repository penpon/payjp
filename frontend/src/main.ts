import {
  cancelSubscription,
  checkSession,
  createSubscription,
  fetchSubscriptionStatus,
  SessionCheckError,
  SubscriptionStatusError,
  startOAuth,
} from './api.js';
import type { BillingCallbacks } from './billing-ui.js';
import { showCancelConfirmModal } from './cancel-ui.js';
import { mapCancelError } from './map-cancel-error.js';
import { mapSubscribeError } from './map-subscribe-error.js';
import type { BillingFormState, PayjpAdapter, PlanDef } from './types.js';
import { renderState } from './ui.js';

const CANCEL_PENDING_KEY = 'cancelPending';
/** Max age for cancelPending flag: 10 minutes. Prevents stale intent from firing on later page visits. */
const CANCEL_PENDING_TTL_MS = 10 * 60 * 1000;

/** Set cancelPending with a timestamp so it expires after CANCEL_PENDING_TTL_MS. */
function setCancelPending(): void {
  sessionStorage.setItem(CANCEL_PENDING_KEY, String(Date.now()));
}

/** Returns true only if cancelPending is set and has not expired. */
function isCancelPendingValid(): boolean {
  const raw = sessionStorage.getItem(CANCEL_PENDING_KEY);
  if (!raw) return false;
  const ts = Number(raw);
  return !Number.isNaN(ts) && Date.now() - ts < CANCEL_PENDING_TTL_MS;
}

/** OAuth 後も未連携のときは退会意図フラグを捨てる（次回の別ログインで誤って cancel API を叩かない） */
function clearStaleCancelPending(): void {
  sessionStorage.removeItem(CANCEL_PENDING_KEY);
}

// --- Plan definitions (hardcoded for MVP) ---

const PLANS: PlanDef[] = [
  {
    id: 'plan_starter',
    name: 'スタータープラン',
    price: 25000,
    features: ['掲載枠：1枠', '応募上限：30件/月', '標準検索機能', '基本レポート'],
  },
  {
    id: 'plan_business',
    name: 'ビジネスプラン',
    price: 50000,
    features: ['掲載枠：3枠', '応募上限：100件/月', '優先表示機能', '期限付き招待枠', '商談予約機能', 'KYCバッジ'],
  },
  {
    id: 'plan_enterprise',
    name: 'エンタープライズプラン',
    price: 100000,
    features: [
      '掲載枠：10枠',
      '応募上限：300件/月',
      'トップ掲載枠',
      'チーム席数：5名',
      'CS伴走サポート',
      'API連携（β）',
    ],
  },
];

const PAYJP_PUBLIC_KEY = import.meta.env.VITE_PAYJP_PUBLIC_KEY as string | undefined;

// --- PAY.JP adapter ---

function createPayjpAdapter(): PayjpAdapter | null {
  if (typeof window.Payjp !== 'function') {
    console.error('[billing] PAY.JP.js (pay.js) が読み込まれていません');
    return null;
  }
  if (!PAYJP_PUBLIC_KEY || PAYJP_PUBLIC_KEY === 'pk_test_') {
    console.error('[billing] VITE_PAYJP_PUBLIC_KEY が未設定です。.env を確認してください');
    return null;
  }

  try {
    const payjp = window.Payjp(PAYJP_PUBLIC_KEY, { threeDSecureWorkflow: 'subwindow' });
    const elements = payjp.elements({ locale: 'ja' });
    let cachedCard: ReturnType<typeof elements.create> | null = null;

    return {
      createCardElement(selector) {
        if (!cachedCard) {
          cachedCard = elements.create('card', {
            style: {
              base: {
                color: '#061b31',
                fontSize: '16px',
                fontFamily: 'Inter, "Noto Sans JP", sans-serif',
                '::placeholder': { color: '#64748d' },
              },
              invalid: { color: '#ea2261' },
            },
          });
        }
        cachedCard.mount(selector);
        return cachedCard;
      },
      async createToken(cardElement, data) {
        try {
          const result = await payjp.createToken(
            cardElement,
            { three_d_secure: true, card: { name: data.name, email: data.email } },
            { threeDSecureDialogOptions: { timeout: 1800000 } },
          );
          if (result.error) {
            return { error: result.error.message };
          }
          if (!result.id) {
            return { error: 'トークンの取得に失敗しました。' };
          }
          // CLAUDE.md: 3DS verified のみ許可（attempted も非許容）
          if (result.card?.three_d_secure_status !== 'verified') {
            return { error: '3Dセキュア認証が完了していません。もう一度お試しください。' };
          }
          return { tokenId: result.id };
        } catch (err) {
          console.error('[billing] PAY.JP createToken failed:', err);
          return { error: '3Dセキュア認証に失敗しました。もう一度お試しください。' };
        }
      },
    };
  } catch (err) {
    console.error('[billing] PAY.JP initialization failed:', err);
    return null;
  }
}

// --- Billing flow ---

function startBillingFlow(app: HTMLElement): void {
  const payjpAdapter = createPayjpAdapter();
  if (!payjpAdapter) {
    renderState(app, 'error', startOAuth, {
      errorMessage: 'カード入力機能を読み込めませんでした。ページを再読み込みしてください。',
    });
    return;
  }

  let billingState: BillingFormState = {
    step: 'form',
    selectedPlanId: PLANS[0]?.id ?? null,
    email: '',
    cardholderName: '',
    privacyConsented: false,
    error: null,
    result: null,
  };

  let currentCardElement: import('./types.js').PayjpCardElement | null = null;
  let isSubmitting = false;

  function update(patch: Partial<BillingFormState>): void {
    billingState = { ...billingState, ...patch };
    render();
  }

  function render(): void {
    renderState(app, 'billing', startOAuth, {
      billing: {
        billingState,
        billingCallbacks: callbacks,
        payjpAdapter,
        plans: PLANS,
      },
    });
  }

  const callbacks: BillingCallbacks = {
    onCardElementReady: (element) => {
      currentCardElement = element;
    },
    onSubmit: async (data) => {
      if (!payjpAdapter || !currentCardElement) {
        update({
          step: 'error',
          error: {
            kind: 'server_error',
            message: 'カード入力が初期化されていません。ページを再読み込みしてください。',
          },
        });
        return;
      }

      // Double-submit guard (3DS popup can stay open for minutes)
      if (isSubmitting) return;
      isSubmitting = true;

      try {
        // Save form data WITHOUT re-rendering (preserves PAY.JP card iframe)
        billingState = {
          ...billingState,
          email: data.email,
          cardholderName: data.cardholderName,
          selectedPlanId: data.planId,
          privacyConsented: data.privacyConsented,
        };

        // Disable submit button inline instead of destroying DOM
        const submitBtn = app.querySelector('.submit-button') as HTMLButtonElement | null;
        if (submitBtn) {
          submitBtn.setAttribute('disabled', 'true');
          submitBtn.textContent = '処理中...';
        }

        // 1. Create PAY.JP token with 3DS (card iframe must remain mounted)
        const tokenResult = await payjpAdapter.createToken(currentCardElement, {
          name: data.cardholderName,
          email: data.email,
        });

        if (tokenResult.error || !tokenResult.tokenId) {
          currentCardElement = null; // Card iframe will be re-mounted after re-render
          update({
            step: 'form',
            selectedPlanId: data.planId,
            email: data.email,
            cardholderName: data.cardholderName,
            error: { kind: 'three_ds_failed', message: tokenResult.error ?? '3Dセキュア認証に失敗しました。' },
          });
          return;
        }

        // Now safe to destroy DOM — card data is captured in token
        update({ step: 'submitting' });

        // 2. POST /v1/subscriptions
        const result = await createSubscription({
          planId: data.planId,
          email: data.email,
          payjpToken: tokenResult.tokenId,
          privacyConsented: data.privacyConsented,
        });

        renderState(app, 'register_complete', startOAuth, {
          registerComplete: {
            result,
            plans: PLANS,
            onBackToTop: () => {
              void init();
            },
          },
        });
      } catch (err) {
        console.error('[billing] onSubmit failed:', err);
        update({ step: 'error', error: mapSubscribeError(err) });
      } finally {
        isSubmitting = false;
      }
    },

    onRetry: () => {
      currentCardElement = null; // Clear stale reference; new element will be set via onCardElementReady
      update({ step: 'form', error: null });
    },

    onBackToTop: () => {
      void init();
    },

    onReAuth: () => {
      startOAuth();
    },
  };

  render();
}

// --- Cancel flow ---

function startCancelFlow(app: HTMLElement): void {
  let dismiss: (() => void) | null = null;
  dismiss = showCancelConfirmModal(app, {
    onConfirm: () => {
      dismiss?.();
      setCancelPending();
      startOAuth();
    },
    onDismiss: () => {
      dismiss?.();
      dismiss = null;
    },
  });
}

// --- Init ---

async function init(): Promise<void> {
  const app = document.getElementById('app');
  if (!app) {
    console.error('[init] #app element not found — cannot render application');
    document.body.textContent = 'ページの読み込みに失敗しました。ページを再読み込みしてください。';
    return;
  }

  renderState(app, 'loading', startOAuth);

  try {
    const session = await checkSession();
    if (session.linked) {
      // Check for pending cancel after OAuth redirect (TTL-validated to prevent stale intent)
      if (isCancelPendingValid()) {
        sessionStorage.removeItem(CANCEL_PENDING_KEY);
        renderState(app, 'loading', startOAuth);
        try {
          const result = await cancelSubscription();
          renderState(app, 'cancel_complete', startOAuth, { cancelComplete: { result } });
        } catch (err) {
          console.error('[cancel] cancelSubscription failed:', err);
          const cancelError = mapCancelError(err);
          renderState(
            app,
            'cancel_error',
            cancelError.kind === 'session_expired'
              ? () => {
                  setCancelPending();
                  startOAuth();
                }
              : startOAuth,
            { cancelError },
          );
        }
        return;
      }

      let subscription: Awaited<ReturnType<typeof fetchSubscriptionStatus>>;
      try {
        subscription = await fetchSubscriptionStatus();
      } catch (err) {
        if (err instanceof SubscriptionStatusError) {
          console.error('[init] Subscription status unavailable:', err);
          renderState(app, 'error', startOAuth, {
            errorMessage: '購読状況を確認できませんでした。しばらく経ってから再度お試しください。',
          });
          return;
        }
        throw err;
      }

      if (subscription) {
        renderState(app, 'linked', startOAuth, {
          subscribed: {
            subscription,
            plans: PLANS,
            onStartCancel: () => startCancelFlow(app),
          },
        });
        return;
      }

      if (!session.discordUserId) {
        renderState(app, 'error', startOAuth, {
          errorMessage: 'セッション情報が不完全です。再度Discordで連携してください。',
        });
        return;
      }

      renderState(app, 'linked', startOAuth, {
        onStartBilling: () => startBillingFlow(app),
      });
    } else {
      clearStaleCancelPending();
      renderState(app, 'not_linked', startOAuth);
    }
  } catch (err) {
    if (err instanceof SessionCheckError && err.status === 401) {
      clearStaleCancelPending();
      renderState(app, 'not_linked', startOAuth);
    } else {
      console.error('[init] Session check failed:', err);
      renderState(app, 'error', startOAuth);
    }
  }
}

init().catch((err) => {
  console.error('[init] Unhandled error:', err);
  const app = document.getElementById('app');
  if (app) app.textContent = '予期しないエラーが発生しました。ページを再読み込みしてください。';
});
