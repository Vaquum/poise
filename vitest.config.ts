import { defineConfig } from 'vitest/config'
import FirstFailureReporter from './scripts/vitest-first-failure-reporter'

export default defineConfig({
  test: {
    environment: 'node',
    reporters: ['default', new FirstFailureReporter()],
    // Bound resource use on shared development hosts without relaxing test deadlines.
    maxWorkers: 2,
    // Tests that re-import the server pile up AsyncLocalStorage instances, and
    // Node 22's default implementation visits every one of them on every promise.
    execArgv: ['--experimental-async-context-frame'],
    setupFiles: ['tests/home-isolation.ts', 'tests/snippet-isolation.ts', 'tests/provider-cli-isolation.ts', 'tests/caller-isolation.ts'],
    include: ['tests/**/*.test.{ts,mjs}'],
    clearMocks: true,
    restoreMocks: true,
    testTimeout: 10_000,
  },
})
