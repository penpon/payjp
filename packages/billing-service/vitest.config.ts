import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@hayane/billing-service',
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 30000,
    // 明示的な `--coverage` 指定時のみ評価される。通常 `npm test` 実行時の挙動は不変。
    // threshold 到達後に CI へ組み込む段階導入方針 (plan Phase B-6)。
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/core/**', 'src/shell/**'],
      exclude: ['**/*.test.ts', 'src/shell/index.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 70,
      },
    },
  },
});
