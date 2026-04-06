import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@hayane/frontend',
    globals: true,
    environment: 'happy-dom',
    include: ['src/**/*.test.ts'],
    testTimeout: 30000,
  },
});
