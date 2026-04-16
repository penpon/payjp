import './payment-page.css';
import {
  checkSession,
  createCancelFormLink,
  createSubscription,
  fetchAccessGateSession,
  fetchSubscriptionStatus,
  getMember,
  linkDiscord,
  MemberFetchError,
  SessionCheckError,
  SubscriptionStatusError,
  startOAuth,
  verifyAccessGatePasscode,
} from './api.js';
import type { BillingCallbacks } from './billing-ui.js';
import { showCancelConfirmModal } from './cancel-ui.js';
import { mapCancelError } from './map-cancel-error.js';
import { mapSubscribeError } from './map-subscribe-error.js';
import { buildSubscriptionForUi } from './member-entitlement.js';
import type { BillingFormState, PayjpAdapter, PlanDef, SubscriptionInfo } from './types.js';
import { renderState } from './ui.js';

const CANCEL_POLL_MAX_MS = 30_000;
const CANCEL_POLL_INTERVAL_MS = 1_500;

function consumeCancelSubmittedQuery(): boolean {
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  if (params.get('cancel') !== 'submitted') return false;
  params.delete('cancel');
  const qs = params.toString();
  const path = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`;
  window.history.replaceState({}, '', path);
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** When the server enforces the shared gate, block billing until `__Host-access_gate` is valid. */
async function ensureGateForBilling(app: HTMLElement): Promise<boolean> {
  try {
    const session = await fetchAccessGateSession();
    if (!session.gateEnforced || session.unlocked) {
      return true;
    }
  } catch (err) {
    console.error('[init] fetchAccessGateSession failed:', err);
    renderState(app, 'error', startOAuth, {
      errorMessage: 'アクセス確認に失敗しました。しばらく経ってから再度お試しください。',
    });
    return false;
  }

  return await new Promise((resolve) => {
    const show = (errorMessage?: string) => {
      renderState(app, 'gate_locked', startOAuth, {
        gateLock: {
          ...(errorMessage !== undefined ? { errorMessage } : {}),
          onSubmit: async (passcode) => {
            try {
              await verifyAccessGatePasscode(passcode);
              resolve(true);
            } catch (e) {
              console.warn('[init] verifyAccessGatePasscode:', e);
              show('パスコードが正しくないか、確認に失敗しました。');
            }
          },
        },
      });
    };
    show();
  });
}

/** Poll until backend reflects cancel (Google Form → Apps Script → google-submit) or timeout. */
async function pollAfterGoogleFormSubmit(): Promise<void> {
  const deadline = Date.now() + CANCEL_POLL_MAX_MS;
  while (Date.now() < deadline) {
    const m = await getMember();
    let sub: SubscriptionInfo | null = null;
    try {
      sub = await fetchSubscriptionStatus();
    } catch (err) {
      if (!(err instanceof SubscriptionStatusError)) throw err;
    }
    const canceled = m?.subscriptionStatus === 'canceled' || sub?.status === 'canceled';
    if (canceled) {
      return;
    }
    await sleep(CANCEL_POLL_INTERVAL_MS);
  }
}

// --- Plan definitions (hardcoded for MVP) ---

const PLANS: PlanDef[] = [
  {
    id: 'plan_starter',
    name: 'スタータープラン',
    price: 20000,
    features: ['SESコミュニティ参加権（月次）', 'Discord 自動招待・ロール付与', '法人向けチャンネルへのアクセス'],
  },
  {
    id: 'plan_business',
    name: 'ビジネスプラン',
    price: 50000,
    features: ['スターターの内容に加え、優先サポート枠', '追加チャンネル・資料への優先アクセス'],
  },
  {
    id: 'plan_enterprise',
    name: 'エンタープライズプラン',
    price: 70000,
    features: ['ビジネスの内容に加え、運営との個別相談枠（月1回）', 'カスタムオンボーディング支援'],
  },
];

const PAYJP_PUBLIC_KEY = import.meta.env.VITE_PAYJP_PUBLIC_KEY as string | undefined;

// --- PAY.JP adapter ---

function createPayjpAdapter(): PayjpAdapter | null {
  if (typeof window.Payjp !== 'function') {
    console.error('[billing] PAY.JP.js (pay.js) が読み込まれていません');
    return null;
  }
  if (!PAYJP_PUBLIC_KEY || !/^pk_(test|live)_[a-zA-Z0-9]{15,}$/.test(PAYJP_PUBLIC_KEY)) {
    console.error('[billing] VITE_PAYJP_PUBLIC_KEY が未設定または不正です。.env を確認してください');
    return null;
  }

  try {
    // iframe型: サブウィンドウ型よりポップアップブロック等の影響を受けにくい（2weeks-spec の iframe 固定に合わせる）
    const payjp = window.Payjp(PAYJP_PUBLIC_KEY, { threeDSecureWorkflow: 'iframe' });
    const elements = payjp.elements({ locale: 'ja' });
    let cachedElements: import('./types.js').PayjpCardElements | null = null;

    const elementStyle = {
      base: {
        color: '#061b31',
        fontSize: '16px',
        fontFamily: 'Inter, "Noto Sans JP", sans-serif',
        '::placeholder': { color: '#64748d' },
      },
      invalid: { color: '#ea2261' },
    };

    return {
      createCardElements(selectors) {
        if (!cachedElements) {
          cachedElements = {
            cardNumber: elements.create('cardNumber', { style: elementStyle }),
            cardExpiry: elements.create('cardExpiry', { style: elementStyle }),
            cardCvc: elements.create('cardCvc', { style: elementStyle }),
          };
        }
        cachedElements.cardNumber.mount(selectors.cardNumber);
        cachedElements.cardExpiry.mount(selectors.cardExpiry);
        cachedElements.cardCvc.mount(selectors.cardCvc);
        return cachedElements;
      },
      async createToken(cardNumberElement, data) {
        try {
          const result = await payjp.createToken(cardNumberElement, {
            three_d_secure: true,
            card: { name: data.name, email: data.email },
          });
          if (result.error) {
            return { error: result.error.message };
          }
          if (!result.id) {
            return { error: 'トークンの取得に失敗しました。' };
          }
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

      if (isSubmitting) return;
      isSubmitting = true;

      try {
        billingState = {
          ...billingState,
          email: data.email,
          cardholderName: data.cardholderName,
          selectedPlanId: data.planId,
          privacyConsented: data.privacyConsented,
        };

        if (!data.privacyConsented) {
          update({
            step: 'form',
            selectedPlanId: data.planId,
            email: data.email,
            cardholderName: data.cardholderName,
            error: {
              kind: 'server_error',
              message: '個人情報の取り扱いへの同意が必要です。チェックを入れて再度お試しください。',
            },
          });
          return;
        }

        const submitBtn = app.querySelector('.submit-button') as HTMLButtonElement | null;
        if (submitBtn) {
          submitBtn.setAttribute('disabled', 'true');
          submitBtn.textContent = '処理中...';
        }

        const tokenResult = await payjpAdapter.createToken(currentCardElement, {
          name: data.cardholderName,
          email: data.email,
        });

        if (tokenResult.error || !tokenResult.tokenId) {
          currentCardElement = null;
          update({
            step: 'form',
            selectedPlanId: data.planId,
            email: data.email,
            cardholderName: data.cardholderName,
            error: { kind: 'three_ds_failed', message: tokenResult.error ?? '3Dセキュア認証に失敗しました。' },
          });
          return;
        }

        update({ step: 'submitting' });

        const result = await createSubscription({
          planId: data.planId,
          email: data.email,
          payjpToken: tokenResult.tokenId,
          privacyConsented: data.privacyConsented,
        });

        // 課金完了 → サンクスページ（Discord連携ボタン表示）
        renderState(app, 'register_complete', startOAuth, {
          registerComplete: {
            result,
            plans: PLANS,
            onLinkDiscord: () => {
              startOAuth();
            },
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
      currentCardElement = null;
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
    onConfirm: async () => {
      dismiss?.();
      try {
        const result = await createCancelFormLink();
        const parsed = new URL(result.formUrl);
        if (parsed.protocol !== 'https:') {
          throw new Error(`Unexpected formUrl protocol: ${parsed.protocol}`);
        }
        window.location.href = result.formUrl;
      } catch (err) {
        console.error('[cancel] createCancelFormLink failed:', err);
        const cancelError = mapCancelError(err);
        renderState(
          app,
          'cancel_error',
          cancelError.kind === 'session_expired'
            ? () => {
                startOAuth();
              }
            : startOAuth,
          { cancelError },
        );
      }
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
    const returnedFromGoogleForm = consumeCancelSubmittedQuery();
    if (returnedFromGoogleForm) {
      try {
        await pollAfterGoogleFormSubmit();
      } catch (err) {
        console.error('[init] pollAfterGoogleFormSubmit failed:', err);
      }
    }

    // Billing-first flow: check member_session first
    const member = await getMember();

    if (member) {
      // Member exists (has active subscription via member_session)
      if (!member.discordLinked) {
        // Discord未連携 → OAuthコールバック帰還かチェック
        // link_session Cookie があれば自動的にlink-discord APIを呼ぶ
        let session: Awaited<ReturnType<typeof checkSession>> | null = null;
        try {
          session = await checkSession();
        } catch (err) {
          // 401 のみ「link_session なし / 期限切れ / 無効」— サンクスページへ進む
          if (!(err instanceof SessionCheckError && err.status === 401)) {
            console.error('[init] Session check failed:', err);
            renderState(app, 'error', startOAuth, {
              errorMessage: '連携状態の確認に失敗しました。しばらく経ってから再度お試しください。',
            });
            return;
          }
        }

        let linkErrorMessage: string | undefined;

        if (session?.linked) {
          // OAuth callback 帰還 → Discord連携実行
          renderState(app, 'loading', startOAuth);
          let linkResult: Awaited<ReturnType<typeof linkDiscord>> | null = null;
          try {
            linkResult = await linkDiscord();
          } catch (err) {
            console.error('[init] linkDiscord threw:', err);
          }
          if (linkResult?.ok) {
            renderState(app, 'link_complete', startOAuth, {
              linkComplete: {
                roleGranted: linkResult.roleGranted ?? false,
                onBackToTop: () => {
                  void init();
                },
              },
            });
            return;
          }
          // link失敗 → エラーコード別に処理
          if (linkResult?.errorCode === 'NO_SUBSCRIPTION') {
            renderState(app, 'error', startOAuth, {
              errorMessage: '有効な購読がないためDiscord連携できません。',
            });
            return;
          }
          linkErrorMessage =
            linkResult?.errorCode === 'DISCORD_ALREADY_USED'
              ? 'このDiscordアカウントは既に別のアカウントで使用されています。\n別のDiscordアカウントでお試しください。'
              : linkResult && !linkResult.ok
                ? 'Discord連携に失敗しました。再度お試しください。'
                : undefined;
        }

        // Discord未連携 → サンクスページ
        renderState(app, 'register_complete', startOAuth, {
          registerComplete: {
            result: {
              ok: true as const,
              memberId: member.memberId,
              subscriptionStatus: member.subscriptionStatus ?? '',
              planId: member.planId ?? '',
              trialApplied: member.subscriptionStatus === 'trial',
              accessEndAt: member.accessEndAt ?? '',
            },
            plans: PLANS,
            onLinkDiscord: () => {
              startOAuth();
            },
            onBackToTop: () => {
              void init();
            },
            linkError: linkErrorMessage,
          },
        });
        return;
      }

      // Discord連携済み → 購読状態表示
      let subscription: Awaited<ReturnType<typeof fetchSubscriptionStatus>>;
      try {
        subscription = await fetchSubscriptionStatus();
      } catch (err) {
        if (err instanceof SubscriptionStatusError) {
          renderState(app, 'error', startOAuth, {
            errorMessage: '購読状況を確認できませんでした。しばらく経ってから再度お試しください。',
          });
          return;
        }
        throw err;
      }

      const subscriptionForUi = buildSubscriptionForUi(member, subscription);
      if (subscriptionForUi) {
        renderState(app, 'linked', startOAuth, {
          subscribed: {
            subscription: subscriptionForUi,
            plans: PLANS,
            onStartCancel: () => startCancelFlow(app),
            memberRoleState: member.roleState,
          },
        });
        return;
      }

      // 連携済みだが購読なし（退会後など）
      if (!(await ensureGateForBilling(app))) return;
      startBillingFlow(app);
      return;
    }

    // member_session なし → 課金フォームを先に表示（支払完了後に Discord OAuth）
    if (!(await ensureGateForBilling(app))) return;
    startBillingFlow(app);
  } catch (err) {
    console.error('[init] failed:', err);
    if (err instanceof MemberFetchError) {
      renderState(app, 'error', startOAuth, {
        errorMessage: '会員情報を確認できませんでした。しばらく経ってから再度お試しください。',
      });
    } else {
      renderState(app, 'error', startOAuth);
    }
  }
}

init().catch((err) => {
  console.error('[init] Unhandled error:', err);
  const app = document.getElementById('app');
  if (app) app.textContent = '予期しないエラーが発生しました。ページを再読み込みしてください。';
});
