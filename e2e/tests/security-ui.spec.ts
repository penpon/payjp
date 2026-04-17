import { expect, test } from '@playwright/test';
import { completeDiscordOAuthInBrowser } from '../fixtures/oauth-browser-flow.js';

test.describe('Security hints (browser-visible)', () => {
  test('HttpOnly: session cookie names are not readable from document.cookie', async ({ page }) => {
    await page.goto('/member');
    await completeDiscordOAuthInBrowser(page);

    const cookieStr = await page.evaluate(() => document.cookie);
    expect(cookieStr).not.toMatch(/oauth_session|link_session/);
  });

  test('page HTML does not contain PAY.JP secret key prefix sk_', async ({ page }) => {
    await page.goto('/member');
    const hasSk = await page.evaluate(() => /sk_(test|live)_/.test(document.documentElement.innerHTML));
    expect(hasSk).toBe(false);
  });
});
