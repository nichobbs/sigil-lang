import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['test/**/*.test.ts', 'apps/**/test/*.test.ts'], exclude: ['node_modules/**', '.claude/**'] },
});
