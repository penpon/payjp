import type { Page } from '@playwright/test';

/**
 * Served in place of https://js.pay.jp/v2/pay.js so `window.Payjp` matches the
 * billing UI contract (elements + createToken) without loading the real SDK.
 */
export const PAYJP_MOCK_SCRIPT_BODY = `(function () {
  window.Payjp = function () {
    return {
      elements: function () {
        return {
          create: function () {
            return {
              mount: function () {},
              on: function (event, cb) {
                if (event === 'change') {
                  queueMicrotask(function () {
                    cb({ complete: true, error: null });
                  });
                }
              },
            };
          },
        };
      },
      createToken: function () {
        return Promise.resolve({
          id: 'tok_test_e2e',
          card: { three_d_secure_status: 'verified' },
        });
      },
    };
  };
})();`;

/** @deprecated Prefer {@link installPayjpMockRoute} — real pay.js overwrites init scripts. */
export const PAYJP_MOCK_INIT = PAYJP_MOCK_SCRIPT_BODY;

/**
 * Block the real PAY.JP SDK and inject the mock (real script runs after init scripts and would overwrite `window.Payjp`).
 */
export async function installPayjpMockRoute(page: Page): Promise<void> {
  await page.route('**/js.pay.jp/v2/pay.js', async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'application/javascript; charset=utf-8' },
      body: PAYJP_MOCK_SCRIPT_BODY,
    });
  });
}
