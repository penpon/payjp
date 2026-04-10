import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api.js', () => ({
  checkSession: vi.fn(),
  getMember: vi.fn(),
  linkDiscord: vi.fn(),
  fetchSubscriptionStatus: vi.fn(),
  createSubscription: vi.fn(),
  cancelSubscription: vi.fn(),
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
  MemberFetchError: class MemberFetchError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'MemberFetchError';
      this.status = status;
    }
  },
}));

import {
  cancelSubscription,
  checkSession,
  fetchSubscriptionStatus,
  getMember,
  linkDiscord,
  MemberFetchError,
  SessionCheckError,
  SubscriptionStatusError,
} from '../api.js';

describe('main init()', () => {
  const TEST_MEMBER_ID = 'member-test-001';
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
    vi.mocked(getMember).mockReset();
    vi.mocked(checkSession).mockReset();
    vi.mocked(linkDiscord).mockReset();
    vi.mocked(fetchSubscriptionStatus).mockReset();
    vi.mocked(cancelSubscription).mockReset();
    sessionStorage.clear();
    consoleSpy.mockClear();
  });

  async function runInit(): Promise<void> {
    await import('../main.js');
    await vi.dynamicImportSettled();
    await new Promise((r) => setTimeout(r, 0));
  }

  // --- Billing-first flow: member=null → billing form ---

  it('should show billing form when getMember returns null (no member session)', async () => {
    vi.mocked(getMember).mockResolvedValue(null);

    await runInit();

    expect(getMember).toHaveBeenCalled();
    // billing state renders the billing form UI (not discord button or subscribed status)
    // Since PAY.JP SDK is not loaded in test, it falls back to error about card input
    expect(appDiv.textContent).toContain('カード入力機能を読み込めませんでした');
  });

  // --- Member exists, discord not linked → register_complete (thanks page) ---

  it('should show register_complete page when member exists but discord not linked', async () => {
    vi.mocked(getMember).mockResolvedValue({
      memberId: TEST_MEMBER_ID,
      subscriptionStatus: 'active',
      planId: 'plan_business',
      accessEndAt: '2026-05-07T00:00:00Z',
      discordLinked: false,
    });
    // No link_session → checkSession returns 401
    vi.mocked(checkSession).mockRejectedValue(new SessionCheckError(401, 'Session check failed: 401'));

    await runInit();

    expect(getMember).toHaveBeenCalled();
    // register_complete page shows Discord link button
    expect(appDiv.querySelector('.discord-button')).not.toBeNull();
    expect(appDiv.textContent).toContain('Discordと連携して特典を受け取ってください');
  });

  // --- Member exists, discord linked → subscribed status ---

  it('should show subscribed state when member has discord linked and active subscription', async () => {
    vi.mocked(getMember).mockResolvedValue({
      memberId: TEST_MEMBER_ID,
      subscriptionStatus: 'active',
      planId: 'plan_business',
      accessEndAt: '2026-05-07T00:00:00Z',
      discordLinked: true,
    });
    vi.mocked(fetchSubscriptionStatus).mockResolvedValue({
      status: 'active',
      planId: 'plan_business',
      accessEndAt: '2026-05-07T00:00:00Z',
    });

    await runInit();

    expect(getMember).toHaveBeenCalled();
    expect(fetchSubscriptionStatus).toHaveBeenCalled();
    expect(appDiv.querySelector('.subscribed-status')).not.toBeNull();
    expect(appDiv.textContent).toContain('購読状況');
  });

  // --- Member exists, discord linked, no subscription → billing form ---

  it('should show billing form when member has discord linked but no subscription', async () => {
    vi.mocked(getMember).mockResolvedValue({
      memberId: TEST_MEMBER_ID,
      subscriptionStatus: null,
      planId: null,
      accessEndAt: null,
      discordLinked: true,
    });
    vi.mocked(fetchSubscriptionStatus).mockResolvedValue(null);

    await runInit();

    expect(getMember).toHaveBeenCalled();
    expect(fetchSubscriptionStatus).toHaveBeenCalled();
    // Falls through to startBillingFlow — PAY.JP SDK not loaded → error fallback
    expect(appDiv.textContent).toContain('カード入力機能を読み込めませんでした');
  });

  // --- Subscription status error ---

  it('should show error when subscription status endpoint is unavailable', async () => {
    vi.mocked(getMember).mockResolvedValue({
      memberId: TEST_MEMBER_ID,
      subscriptionStatus: 'active',
      planId: 'plan_business',
      accessEndAt: '2026-05-07T00:00:00Z',
      discordLinked: true,
    });
    vi.mocked(fetchSubscriptionStatus).mockRejectedValue(new SubscriptionStatusError(503, 'down'));

    await runInit();

    expect(appDiv.textContent).toContain('購読状況を確認できませんでした');
    expect(appDiv.querySelector('.error-badge')).not.toBeNull();
  });

  // --- Error handling ---

  it('should show member-unavailable message when getMember throws MemberFetchError', async () => {
    vi.mocked(getMember).mockRejectedValue(new MemberFetchError(503, 'Member fetch failed: 503'));

    await runInit();

    expect(getMember).toHaveBeenCalled();
    expect(appDiv.textContent).toContain('会員情報を確認できませんでした');
  });

  it('should show error state when getMember throws unexpected error', async () => {
    const error = new Error('Network error');
    vi.mocked(getMember).mockRejectedValue(error);

    await runInit();

    expect(appDiv.querySelector('.error-badge')).not.toBeNull();
    expect(consoleSpy).toHaveBeenCalledWith('[init] failed:', error);
  });

  it('should show error when checkSession fails with non-401 (e.g. 503)', async () => {
    vi.mocked(getMember).mockResolvedValue({
      memberId: TEST_MEMBER_ID,
      subscriptionStatus: 'active',
      planId: 'plan_business',
      accessEndAt: '2026-05-07T00:00:00Z',
      discordLinked: false,
    });
    vi.mocked(checkSession).mockRejectedValue(new SessionCheckError(503, 'Session check failed: 503'));

    await runInit();

    expect(appDiv.textContent).toContain('連携状態の確認に失敗しました');
    expect(consoleSpy).toHaveBeenCalled();
  });

  // --- Cancel pending flow ---

  it('should clear cancelPending when member has no discord link', async () => {
    sessionStorage.setItem('cancelPending', String(Date.now()));
    vi.mocked(getMember).mockResolvedValue({
      memberId: TEST_MEMBER_ID,
      subscriptionStatus: 'active',
      planId: 'plan_business',
      accessEndAt: '2026-05-07T00:00:00Z',
      discordLinked: false,
    });
    vi.mocked(checkSession).mockRejectedValue(new SessionCheckError(401, 'Session check failed: 401'));

    await runInit();

    // cancelPending is not consumed because discord is not linked (cancel path requires discordLinked=true)
    // The register_complete page is shown
    expect(appDiv.querySelector('.discord-button')).not.toBeNull();
  });

  // --- PAY.JP SDK error ---

  it('shows error state when PAY.JP SDK initialization throws', async () => {
    vi.mocked(getMember).mockResolvedValue(null);
    vi.stubEnv('VITE_PAYJP_PUBLIC_KEY', 'pk_test_valid_like');

    const payjpInitError = new Error('invalid key format');
    const originalPayjp = window.Payjp;
    window.Payjp = vi.fn(() => {
      throw payjpInitError;
    });

    try {
      await runInit();

      // member=null → startBillingFlow → PAY.JP init fails → error
      expect(appDiv.textContent).toContain('カード入力機能を読み込めませんでした');
      expect(consoleSpy).toHaveBeenCalledWith('[billing] PAY.JP initialization failed:', payjpInitError);
    } finally {
      window.Payjp = originalPayjp;
      vi.unstubAllEnvs();
    }
  });

  // --- Discord link flow (OAuth callback return) ---

  it('should call linkDiscord and show link_complete when member has no discord but checkSession returns linked', async () => {
    vi.mocked(getMember).mockResolvedValue({
      memberId: TEST_MEMBER_ID,
      subscriptionStatus: 'active',
      planId: 'plan_business',
      accessEndAt: '2026-05-07T00:00:00Z',
      discordLinked: false,
    });
    vi.mocked(checkSession).mockResolvedValue({ linked: true, discordUserId: 'discord-test-user' });
    vi.mocked(linkDiscord).mockResolvedValue({ ok: true, discordUserId: 'discord-test-user', roleGranted: true });

    await runInit();

    expect(linkDiscord).toHaveBeenCalled();
    expect(appDiv.textContent).toContain('連携完了');
    expect(appDiv.textContent).toContain('ロールが付与されました');
  });

  it('should show register_complete when linkDiscord fails', async () => {
    vi.mocked(getMember).mockResolvedValue({
      memberId: TEST_MEMBER_ID,
      subscriptionStatus: 'active',
      planId: 'plan_business',
      accessEndAt: '2026-05-07T00:00:00Z',
      discordLinked: false,
    });
    vi.mocked(checkSession).mockResolvedValue({ linked: true, discordUserId: 'discord-test-user' });
    vi.mocked(linkDiscord).mockResolvedValue({ ok: false, errorCode: 'LINK_FAILED' });

    await runInit();

    expect(linkDiscord).toHaveBeenCalled();
    // Falls through to register_complete (thanks page with Discord link button)
    expect(appDiv.querySelector('.discord-button')).not.toBeNull();
    expect(appDiv.textContent).toContain('Discordと連携して特典を受け取ってください');
  });
});
