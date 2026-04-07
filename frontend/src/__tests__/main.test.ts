import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api.js', () => ({
  checkSession: vi.fn(),
  fetchSubscriptionStatus: vi.fn(),
  createSubscription: vi.fn(),
  startOAuth: vi.fn(),
  SessionCheckError: class SessionCheckError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'SessionCheckError';
      this.status = status;
    }
  },
  SubscribeError: class SubscribeError extends Error {
    status: number;
    errorCode: string;
    operationId: string | undefined;
    constructor(status: number, errorCode: string, operationId: string | undefined, message: string) {
      super(message);
      this.name = 'SubscribeError';
      this.status = status;
      this.errorCode = errorCode;
      this.operationId = operationId;
    }
  },
  SubscriptionStatusError: class SubscriptionStatusError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'SubscriptionStatusError';
      this.status = status;
    }
  },
}));

import { checkSession, fetchSubscriptionStatus, SessionCheckError, SubscriptionStatusError } from '../api.js';

describe('main init()', () => {
  let appDiv: HTMLDivElement;
  const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  beforeEach(() => {
    appDiv = document.createElement('div');
    appDiv.id = 'app';
    document.body.appendChild(appDiv);
    vi.resetModules();
  });

  afterEach(() => {
    appDiv.remove();
    vi.mocked(checkSession).mockReset();
    vi.mocked(fetchSubscriptionStatus).mockReset();
    consoleSpy.mockClear();
  });

  async function runInit(): Promise<void> {
    await import('../main.js');
    await vi.dynamicImportSettled();
    await new Promise((r) => setTimeout(r, 0));
  }

  it('should show linked state when session returns linked: true and no subscription', async () => {
    vi.mocked(checkSession).mockResolvedValue({ linked: true, discordUserId: 'discord-test-user' });
    vi.mocked(fetchSubscriptionStatus).mockResolvedValue(null);

    await runInit();

    expect(appDiv.querySelector('.success-badge')).not.toBeNull();
    expect(appDiv.textContent).toContain('Discord連携済み');
  });

  it('should show start billing button when linked with no subscription', async () => {
    vi.mocked(checkSession).mockResolvedValue({ linked: true, discordUserId: 'discord-test-user' });
    vi.mocked(fetchSubscriptionStatus).mockResolvedValue(null);

    await runInit();

    expect(checkSession).toHaveBeenCalled();
    expect(fetchSubscriptionStatus).toHaveBeenCalled();
    expect(appDiv.querySelector('.start-billing-button')).not.toBeNull();
    expect(appDiv.textContent).toContain('プランを選択して登録する');
  });

  it('should show subscribed state when user has active subscription', async () => {
    vi.mocked(checkSession).mockResolvedValue({ linked: true, discordUserId: 'discord-test-user' });
    vi.mocked(fetchSubscriptionStatus).mockResolvedValue({
      status: 'active',
      planId: 'plan_business',
      accessEndAt: '2026-05-07T00:00:00Z',
    });

    await runInit();

    expect(appDiv.querySelector('.subscribed-status')).not.toBeNull();
    expect(appDiv.textContent).toContain('購読状況');
  });

  it('should show error when subscription status endpoint is unavailable', async () => {
    vi.mocked(checkSession).mockResolvedValue({ linked: true, discordUserId: 'discord-test-user' });
    vi.mocked(fetchSubscriptionStatus).mockRejectedValue(new SubscriptionStatusError(503, 'down'));

    await runInit();

    expect(appDiv.textContent).toContain('購読状況を確認できませんでした');
    expect(appDiv.querySelector('.error-badge')).not.toBeNull();
  });

  it('should show not_linked state when session returns linked: false', async () => {
    vi.mocked(checkSession).mockResolvedValue({ linked: false });

    await runInit();

    expect(appDiv.querySelector('.discord-button')).not.toBeNull();
    expect(appDiv.textContent).toContain('Discordアカウントとの連携が必要です');
  });

  it('should show not_linked state on 401 (unauthenticated)', async () => {
    vi.mocked(checkSession).mockRejectedValue(new SessionCheckError(401, 'Session check failed: 401'));

    await runInit();

    expect(appDiv.querySelector('.discord-button')).not.toBeNull();
    expect(appDiv.querySelector('.error-badge')).toBeNull();
    expect(appDiv.textContent).toContain('Discordアカウントとの連携が必要です');
  });

  it('should show error state on non-401 failure', async () => {
    vi.mocked(checkSession).mockRejectedValue(new Error('Network error'));

    await runInit();

    expect(appDiv.querySelector('.error-badge')).not.toBeNull();
    expect(appDiv.textContent).toContain('連携状態の確認に失敗しました');
  });

  it('should log error to console on non-401 failure', async () => {
    const error = new Error('Network error');
    vi.mocked(checkSession).mockRejectedValue(error);

    await runInit();

    expect(consoleSpy).toHaveBeenCalledWith('[init] Session check failed:', error);
  });

  it('should not log error to console on 401', async () => {
    vi.mocked(checkSession).mockRejectedValue(new SessionCheckError(401, 'Session check failed: 401'));

    await runInit();

    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it('shows error state when PAY.JP SDK initialization throws', async () => {
    vi.mocked(checkSession).mockResolvedValue({ linked: true, discordUserId: 'discord-test-user' });
    vi.mocked(fetchSubscriptionStatus).mockResolvedValue(null);
    vi.stubEnv('VITE_PAYJP_PUBLIC_KEY', 'pk_test_valid_like');

    const payjpInitError = new Error('invalid key format');
    const originalPayjp = window.Payjp;
    window.Payjp = vi.fn(() => {
      throw payjpInitError;
    });

    try {
      await runInit();

      const startBillingButton = appDiv.querySelector('.start-billing-button') as HTMLButtonElement;
      expect(startBillingButton).not.toBeNull();
      startBillingButton.click();

      expect(appDiv.textContent).toContain('カード入力機能を読み込めませんでした');
      expect(consoleSpy).toHaveBeenCalledWith('[billing] PAY.JP initialization failed:', payjpInitError);
    } finally {
      window.Payjp = originalPayjp;
      vi.unstubAllEnvs();
    }
  });
});
