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
      expect(container.querySelector('.consent-link')?.getAttribute('href')).toBe('/privacy.html');
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

    it('should change plan selection on click', () => {
      renderBilling(container, defaultFormState(), createMockCallbacks(), createMockPayjpAdapter(), PLANS);

      const planCards = container.querySelectorAll('.plan-card');
      // Click the second plan
      (planCards[1] as HTMLElement).click();

      expect(planCards[1].classList.contains('plan-card--selected')).toBe(true);
      expect(planCards[0].classList.contains('plan-card--selected')).toBe(false);
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
      expect(callbacks.onBackToTop).toHaveBeenCalledOnce();
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
  });
});
