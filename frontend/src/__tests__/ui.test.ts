import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderState } from '../ui.js';

describe('ui', () => {
  let container: HTMLDivElement;
  const onConnect = vi.fn();
  const originalReload = window.location.reload;

  beforeEach(() => {
    container = document.createElement('div');
    onConnect.mockClear();
    Object.defineProperty(window, 'location', {
      value: { ...window.location, reload: vi.fn() },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      value: { ...window.location, reload: originalReload },
      writable: true,
      configurable: true,
    });
  });

  describe('loading state', () => {
    it('should show spinner and loading text', () => {
      renderState(container, 'loading', onConnect);

      expect(container.querySelector('.spinner')).not.toBeNull();
      expect(container.textContent).toContain('セッションを確認中...');
    });

    it('should not show discord button', () => {
      renderState(container, 'loading', onConnect);

      expect(container.querySelector('.discord-button')).toBeNull();
    });

    it('should have role=status on loading container for accessibility', () => {
      renderState(container, 'loading', onConnect);

      expect(container.querySelector('.loading-container')?.getAttribute('role')).toBe('status');
    });
  });

  describe('linked state', () => {
    it('should show subscribed status when subscribed context is provided', () => {
      renderState(container, 'linked', onConnect, {
        subscribed: {
          subscription: { status: 'active', planId: 'plan_starter', accessEndAt: '2026-05-01T00:00:00Z' },
          plans: [{ id: 'plan_starter', name: 'スタータープラン', price: 20000, features: [] }],
        },
      });

      expect(container.querySelector('.subscribed-status')).not.toBeNull();
      expect(container.textContent).toContain('購読状況');
    });

    it('should show error fallback when subscribed context is missing', () => {
      renderState(container, 'linked', onConnect);

      expect(container.querySelector('.error-badge')).not.toBeNull();
      expect(container.textContent).toContain('ページの表示に失敗しました');
    });
  });

  describe('error state', () => {
    it('should show error heading and error badge', () => {
      renderState(container, 'error', onConnect);

      expect(container.querySelector('.heading')?.textContent).toBe('エラー');
      expect(container.querySelector('.error-badge')).not.toBeNull();
      expect(container.textContent).toContain('状態の確認に失敗しました');
    });

    it('should have role=alert on error badge', () => {
      renderState(container, 'error', onConnect);

      expect(container.querySelector('.error-badge')?.getAttribute('role')).toBe('alert');
    });

    it('should show reload button instead of discord button', () => {
      renderState(container, 'error', onConnect);

      expect(container.querySelector('.discord-button')).toBeNull();
      expect(container.querySelector('.submit-button')).not.toBeNull();
      expect(container.querySelector('.submit-button')?.textContent).toBe('再読み込み');
    });

    it('should reload page when reload button is clicked', () => {
      renderState(container, 'error', onConnect);

      container.querySelector<HTMLButtonElement>('.submit-button')?.click();
      expect(window.location.reload).toHaveBeenCalledOnce();
    });

    it('should display custom error message when provided', () => {
      renderState(container, 'error', onConnect, {
        errorMessage: '会員情報を確認できませんでした。',
      });

      expect(container.textContent).toContain('会員情報を確認できませんでした。');
    });
  });

  describe('state transitions', () => {
    it('should replace previous content on state change', () => {
      renderState(container, 'loading', onConnect);
      expect(container.querySelector('.spinner')).not.toBeNull();

      renderState(container, 'error', onConnect);
      expect(container.querySelector('.spinner')).toBeNull();
      expect(container.querySelector('.error-badge')).not.toBeNull();
    });

    it('should clean up event listeners on re-render (no double fire)', () => {
      renderState(container, 'error', onConnect);
      renderState(container, 'error', onConnect);

      container.querySelector<HTMLButtonElement>('.submit-button')?.click();
      expect(window.location.reload).toHaveBeenCalledOnce();
    });
  });
});
