import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api.js', () => ({
  checkSession: vi.fn(),
  createCancelFormLink: vi.fn(),
  getMember: vi.fn(),
  linkDiscord: vi.fn(),
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
  checkSession,
  createCancelFormLink,
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
    window.history.replaceState({}, '', '/');
  });

  afterEach(() => {
    appDiv.remove();
    vi.mocked(getMember).mockReset();
    vi.mocked(checkSession).mockReset();
    vi.mocked(linkDiscord).mockReset();
    vi.mocked(fetchSubscriptionStatus).mockReset();
    vi.mocked(createCancelFormLink).mockReset();
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
    vi.mocked(checkSession).mockResolvedValue({ linked: true, discordUserId: 'discord-test-user' });

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
      roleState: 'granted',
    });
    // No link_session → checkSession returns 401
    vi.mocked(checkSession).mockRejectedValue(new SessionCheckError(401, 'Session check failed: 401'));

    await runInit();

    expect(getMember).toHaveBeenCalled();
    // register_complete page shows Discord link button
    expect(appDiv.querySelector('.discord-button')).not.toBeNull();
    expect(appDiv.textContent).toContain('Discordと連携してサーバに参加してください！');
  });

  // --- Member exists, discord linked → subscribed status ---

  it('should show subscribed state when member has discord linked and active subscription', async () => {
    vi.mocked(getMember).mockResolvedValue({
      memberId: TEST_MEMBER_ID,
      subscriptionStatus: 'active',
      planId: 'plan_business',
      accessEndAt: '2026-05-07T00:00:00Z',
      discordLinked: true,
      roleState: 'granted',
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

  it('should strip ?cancel=submitted, poll, then show withdrawn when canceled and role revoked', async () => {
    window.history.replaceState({}, '', '/?cancel=submitted');

    vi.mocked(getMember).mockResolvedValue({
      memberId: TEST_MEMBER_ID,
      subscriptionStatus: 'canceled',
      planId: 'plan_business',
      accessEndAt: '2026-05-07T00:00:00Z',
      discordLinked: true,
      roleState: 'revoked',
    });
    vi.mocked(fetchSubscriptionStatus).mockResolvedValue({
      status: 'canceled',
      planId: 'plan_business',
      accessEndAt: '2026-05-07T00:00:00Z',
    });

    await runInit();

    expect(vi.mocked(getMember).mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(fetchSubscriptionStatus).toHaveBeenCalled();
    expect(window.location.search).toBe('');
    expect(appDiv.textContent).toContain('退会済み');
    expect(appDiv.textContent).toContain('ビジネスプラン');
    expect(appDiv.querySelector('.warning-banner')).toBeNull();
  });

  // --- Member exists, discord linked, no subscription → billing form ---

  it('should show billing form when member has discord linked but no subscription', async () => {
    vi.mocked(getMember).mockResolvedValue({
      memberId: TEST_MEMBER_ID,
      subscriptionStatus: null,
      planId: null,
      accessEndAt: null,
      discordLinked: true,
      roleState: null,
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
      roleState: 'granted',
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
      roleState: 'granted',
    });
    vi.mocked(checkSession).mockRejectedValue(new SessionCheckError(503, 'Session check failed: 503'));

    await runInit();

    expect(appDiv.textContent).toContain('連携状態の確認に失敗しました');
    expect(consoleSpy).toHaveBeenCalled();
  });

  // --- Cancel flow ---

  it('should keep register_complete when member has no discord link', async () => {
    vi.mocked(getMember).mockResolvedValue({
      memberId: TEST_MEMBER_ID,
      subscriptionStatus: 'active',
      planId: 'plan_business',
      accessEndAt: '2026-05-07T00:00:00Z',
      discordLinked: false,
      roleState: 'granted',
    });
    vi.mocked(checkSession).mockRejectedValue(new SessionCheckError(401, 'Session check failed: 401'));

    await runInit();

    expect(appDiv.querySelector('.discord-button')).not.toBeNull();
  });

  // --- PAY.JP SDK error ---

  it('shows error state when PAY.JP SDK initialization throws', async () => {
    vi.mocked(checkSession).mockResolvedValue({ linked: true, discordUserId: 'discord-test-user' });
    vi.mocked(fetchSubscriptionStatus).mockResolvedValue(null);
    vi.stubEnv('VITE_PAYJP_PUBLIC_KEY', 'pk_test_0a1b2c3d4e5f6g7h');

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

  it('initializes PAY.JP with threeDSecureWorkflow iframe when SDK is available', async () => {
    vi.mocked(getMember).mockResolvedValue(null);
    vi.mocked(checkSession).mockResolvedValue({ linked: true, discordUserId: 'discord-test-user' });
    vi.stubEnv('VITE_PAYJP_PUBLIC_KEY', 'pk_test_0123456789012345');

    const mockPayjp = vi.fn((_pk: string, opts?: { threeDSecureWorkflow?: string }) => {
      expect(opts).toEqual({ threeDSecureWorkflow: 'iframe' });
      return {
        elements: () => ({
          create: () => ({
            mount: vi.fn(),
            unmount: vi.fn(),
            clear: vi.fn(),
            on: vi.fn(),
          }),
        }),
        createToken: vi.fn(),
      };
    });
    const originalPayjp = window.Payjp;
    window.Payjp = mockPayjp;

    try {
      await runInit();

      expect(mockPayjp).toHaveBeenCalledWith('pk_test_0123456789012345', {
        threeDSecureWorkflow: 'iframe',
      });
      expect(appDiv.textContent).not.toContain('カード入力機能を読み込めませんでした');
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
      roleState: 'granted',
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
      roleState: 'granted',
    });
    vi.mocked(checkSession).mockResolvedValue({ linked: true, discordUserId: 'discord-test-user' });
    vi.mocked(linkDiscord).mockResolvedValue({ ok: false, errorCode: 'LINK_FAILED' });

    await runInit();

    expect(linkDiscord).toHaveBeenCalled();
    // Falls through to register_complete (thanks page with Discord link button)
    expect(appDiv.querySelector('.discord-button')).not.toBeNull();
    expect(appDiv.textContent).toContain('Discordと連携してサーバに参加してください！');
  });

  it('should show register_complete when linkDiscord throws (network/timeout)', async () => {
    vi.mocked(getMember).mockResolvedValue({
      memberId: TEST_MEMBER_ID,
      subscriptionStatus: 'active',
      planId: 'plan_business',
      accessEndAt: '2026-05-07T00:00:00Z',
      discordLinked: false,
      roleState: 'granted',
    });
    vi.mocked(checkSession).mockResolvedValue({ linked: true, discordUserId: 'discord-test-user' });
    vi.mocked(linkDiscord).mockRejectedValue(new TypeError('Failed to fetch'));

    await runInit();

    expect(linkDiscord).toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith('[init] linkDiscord threw:', expect.any(TypeError));
    // Falls through to register_complete (thanks page with Discord link button)
    expect(appDiv.querySelector('.discord-button')).not.toBeNull();
    expect(appDiv.textContent).toContain('Discordと連携してサーバに参加してください！');
  });
});
