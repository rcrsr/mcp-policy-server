import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: '.',
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globals: true,
    clearMocks: true,
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Process entry points are exercised as subprocesses in tests/binaries.test.ts,
      // which V8 coverage cannot observe.
      exclude: ['src/**/*.d.ts', 'src/index.ts', 'src/cli.ts', 'src/hook.ts'],
      reportsDirectory: 'coverage',
      thresholds: {
        branches: 80,
        functions: 80,
        lines: 80,
        statements: 80,
      },
    },
    silent: true,
  },
});
