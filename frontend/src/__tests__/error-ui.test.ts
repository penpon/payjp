import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  renderInflightSection,
  renderOperationIdBox,
  renderSessionExpiredSection,
  renderWarningBanner,
} from '../error-ui.js';

function toContainer(nodes: (Node | string)[]): HTMLDivElement {
  const div = document.createElement('div');
  for (const n of nodes) div.append(n);
  return div;
}

describe('error-ui', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  describe('renderWarningBanner', () => {
    it('should render element with warning-banner class', () => {
      const banner = renderWarningBanner('受付期間外です。');
      expect(banner.classList.contains('warning-banner')).toBe(true);
    });

    it('should show the message text', () => {
      const banner = renderWarningBanner('すでに購読済みです。');
      expect(banner.textContent).toBe('すでに購読済みです。');
    });

    it('should have role=alert', () => {
      const banner = renderWarningBanner('テスト');
      expect(banner.getAttribute('role')).toBe('alert');
    });
  });

  describe('renderOperationIdBox', () => {
    it('should render operation-id-box with code and copy button', () => {
      const box = renderOperationIdBox('op-test-abc');
      container.appendChild(box);

      expect(container.querySelector('.operation-id-box')).not.toBeNull();
      expect(container.querySelector('.operation-id-value')?.textContent).toBe('op-test-abc');
      expect(container.querySelector('.copy-button')).not.toBeNull();
    });
  });

  describe('renderSessionExpiredSection', () => {
    it('should render error-banner with message', () => {
      const onReAuth = vi.fn();
      const wrapper = toContainer(renderSessionExpiredSection('セッションが無効です。', onReAuth));

      expect(wrapper.querySelector('.error-banner')?.textContent).toBe('セッションが無効です。');
    });

    it('should render Discord re-auth button', () => {
      const wrapper = toContainer(renderSessionExpiredSection('セッション無効', vi.fn()));
      expect(wrapper.querySelector('.discord-button')).not.toBeNull();
      expect(wrapper.querySelector('.discord-button')?.textContent).toContain('再度Discordで連携する');
    });

    it('should call onReAuth when button is clicked', () => {
      const onReAuth = vi.fn();
      const wrapper = toContainer(renderSessionExpiredSection('セッション無効', onReAuth));

      (wrapper.querySelector('.discord-button') as HTMLButtonElement).click();
      expect(onReAuth).toHaveBeenCalledOnce();
    });
  });

  describe('renderInflightSection', () => {
    it('should render error-banner with operationId-specific text when operationId present', () => {
      const wrapper = toContainer(renderInflightSection({ operationId: 'op-123' }));
      expect(wrapper.querySelector('.error-banner')?.textContent).toContain('以下のIDをサポートにお知らせください');
    });

    it('should render error-banner with support-only text when operationId absent', () => {
      const wrapper = toContainer(renderInflightSection({}));
      expect(wrapper.querySelector('.error-banner')?.textContent).toContain('サポートまでお問い合わせください');
    });

    it('should render operationId box and copy button when operationId present', () => {
      const wrapper = toContainer(renderInflightSection({ operationId: 'op-abc-456' }));
      expect(wrapper.querySelector('.operation-id-value')?.textContent).toBe('op-abc-456');
      expect(wrapper.querySelector('.copy-button')).not.toBeNull();
    });

    it('should not render operationId box when operationId absent', () => {
      const wrapper = toContainer(renderInflightSection({}));
      expect(wrapper.querySelector('.operation-id-box')).toBeNull();
    });

    it('should render no auto-retry message', () => {
      const wrapper = toContainer(renderInflightSection({ operationId: 'op-123' }));
      expect(wrapper.textContent).toContain('自動再試行は行われません');
    });
  });
});
