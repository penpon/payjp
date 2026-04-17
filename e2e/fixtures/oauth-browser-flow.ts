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
  await page.waitForURL((u) => u.pathname === '/' || u.pathname === '' || u.pathname === '/member', {
    timeout: 60_000,
  });
  // Server-side callback redirects to FRONTEND_BASE_URL ('/'), which is now the marketing
  // site under the &line rebrand. The PAY.JP SPA mounts on /member and consumes the
  // __Host-link_session cookie there, so navigate explicitly when we landed on marketing.
  if (new URL(page.url()).pathname !== '/member') {
    await page.goto('/member');
  }
}
