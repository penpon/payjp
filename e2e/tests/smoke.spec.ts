import { expect, test } from '@playwright/test';

test('loads billing entry and plan selection', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'プランを選択' })).toBeVisible();
  await expect(page.getByText('スタータープラン')).toBeVisible();
});
