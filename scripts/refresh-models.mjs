#!/usr/bin/env node
// Shared by the daily job and Settings: update real CLIs before discovery.
import { readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { agentInterfaceRoot, callerBinRoot } from './caller.mjs'
import { ensureProviderClis, runUpdateCommand, withModelRefreshLock, terminateUpdateChildren } from './provider-cli-updates.mjs'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const reportPath = process.env.POISE_MODEL_CATALOG_REPORT || join(homedir(), '.poise', 'model-catalog.json')
for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130]]) process.once(signal, () => { terminateUpdateChildren(); process.exit(code) })

const requestedAt = Date.now()
const report = await withModelRefreshLock(reportPath, async () => {
  // Reuse only a check which completed while this invocation waited for it.
  try {
    const prior = JSON.parse(await readFile(reportPath, 'utf8'))
    if (Date.parse(prior.completed_at) >= requestedAt && prior.cli_updates && prior.families) return prior
  } catch { /* no completed overlapping check */ }
  const cliUpdates = await ensureProviderClis()
  let result
  try {
    const callerBin = callerBinRoot()
    const env = {
      ...process.env,
      CLAUDE_CLI: join(projectRoot, 'scripts', 'claude-subscription.mjs'),
      PATH: [callerBin, ...(process.env.PATH || '').split(delimiter).filter(Boolean)].join(delimiter),
    }
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN']) delete env[key]
    const { stdout } = await runUpdateCommand(join(callerBin, 'agent-interface'), ['--refresh-models'], {
      cwd: agentInterfaceRoot(), env, timeoutMs: 10 * 60_000,
    })
    result = JSON.parse(stdout)
    if (!result || !result.families || typeof result.families !== 'object' || Array.isArray(result.families) || !Object.keys(result.families).length) throw new Error('Caller returned an invalid model discovery report')
    for (const provider of Object.keys(cliUpdates)) if (!result.families[provider]) result.families[provider] = { status: 'unavailable', error: 'Caller did not report discovery results' }
  } catch (error) {
    // A failed run must replace an old green check, not leave “nothing new”.
    result = { checked_at: new Date().toISOString(), families: {}, error: error instanceof Error ? error.message : String(error) }
  }
  result.cli_updates = cliUpdates
  result.completed_at = new Date().toISOString()
  const staged = `${reportPath}.${randomUUID()}.tmp`
  await writeFile(staged, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 })
  await rename(staged, reportPath)
  return result
})
if (process.argv.includes('--json')) console.log(JSON.stringify(report))
else {
  const updates = Object.entries(report.cli_updates).map(([name, item]) => `${name} CLI: ${item.status}${item.after ? ` ${item.after}` : ''}${item.error ? ` (${item.error})` : ''}`).join('; ')
  const families = Object.entries(report.families).map(([name, family]) => `${name}: ${family.status}`).join('; ')
  console.log(`${report.completed_at} ${updates} — ${report.error || families}`)
}
if (report.error || Object.values(report.cli_updates).some(item => item.status === 'unavailable') || Object.values(report.families).some(item => item.status !== 'ok')) process.exitCode = 1
