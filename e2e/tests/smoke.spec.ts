import { expect, test } from '@playwright/test';

test('loads billing entry and plan selection', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'プランを選択' })).toBeVisible();
  await expect(page.getByText('スタータープラン')).toBeVisible();
});

test('legal static pages are served', async ({ page }) => {
  await page.goto('/tokushou.html');
  await expect(page.getByRole('heading', { name: '特定商取引法に基づく表記' })).toBeVisible();
  await page.goto('/terms.html');
  await expect(page.getByRole('heading', { name: '利用規約' })).toBeVisible();
  await page.goto('/');
  await expect(page.getByRole('link', { name: '特定商取引法に基づく表記' })).toBeVisible();
});

test('public service overview page is served without login', async ({ page }) => {
  await page.goto('/service.html');
  await expect(page.getByRole('heading', { name: 'サービス案内' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'スタータープラン' })).toBeVisible();
});
