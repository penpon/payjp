import { expect, test } from '@playwright/test';
import { installPayjpMockRoute } from '../fixtures/payjp-mock.js';

async function fillBillingFormReadyToSubmit(page: import('@playwright/test').Page, email: string): Promise<void> {
  await page.goto('/member');
  await expect(page.getByRole('heading', { name: 'プランを選択' })).toBeVisible();
  await page.fill('#billing-email', email);
  await page.fill('#billing-name', 'TARO E2E');
  await page.locator('#billing-consent').check();
  await expect(page.getByRole('button', { name: '登録する' })).toBeEnabled({ timeout: 15_000 });
}

test.describe('Subscribe negative paths (T-P0-02)', () => {
  test('3DS not verified: shows error and does not POST /v1/subscriptions', async ({ page }) => {
    let postCount = 0;
    await page.route('**/v1/subscriptions', async (route, request) => {
      if (request.method() === 'POST') {
        postCount++;
      }
      await route.continue();
    });

    await installPayjpMockRoute(page, { tokenBehavior: 'unverified' });
    await fillBillingFormReadyToSubmit(page, `e2e-3ds-fail-${Date.now()}@example.com`);

    await page.getByRole('button', { name: '登録する' }).click();

    await expect(page.getByRole('alert')).toContainText('3Dセキュア認証が完了していません');
    expect(postCount).toBe(0);
  });

  test('createToken receives three_d_secure and card name/email', async ({ page }) => {
    await installPayjpMockRoute(page, { tokenBehavior: 'verified' });
    const email = `e2e-token-args-${Date.now()}@example.com`;
    await fillBillingFormReadyToSubmit(page, email);

    await page.getByRole('button', { name: '登録する' }).click();

    await expect(page.getByText('登録が完了しました')).toBeVisible({ timeout: 60_000 });

    const args = (await page.evaluate(
      () => (window as unknown as { __E2E_PAYJP_LAST_CREATE_TOKEN_ARGS?: unknown }).__E2E_PAYJP_LAST_CREATE_TOKEN_ARGS,
    )) as {
      three_d_secure?: boolean;
      card?: { name?: string; email?: string };
    };
    expect(args?.three_d_secure).toBe(true);
    expect(args?.card?.name).toBe('TARO E2E');
    expect(args?.card?.email).toBe(email);
  });

  test('privacy consent off: no createToken args and no POST', async ({ page }) => {
    let postCount = 0;
    await page.route('**/v1/subscriptions', async (route, request) => {
      if (request.method() === 'POST') {
        postCount++;
      }
      await route.continue();
    });

    await installPayjpMockRoute(page, { tokenBehavior: 'verified' });
    await fillBillingFormReadyToSubmit(page, `e2e-no-consent-${Date.now()}@example.com`);

    await page.locator('#billing-consent').uncheck();
    await expect(page.getByRole('button', { name: '登録する' })).toBeDisabled();

    await page.evaluate(() => {
      const b = document.querySelector('.submit-button') as HTMLButtonElement | null;
      if (b) {
        b.removeAttribute('disabled');
        b.click();
      }
    });

    await expect(page.getByRole('alert')).toContainText('個人情報の取り扱いへの同意が必要です');

    const lastArgs = await page.evaluate(
      () => (window as unknown as { __E2E_PAYJP_LAST_CREATE_TOKEN_ARGS?: unknown }).__E2E_PAYJP_LAST_CREATE_TOKEN_ARGS,
    );
    expect(lastArgs).toBeNull();
    expect(postCount).toBe(0);
  });
});
