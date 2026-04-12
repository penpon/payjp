import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  test: {
    name: '@hayane/admin-frontend',
    environment: 'happy-dom',
    include: ['src/**/*.test.ts'],
  },
});
