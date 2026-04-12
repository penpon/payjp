import { expect, test } from '@playwright/test';
import { installPayjpMockRoute } from '../fixtures/payjp-mock.js';

async function fillBillingFormReadyToSubmit(page: import('@playwright/test').Page, email: string): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'プランを選択' })).toBeVisible();
  await page.fill('#billing-email', email);
  await page.fill('#billing-name', 'TARO E2E');
  await page.locator('#billing-consent').check();
  await expect(page.getByRole('button', { name: '登録する' })).toBeEnabled({ timeout: 15_000 });
}

test.describe('Subscribe API substitution', () => {
  test('503 INFLIGHT_OPERATION shows operationId and single POST', async ({ page }) => {
    let postCount = 0;
    await page.route('**/v1/subscriptions', async (route, request) => {
      if (request.method() !== 'POST') {
        await route.continue();
        return;
      }
      postCount++;
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: false,
          errorCode: 'INFLIGHT_OPERATION',
          message: '処理中の操作があります。',
          operationId: 'op-e2e-inflight',
        }),
      });
    });

    await installPayjpMockRoute(page, { tokenBehavior: 'verified' });
    await fillBillingFormReadyToSubmit(page, `e2e-503-${Date.now()}@example.com`);

    await page.getByRole('button', { name: '登録する' }).click();

    await expect(page.getByRole('heading', { name: 'エラーが発生しました' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('alert')).toContainText('処理中の操作があります');
    await expect(page.getByText('op-e2e-inflight')).toBeVisible();
    expect(postCount).toBe(1);
  });

  test('401 INVALID_LINK_SESSION shows Discord re-auth', async ({ page }) => {
    let postCount = 0;
    await page.route('**/v1/subscriptions', async (route, request) => {
      if (request.method() !== 'POST') {
        await route.continue();
        return;
      }
      postCount++;
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: false,
          errorCode: 'INVALID_LINK_SESSION',
          message: 'Session invalid',
        }),
      });
    });

    await installPayjpMockRoute(page, { tokenBehavior: 'verified' });
    await fillBillingFormReadyToSubmit(page, `e2e-401-${Date.now()}@example.com`);

    await page.getByRole('button', { name: '登録する' }).click();

    await expect(page.getByRole('heading', { name: 'エラーが発生しました' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: '再度Discordで連携する' })).toBeVisible();
    expect(postCount).toBe(1);
  });
});
