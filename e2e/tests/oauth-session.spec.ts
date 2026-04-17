import { expect, test } from '@playwright/test';
import { completeDiscordOAuthInBrowser } from '../fixtures/oauth-browser-flow.js';

test('OAuth start → Discord redirect mock → callback → session shows linked', async ({ page }) => {
  await page.goto('/member');
  await completeDiscordOAuthInBrowser(page);

  const data = await page.evaluate(async () => {
    const r = await fetch('/v1/auth/discord/session', {
      credentials: 'include',
      headers: { Origin: window.location.origin },
    });
    return r.json() as Promise<{ linked: boolean; discordUserId?: string }>;
  });

  expect(data.linked).toBe(true);
  expect(data.discordUserId).toMatch(/^\d{15,20}$/);
});
