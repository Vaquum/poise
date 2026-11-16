// Called only inside the original native Call's registered kernel boundary.
// Shared CLI installations/cache remain shared; per-Call staging is tracked
// by Caller before this process or any updater is allowed to start.
import { isAbsolute } from 'node:path'
import { ensureProviderClis, PROVIDERS, terminateUpdateChildren } from './provider-cli-updates.mjs'

const [operation, stagingRoot, ...providers] = process.argv.slice(2)
if (operation !== '--native-prepare' || !stagingRoot || !isAbsolute(stagingRoot) || !providers.length
  || new Set(providers).size !== providers.length || providers.some(provider => !PROVIDERS.includes(provider))) {
  throw new Error('Native preparation requires its registered staging directory and explicit providers')
}
process.once('SIGTERM', () => { terminateUpdateChildren(); process.exit(143) })
const results = await ensureProviderClis({ providers, stagingRoot })
const env = {}
const warnings = []
let failure, unavailableProvider
for (const provider of providers) {
  const result = results[provider]
  if (result.status === 'unavailable') warnings.push(`${provider}: ${result.error}`)
  if (!result.launchPath && !process.env[`${provider.toUpperCase()}_CLI`]
    && (result.status === 'unavailable' || provider === 'codex')) {
    unavailableProvider = provider
    if (provider === providers[0]) failure = `${provider} CLI has no verified launcher: ${result.error || 'version check failed'}`
  }
  if (provider === 'codex' && !process.env.CODEX_CLI) {
    if (result.launchPath) env.CODEX_CLI = result.launchPath
  }
}
// Updater errors are already redacted by the existing updater. Keep warnings
// in Caller's existing diagnostic stream even when a retained launcher works.
const diagnostic = warnings.length || unavailableProvider ? { version: 1, source: 'caller', severity: failure ? 'error' : 'warning',
  operation: 'provider.cli_update', phase: 'launcher_verification', outcome: 'unavailable',
  message: (failure || warnings.join('; ')).slice(0, 4096), stderr: warnings.join('\n').slice(0, 8192), stderr_truncated: warnings.join('\n').length > 8192,
  ...(unavailableProvider ? { provider: failure ? providers[0] : unavailableProvider, submission: 'none' } : {}) } : null
process.stdout.write(JSON.stringify({ version: 1, env, diagnostic }) + '\n')
if (failure) process.exitCode = 1
