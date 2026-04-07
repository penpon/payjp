import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BillingCallbacks } from '../billing-ui.js';
import { renderBilling, renderSubscribed } from '../billing-ui.js';
import type { BillingFormState, PayjpAdapter, PlanDef } from '../types.js';

const PLANS: PlanDef[] = [
  { id: 'plan_starter', name: 'スタータープラン', price: 25000, features: ['掲載枠：1枠'] },
  { id: 'plan_business', name: 'ビジネスプラン', price: 50000, features: ['掲載枠：3枠'] },
  { id: 'plan_enterprise', name: 'エンタープライズプラン', price: 100000, features: ['掲載枠：10枠'] },
];

function createMockCallbacks(): BillingCallbacks {
  return {
    onSubmit: vi.fn(),
    onRetry: vi.fn(),
    onBackToTop: vi.fn(),
    onReAuth: vi.fn(),
  };
}

function createMockPayjpAdapter(): PayjpAdapter {
  const mockElement = {
    mount: vi.fn(),
    unmount: vi.fn(),
    clear: vi.fn(),
    on: vi.fn(),
  };
  return {
    createCardElement: vi.fn().mockReturnValue(mockElement),
    createToken: vi.fn().mockResolvedValue({ tokenId: 'tok_test' }),
  };
}

function defaultFormState(overrides?: Partial<BillingFormState>): BillingFormState {
  return {
    step: 'form',
    selectedPlanId: 'plan_starter',
    email: '',
    cardholderName: '',
    privacyConsented: false,
    error: null,
    result: null,
    ...overrides,
  };
}

