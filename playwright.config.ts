import { defineConfig, devices } from '@playwright/test'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { resolve } from 'node:path'
import { isolatedEnvironment, removeCredentialVariables } from './tests/fixtures/cli-isolation'

const port = Number(process.env.POISE_E2E_PORT ?? 5566)
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('POISE_E2E_PORT must be an integer from 1 to 65535')
}
const baseURL = `http://127.0.0.1:${port}`
const e2eRoot = resolve('test-results/e2e')

// The preview server runs with a home folder and agent-CLI configuration of
// its own and with stand-ins for the agent CLIs: its Claude sign-in check, and
// anything else it starts, never reaches the developer's CLIs or their logins.
// It and whatever a test starts also run without the variables Poise's
// diagnostics redact as credentials (tests/home-isolation.ts says why):
// Playwright gives the server and its workers this process's environment.
mkdirSync(e2eRoot, { recursive: true })
removeCredentialVariables(process.env)
const isolation = isolatedEnvironment(mkdtempSync(resolve(e2eRoot, 'isolation-')), process.env.PATH ?? '')

export default defineConfig({
  testDir: './tests/e2e',
  // Local runs serialize one at a time per workspace (tests/e2e/global-setup.ts).
  globalSetup: './tests/e2e/global-setup.ts',
  outputDir: 'test-results/playwright',
  snapshotPathTemplate: '{testDir}/{testFilePath}-snapshots/{arg}{-projectName}{ext}',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }], ['json', { outputFile: 'test-results/playwright.json' }]]
    : 'list',
  expect: {
    toHaveScreenshot: {
      animations: 'disabled',
      maxDiffPixelRatio: 0.03,
    },
  },
  use: {
    baseURL,
    viewport: { width: 1280, height: 720 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    // Optional human-journey QC: keep the normal CI/install footprint unchanged.
    ...(process.env.POISE_BROWSER_QC === '1' ? [
      { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
      { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    ] : []),
  ],
  webServer: {
    command: process.env.POISE_E2E_PREBUILT === '1' ? 'npm start' : 'npm run preview',
    env: {
      ...isolation,
      JEV_API_KEY: '', // Live account is never used by the automated preview.
      POISE_DB: resolve(e2eRoot, 'cache.db'),
      POISE_PORT: String(port),
      // tests/e2e/extensions.spec.ts serves a registry here; nothing reaches the real one.
      POISE_MCP_REGISTRY_URL: `http://127.0.0.1:${port + 3}`,
      POISE_EDITOR_DIR: resolve(e2eRoot, 'editor'),
      POISE_CHAT_ATTACHMENTS_DIR: resolve(e2eRoot, 'chat-attachments'),
      POISE_ESPANSO_MATCH_DIR: resolve(e2eRoot, 'espanso-match'),
      // Stand-in Caller CLIs from prepare-e2e.mjs.
      CALLER_BIN_ROOT: resolve(e2eRoot, 'caller/bin'),
      AGENT_INTERFACE_ROOT: resolve(e2eRoot, 'caller/agent_interface'),
      TMPDIR: resolve(e2eRoot, 'tmp'),
    },
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
