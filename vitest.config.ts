import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*/vitest.config.ts', 'frontend/vitest.config.ts', 'admin-frontend/vitest.config.ts'],
  },
});
