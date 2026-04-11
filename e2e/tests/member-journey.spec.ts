import { expect, test } from '@playwright/test';
import { completeDiscordOAuthInBrowser } from '../fixtures/oauth-browser-flow.js';
import { installPayjpMockRoute } from '../fixtures/payjp-mock.js';

test.describe.configure({ mode: 'serial' });

test.describe('subscribe → Discord OAuth → subscribed → cancel modal', () => {
  test.beforeEach(async ({ page }) => {
    await installPayjpMockRoute(page);
  });

  test('full path to Google Form handoff', async ({ page }) => {
    const email = `e2e-journey-${Date.now()}@example.com`;

    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'プランを選択' })).toBeVisible();
    await page.fill('#billing-email', email);
    await page.fill('#billing-name', 'JOURNEY E2E');
    await page.locator('#billing-consent').check();
    await expect(page.getByRole('button', { name: '登録する' })).toBeEnabled({ timeout: 15_000 });
    await page.getByRole('button', { name: '登録する' }).click();
    await expect(page.getByText('登録が完了しました')).toBeVisible({ timeout: 60_000 });

    await completeDiscordOAuthInBrowser(page);

    await expect(page.getByText('連携完了')).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'トップに戻る' }).click();

    await expect(page.getByRole('heading', { name: '購読状況' })).toBeVisible({ timeout: 30_000 });

    await page.getByRole('button', { name: '退会する' }).click();
    await expect(page.getByRole('heading', { name: '退会の確認' })).toBeVisible();

    await Promise.all([
      page.waitForURL((u) => u.hostname === 'docs.google.com', { timeout: 30_000 }),
      page.getByRole('button', { name: 'Google Formへ進む' }).click(),
    ]);
  });
});
