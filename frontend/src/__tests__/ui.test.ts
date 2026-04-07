import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderState } from '../ui.js';

describe('ui', () => {
  let container: HTMLDivElement;
  const onConnect = vi.fn();

  beforeEach(() => {
    container = document.createElement('div');
    onConnect.mockClear();
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

  describe('not_linked state', () => {
    it('should show heading and discord button', () => {
      renderState(container, 'not_linked', onConnect);

      expect(container.querySelector('.heading')?.textContent).toBe('Discord連携');
      expect(container.querySelector('.discord-button')).not.toBeNull();
      expect(container.querySelector('.discord-button')?.textContent).toContain('Discordで連携する');
    });

    it('should show description text', () => {
      renderState(container, 'not_linked', onConnect);

      expect(container.textContent).toContain('Discordアカウントとの連携が必要です');
    });

    it('should call onConnect when button is clicked', () => {
      renderState(container, 'not_linked', onConnect);

      container.querySelector<HTMLButtonElement>('.discord-button')?.click();
      expect(onConnect).toHaveBeenCalledOnce();
    });

    it('should contain discord logo SVG', () => {
      renderState(container, 'not_linked', onConnect);

      expect(container.querySelector('.discord-button svg')).not.toBeNull();
    });
  });

  describe('linked state', () => {
    it('should show success badge', () => {
      renderState(container, 'linked', onConnect);

      expect(container.querySelector('.success-badge')).not.toBeNull();
      expect(container.textContent).toContain('Discord連携済み');
    });

    it('should show plan placeholder', () => {
      renderState(container, 'linked', onConnect);

      expect(container.querySelector('.plan-placeholder')).not.toBeNull();
      expect(container.textContent).toContain('プラン選択は次のステップで利用可能になります');
    });

    it('should not show discord button', () => {
      renderState(container, 'linked', onConnect);

      expect(container.querySelector('.discord-button')).toBeNull();
    });

    it('should have role=status on success badge', () => {
      renderState(container, 'linked', onConnect);

      expect(container.querySelector('.success-badge')?.getAttribute('role')).toBe('status');
    });
  });

  describe('error state', () => {
    it('should show error badge', () => {
      renderState(container, 'error', onConnect);

      expect(container.querySelector('.error-badge')).not.toBeNull();
      expect(container.textContent).toContain('連携状態の確認に失敗しました');
    });

    it('should have role=alert on error badge', () => {
      renderState(container, 'error', onConnect);

      expect(container.querySelector('.error-badge')?.getAttribute('role')).toBe('alert');
    });

    it('should show discord button for retry', () => {
      renderState(container, 'error', onConnect);

      expect(container.querySelector('.discord-button')).not.toBeNull();
    });

    it('should call onConnect when retry button is clicked', () => {
      renderState(container, 'error', onConnect);

      container.querySelector<HTMLButtonElement>('.discord-button')?.click();
      expect(onConnect).toHaveBeenCalledOnce();
    });
  });

  describe('state transitions', () => {
    it('should replace previous content on state change', () => {
      renderState(container, 'loading', onConnect);
      expect(container.querySelector('.spinner')).not.toBeNull();

      renderState(container, 'linked', onConnect);
      expect(container.querySelector('.spinner')).toBeNull();
      expect(container.querySelector('.success-badge')).not.toBeNull();
    });

    it('should clean up event listeners on re-render (no double fire)', () => {
      renderState(container, 'not_linked', onConnect);
      renderState(container, 'not_linked', onConnect);

      container.querySelector<HTMLButtonElement>('.discord-button')?.click();
      expect(onConnect).toHaveBeenCalledOnce();
    });
  });
});
