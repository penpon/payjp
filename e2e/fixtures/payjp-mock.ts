import type { Page } from '@playwright/test';

/** How the mock resolves `createToken` (see `window.__E2E_PAYJP_TOKEN_BEHAVIOR`). */
export type PayjpMockTokenBehavior = 'verified' | 'unverified' | 'error';

export interface InstallPayjpMockOptions {
  tokenBehavior?: PayjpMockTokenBehavior;
}

/**
 * Served in place of https://js.pay.jp/v2/pay.js so `window.Payjp` matches the
 * billing UI contract (elements + createToken) without loading the real SDK.
 *
 * Reads `window.__E2E_PAYJP_TOKEN_BEHAVIOR` (set via `installPayjpMockRoute` init script).
 * Stores the last `createToken` second argument in `window.__E2E_PAYJP_LAST_CREATE_TOKEN_ARGS`.
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
      createToken: function (_el, opts) {
        window.__E2E_PAYJP_LAST_CREATE_TOKEN_ARGS =
          opts && typeof opts === 'object'
            ? JSON.parse(JSON.stringify(opts))
            : opts === undefined
              ? null
              : opts;
        var behavior = window.__E2E_PAYJP_TOKEN_BEHAVIOR || 'verified';
        if (behavior === 'error') {
          return Promise.resolve({ error: { message: 'mock token error' } });
        }
        if (behavior === 'unverified') {
          return Promise.resolve({
            id: 'tok_test_e2e',
            card: { three_d_secure_status: 'failed' },
          });
        }
        return Promise.resolve({
          id: 'tok_test_e2e',
          card: { three_d_secure_status: 'verified' },
        });
      },
    };
  };
})();`;

/**
 * Block the real PAY.JP SDK and inject the mock (real script runs after init scripts and would overwrite `window.Payjp`).
 */
export async function installPayjpMockRoute(page: Page, options?: InstallPayjpMockOptions): Promise<void> {
  const tokenBehavior: PayjpMockTokenBehavior = options?.tokenBehavior ?? 'verified';

  await page.addInitScript((behavior) => {
    const w = window as unknown as {
      __E2E_PAYJP_TOKEN_BEHAVIOR: PayjpMockTokenBehavior;
      __E2E_PAYJP_LAST_CREATE_TOKEN_ARGS: null;
    };
    w.__E2E_PAYJP_TOKEN_BEHAVIOR = behavior;
    w.__E2E_PAYJP_LAST_CREATE_TOKEN_ARGS = null;
  }, tokenBehavior);

  await page.route('**/js.pay.jp/v2/pay.js', async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'application/javascript; charset=utf-8' },
      body: PAYJP_MOCK_SCRIPT_BODY,
    });
  });
}
