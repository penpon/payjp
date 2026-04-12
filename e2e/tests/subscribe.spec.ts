import { expect, test } from '@playwright/test';
import { installPayjpMockRoute } from '../fixtures/payjp-mock.js';

test('subscribe flow shows completion after Discord and billing', async ({ page }) => {
  await installPayjpMockRoute(page);
  const email = `e2e-subscribe-${Date.now()}@example.com`;
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'プランを選択' })).toBeVisible();
  await page.fill('#billing-email', email);
  await page.fill('#billing-name', 'TARO E2E');
  await page.locator('#billing-consent').check();
  await expect(page.getByRole('button', { name: '登録する' })).toBeEnabled({ timeout: 15_000 });
  await page.getByRole('button', { name: '登録する' }).click();

  await expect(page.getByText('登録が完了しました')).toBeVisible({ timeout: 60_000 });
});
