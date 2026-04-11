/**
 * Playwright E2E 設定（起動・baseURL・webServer 等の事実はここが正）。
 * テストの書き方・仕様正本との整合・手動確認との役割は `.claude/rules/e2e.md` を参照。
 */
import { defineConfig, devices } from '@playwright/test';

/** localhost の方が http + Secure Cookie（__Host-*）の組み合わせで安定しやすい */
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const apiPort = process.env.E2E_API_PORT ?? '3999';

function buildUnsafelyTreatInsecureOriginsAsSecure(): string {
  const origins = new Set<string>();
  const frontend = new URL(baseURL);
  origins.add(frontend.origin);
  const fePort = frontend.port || (frontend.protocol === 'https:' ? '443' : '80');
  if (frontend.hostname === 'localhost') {
    origins.add(`http://127.0.0.1:${fePort}`);
  } else if (frontend.hostname === '127.0.0.1') {
    origins.add(`http://localhost:${fePort}`);
  }
  origins.add(`http://localhost:${apiPort}`);
  origins.add(`http://127.0.0.1:${apiPort}`);
  return [...origins].join(',');
}

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [['list'], ['html', { open: 'never' }]],
  timeout: 120_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    /** Discord 等の SW が route を横取りするのを防ぐ（Playwright 推奨） */
    serviceWorkers: 'block',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        /** `__Host-*` + Secure Cookie を http ローカルでも扱えるようにする（OAuth 実ブラウザ用） */
        launchOptions: {
          args: [`--unsafely-treat-insecure-origin-as-secure=${buildUnsafelyTreatInsecureOriginsAsSecure()}`],
        },
      },
    },
  ],
  webServer: [
    {
      command: 'npm run e2e:serve -w @hayane/server',
      url: `http://localhost:${apiPort}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        ...process.env,
        DATABASE_URL: process.env.DATABASE_URL ?? process.env.DATABASE_URL_TEST ?? '',
        E2E_API_PORT: apiPort,
        E2E_FRONTEND_BASE_URL: baseURL,
      },
    },
    {
      command: 'npm run dev -w frontend',
      url: baseURL,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        ...process.env,
        API_PROXY_TARGET: `http://localhost:${apiPort}`,
        VITE_PAYJP_PUBLIC_KEY: process.env.VITE_PAYJP_PUBLIC_KEY ?? 'pk_test_123456789012345678901234567',
      },
    },
  ],
});
