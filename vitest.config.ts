import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Filesystem/child-process integration suites share local resources; parallel
    // execution can exceed their deadlines even when each suite passes alone.
    maxWorkers: 1,
    include: ['packages/*/test/**/*.test.ts', 'tests/**/*.test.ts'],
    passWithNoTests: true,
  },
});
