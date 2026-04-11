import { expect, type Page } from '@playwright/test';

/**
 * メインフレームの Discord 遷移は `page.route` で拾えない環境があるため、
 * API リクエストで `/start` の Cookie + state を取得し、callback へ直接遷移する。
 */
export async function completeDiscordOAuthInBrowser(page: Page): Promise<void> {
  const startRes = await page.request.get('/v1/auth/discord/start', { maxRedirects: 0 });
  expect(startRes.status(), 'OAuth start should redirect').toBe(302);
  const loc = startRes.headers().location;
  if (!loc) throw new Error('OAuth start: missing Location');
  const authUrl = new URL(loc);
  const state = authUrl.searchParams.get('state');
  if (!state) throw new Error('OAuth start: missing state in Location');

  await page.goto(`/v1/auth/discord/callback?code=mock-code&state=${encodeURIComponent(state)}`);
  await page.waitForURL((u) => u.pathname === '/' || u.pathname === '', { timeout: 60_000 });
}
