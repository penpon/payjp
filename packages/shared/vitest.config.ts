import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@hayane/shared',
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 30000,
  },
});
