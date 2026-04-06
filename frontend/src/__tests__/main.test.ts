import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api.js', () => ({
  checkSession: vi.fn(),
  startOAuth: vi.fn(),
  SessionCheckError: class SessionCheckError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'SessionCheckError';
      this.status = status;
    }
  },
}));

import { checkSession, SessionCheckError } from '../api.js';

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
    consoleSpy.mockClear();
  });

  async function runInit(): Promise<void> {
    await import('../main.js');
    await vi.dynamicImportSettled();
    await new Promise((r) => setTimeout(r, 0));
  }

  it('should show linked state when session returns linked: true', async () => {
    vi.mocked(checkSession).mockResolvedValue({ linked: true });

    await runInit();

    expect(appDiv.querySelector('.success-badge')).not.toBeNull();
    expect(appDiv.textContent).toContain('Discord連携済み');
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
});
