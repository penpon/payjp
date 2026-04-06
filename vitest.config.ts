import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'packages/shared/vitest.config.ts',
      'packages/auth-service/vitest.config.ts',
      'packages/billing-service/vitest.config.ts',
      'packages/sync-service/vitest.config.ts',
      'packages/server/vitest.config.ts',
      'frontend/vitest.config.ts',
    ],
  },
});
