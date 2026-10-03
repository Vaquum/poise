import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['tests/home-isolation.ts', 'tests/snippet-isolation.ts', 'tests/provider-cli-isolation.ts', 'tests/caller-isolation.ts'],
    include: ['tests/**/*.test.{ts,mjs}'],
    clearMocks: true,
    restoreMocks: true,
    testTimeout: 10_000,
  },
})