describe('billing-ui', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
  });

  describe('form step', () => {
    it('should render 3 plan cards', () => {
      renderBilling(container, defaultFormState(), createMockCallbacks(), createMockPayjpAdapter(), PLANS);

      const planCards = container.querySelectorAll('.plan-card');
      expect(planCards.length).toBe(3);
    });

    it('should mark first plan as selected by default', () => {
      renderBilling(container, defaultFormState(), createMockCallbacks(), createMockPayjpAdapter(), PLANS);

      const selected = container.querySelector('.plan-card--selected');
      expect(selected).not.toBeNull();
      expect(selected?.textContent).toContain('スタータープラン');
    });

    it('should render email and name input fields', () => {
      renderBilling(container, defaultFormState(), createMockCallbacks(), createMockPayjpAdapter(), PLANS);

      expect(container.querySelector('#billing-email')).not.toBeNull();
      expect(container.querySelector('#billing-name')).not.toBeNull();
    });

    it('should render PAY.JP card mount point', () => {
      renderBilling(container, defaultFormState(), createMockCallbacks(), createMockPayjpAdapter(), PLANS);

      expect(container.querySelector('#payjp-card-element')).not.toBeNull();
    });

    it('should render consent checkbox and privacy link', () => {
      renderBilling(container, defaultFormState(), createMockCallbacks(), createMockPayjpAdapter(), PLANS);

      expect(container.querySelector('#billing-consent')).not.toBeNull();
      const link = container.querySelector('.consent-link');
      expect(link?.getAttribute('href')).toBe('/privacy.html');
      expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
    });

    it('should have submit button disabled by default', () => {
      renderBilling(container, defaultFormState(), createMockCallbacks(), createMockPayjpAdapter(), PLANS);

      const btn = container.querySelector('.submit-button') as HTMLButtonElement;
      expect(btn).not.toBeNull();
      expect(btn.hasAttribute('disabled')).toBe(true);
    });

    it('should show error banner when returning from error', () => {
      const state = defaultFormState({
        error: { kind: 'three_ds_failed', message: '3DS認証に失敗しました。' },
      });

      renderBilling(container, state, createMockCallbacks(), createMockPayjpAdapter(), PLANS);

      const banner = container.querySelector('.error-banner');
      expect(banner).not.toBeNull();
      expect(banner?.textContent).toContain('3DS認証に失敗しました');
    });

    it('should show consent checked when state preserves privacyConsented', () => {
      renderBilling(
        container,
        defaultFormState({ privacyConsented: true }),
        createMockCallbacks(),
        createMockPayjpAdapter(),
        PLANS,
      );

      const checkbox = container.querySelector('#billing-consent') as HTMLInputElement;
      expect(checkbox.checked).toBe(true);
    });

    it('should keep consent checked when re-rendering form after error with privacyConsented saved', () => {
      renderBilling(
        container,
        defaultFormState({
          privacyConsented: true,
          error: { kind: 'three_ds_failed', message: '3DS失敗' },
        }),
        createMockCallbacks(),
        createMockPayjpAdapter(),
        PLANS,
      );

      expect((container.querySelector('#billing-consent') as HTMLInputElement).checked).toBe(true);
    });

    it('should change plan selection on click', () => {
      renderBilling(container, defaultFormState(), createMockCallbacks(), createMockPayjpAdapter(), PLANS);

      const planCards = container.querySelectorAll('.plan-card');
      // Click the second plan
      (planCards[1] as HTMLElement).click();

      expect(planCards[1].classList.contains('plan-card--selected')).toBe(true);
      expect(planCards[0].classList.contains('plan-card--selected')).toBe(false);
    });

    it('should update submit enabled state when selecting a plan after initial selectedPlanId was empty', async () => {
      const payjp = createMockPayjpAdapter();
      renderBilling(
        container,
        defaultFormState({
          selectedPlanId: '',
          email: 'a@b.co',
          cardholderName: 'TARO YAMADA',
          privacyConsented: true,
        }),
        createMockCallbacks(),
        payjp,
        PLANS,
      );

      await Promise.resolve();

      const mockElement = vi.mocked(payjp.createCardElement).mock.results[0]?.value as {
        on: (ev: string, cb: (e: { complete: boolean }) => void) => void;
      };
      const changeCb = vi.mocked(mockElement.on).mock.calls.find((c) => c[0] === 'change')?.[1] as (e: {
        complete: boolean;
      }) => void;
      expect(changeCb).toBeDefined();
      changeCb({ complete: true });

      const btn = container.querySelector('.submit-button') as HTMLButtonElement;
      expect(btn.hasAttribute('disabled')).toBe(true);

      (container.querySelectorAll('.plan-card')[0] as HTMLElement).click();

      expect(btn.hasAttribute('disabled')).toBe(false);
    });

    it('should have plan cards with radiogroup role for accessibility', () => {
      renderBilling(container, defaultFormState(), createMockCallbacks(), createMockPayjpAdapter(), PLANS);

      expect(container.querySelector('.plan-grid')?.getAttribute('role')).toBe('radiogroup');
      const firstCard = container.querySelector('.plan-card');
      expect(firstCard?.getAttribute('role')).toBe('radio');
    });
  });

  describe('submitting step', () => {
    it('should show spinner and processing text', () => {
      renderBilling(container, defaultFormState({ step: 'submitting' }), createMockCallbacks(), null, PLANS);

      expect(container.querySelector('.spinner')).not.toBeNull();
      expect(container.textContent).toContain('処理中...');
    });

    it('should mention 3DS', () => {
      renderBilling(container, defaultFormState({ step: 'submitting' }), createMockCallbacks(), null, PLANS);

      expect(container.textContent).toContain('3Dセキュア認証');
    });
  });

  describe('success step', () => {
    const successResult = {
      ok: true as const,
      memberId: 'uuid-123',
      subscriptionStatus: 'trial',
      planId: 'plan_starter',
      trialApplied: true,
      accessEndAt: '2026-07-07T00:00:00Z',
    };

    it('should show completion message', () => {
      renderBilling(
        container,
        defaultFormState({ step: 'success', result: successResult }),
        createMockCallbacks(),
        null,
        PLANS,
      );

      expect(container.textContent).toContain('登録が完了しました');
    });

    it('should show plan name and trial status', () => {
      renderBilling(
        container,
        defaultFormState({ step: 'success', result: successResult }),
        createMockCallbacks(),
        null,
        PLANS,
      );

      expect(container.textContent).toContain('スタータープラン');
      expect(container.textContent).toContain('トライアル');
    });

    it('should show success icon', () => {
      renderBilling(
        container,
        defaultFormState({ step: 'success', result: successResult }),
        createMockCallbacks(),
        null,
        PLANS,
      );

      expect(container.querySelector('.success-icon-large')).not.toBeNull();
    });

    it('should show trial period only without duplicate next renewal row when trial applied', () => {
      renderBilling(
        container,
        defaultFormState({ step: 'success', result: successResult }),
        createMockCallbacks(),
        null,
        PLANS,
      );

      expect(container.textContent).toContain('トライアル期間');
      expect(container.textContent).toContain('2026/07/07');
      expect(container.textContent).not.toContain('次回更新日');
    });

    it('should show next renewal row when trial was not applied', () => {
      const noTrial = { ...successResult, trialApplied: false, subscriptionStatus: 'active' as const };
      renderBilling(
        container,
        defaultFormState({ step: 'success', result: noTrial }),
        createMockCallbacks(),
        null,
        PLANS,
      );

      expect(container.textContent).toContain('次回更新日');
      expect(container.textContent).not.toContain('トライアル期間');
    });
  });

  describe('error step - three_ds with server operationId', () => {
    it('should show operation id and no retry when three_ds_failed includes operationId', () => {
      const callbacks = createMockCallbacks();
      renderBilling(
        container,
        defaultFormState({
          step: 'error',
          error: {
            kind: 'three_ds_failed',
            message: '3Dセキュア認証または決済トークンの検証に失敗しました。',
            operationId: 'op-from-server',
          },
        }),
        callbacks,
        null,
        PLANS,
      );

      expect(container.querySelector('.operation-id-value')?.textContent).toBe('op-from-server');
      expect(container.querySelector('.submit-button')).toBeNull();
      expect(container.textContent).toContain('自動再試行は行われません');
    });
  });

  describe('error step - inflight', () => {
    it('should display operationId with copy button', () => {
      renderBilling(
        container,
        defaultFormState({
          step: 'error',
          error: { kind: 'inflight', message: '処理中の操作があります。', operationId: 'op-test-123' },
        }),
        createMockCallbacks(),
        null,
        PLANS,
      );

      expect(container.querySelector('.operation-id-value')?.textContent).toBe('op-test-123');
      expect(container.querySelector('.copy-button')).not.toBeNull();
    });

    it('should show no auto-retry message', () => {
      renderBilling(
        container,
        defaultFormState({
          step: 'error',
          error: { kind: 'inflight', message: '処理中', operationId: 'op-123' },
        }),
        createMockCallbacks(),
        null,
        PLANS,
      );

      expect(container.textContent).toContain('自動再試行は行われません');
    });

    it('should not show retry when inflight without operationId', () => {
      const callbacks = createMockCallbacks();
      renderBilling(
        container,
        defaultFormState({
          step: 'error',
          error: { kind: 'inflight', message: '処理中の操作があります。' },
        }),
        callbacks,
        null,
        PLANS,
      );

      expect(container.querySelector('.submit-button')).toBeNull();
      expect(container.textContent).toContain('自動再試行は行われません');
      expect(container.textContent).toContain('サポートまでお問い合わせください');
      expect(container.querySelector('.operation-id-box')).toBeNull();
      expect(container.querySelector('.copy-button')).toBeNull();
    });
  });

  describe('error step - forbidden_origin', () => {
    it('should show top button and no misleading retry', () => {
      const callbacks = createMockCallbacks();
      renderBilling(
        container,
        defaultFormState({
          step: 'error',
          error: {
            kind: 'forbidden_origin',
            message: 'アクセス元のサイトが許可されていません。',
          },
        }),
        callbacks,
        null,
        PLANS,
      );

      expect(container.querySelector('.submit-button')).toBeNull();
      const topBtn = container.querySelector('.secondary-button') as HTMLButtonElement;
      expect(topBtn).not.toBeNull();
      topBtn.click();
      expect(callbacks.onBackToTop).toHaveBeenCalledOnce();
    });
  });

  describe('error step - session_expired', () => {
    it('should show re-auth button', () => {
      const callbacks = createMockCallbacks();
      renderBilling(
        container,
        defaultFormState({
          step: 'error',
          error: { kind: 'session_expired', message: 'セッションが無効です。' },
        }),
        callbacks,
        null,
        PLANS,
      );

      const btn = container.querySelector('.discord-button') as HTMLButtonElement;
      expect(btn).not.toBeNull();
      btn.click();
      expect(callbacks.onReAuth).toHaveBeenCalledOnce();
    });
  });

  describe('error step - server_error', () => {
    it('should show retry button', () => {
      const callbacks = createMockCallbacks();
      renderBilling(
        container,
        defaultFormState({
          step: 'error',
          error: { kind: 'server_error', message: 'サーバーエラー' },
        }),
        callbacks,
        null,
        PLANS,
      );

      const btn = container.querySelector('.submit-button') as HTMLButtonElement;
      expect(btn).not.toBeNull();
      expect(btn.textContent).toContain('もう一度試す');
      btn.click();
      expect(callbacks.onRetry).toHaveBeenCalledOnce();
    });
  });

  describe('renderSubscribed', () => {
    it('should show cancel section with cancel button when onStartCancel provided and status is active', () => {
      const onStartCancel = vi.fn();
      renderSubscribed(
        container,
        { status: 'active', planId: 'plan_business', accessEndAt: '2026-05-07T00:00:00Z' },
        PLANS,
        onStartCancel,
      );

      expect(container.querySelector('.cancel-section')).not.toBeNull();
      const btn = container.querySelector('.cancel-button') as HTMLButtonElement;
      expect(btn).not.toBeNull();
      btn.click();
      expect(onStartCancel).toHaveBeenCalledOnce();
    });

    it('should not show cancel section when onStartCancel is not provided', () => {
      renderSubscribed(
        container,
        { status: 'active', planId: 'plan_business', accessEndAt: '2026-05-07T00:00:00Z' },
        PLANS,
      );

      expect(container.querySelector('.cancel-section')).toBeNull();
      expect(container.querySelector('.cancel-button')).toBeNull();
    });

    it('should not show cancel button when status is canceled', () => {
      renderSubscribed(
        container,
        { status: 'canceled', planId: 'plan_business', accessEndAt: '2026-05-07T00:00:00Z' },
        PLANS,
        vi.fn(),
      );

      expect(container.querySelector('.cancel-button')).toBeNull();
    });

    it('should show subscription status for active user', () => {
      renderSubscribed(
        container,
        { status: 'active', planId: 'plan_business', accessEndAt: '2026-05-07T00:00:00Z' },
        PLANS,
      );

      expect(container.textContent).toContain('購読状況');
      expect(container.textContent).toContain('ビジネスプラン');
      expect(container.textContent).toContain('有効');
    });

    it('should show trial label for trial status', () => {
      renderSubscribed(
        container,
        { status: 'trial', planId: 'plan_starter', accessEndAt: '2026-07-07T00:00:00Z' },
        PLANS,
      );

      expect(container.querySelector('.status-badge')?.textContent).toBe('トライアル');
    });

    it('should show access end date', () => {
      renderSubscribed(
        container,
        { status: 'active', planId: 'plan_starter', accessEndAt: '2026-05-07T00:00:00Z' },
        PLANS,
      );

      expect(container.textContent).toContain('次回更新日');
      expect(container.textContent).toContain('2026/05/07');
    });

    it('should format access end date in Asia/Tokyo (not UTC calendar day)', () => {
      renderSubscribed(
        container,
        { status: 'active', planId: 'plan_starter', accessEndAt: '2026-05-06T15:00:00.000Z' },
        PLANS,
      );

      expect(container.textContent).toContain('2026/05/07');
    });
  });
});
