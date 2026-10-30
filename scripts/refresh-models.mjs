#!/usr/bin/env node
import { environmentSecrets, redact } from '../gateway/src/diagnostics/redaction.mjs'
// Shared by the daily job and Settings: update real CLIs before discovery.
import { readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { agentInterfaceRoot, callerBinRoot } from './caller.mjs'
import { ensureProviderClis, runUpdateCommand, withModelRefreshLock, terminateUpdateChildren, trackUpdateChild, untrackUpdateChild } from './provider-cli-updates.mjs'
import { PROVIDERS, SKIP_REASON, resolveEligibility, sameEligibility, setProbeChildTracker } from './provider-participation.mjs'

setProbeChildTracker(trackUpdateChild, untrackUpdateChild)

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const reportPath = process.env.POISE_MODEL_CATALOG_REPORT || join(homedir(), '.poise', 'model-catalog.json')
for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130]]) process.once(signal, () => { terminateUpdateChildren(); process.exit(code) })

/** A Caller that usage-errors on a provider selection predates scoped
 *  refresh; name the incompatibility instead of its exit code. */
function callerFailure(callerExecutable, error) {
  const diagnostic = error && typeof error === 'object' ? error.diagnostic : null
  const stderr = diagnostic && typeof diagnostic.stderr === 'string' ? diagnostic.stderr : ''
  if (stderr.includes('usage: agent-interface')) return `Update Caller: ${callerExecutable} predates provider-scoped refresh and cannot check a provider selection`
  return error instanceof Error ? error.message : String(error)
}

const requestedAt = Date.now()
const report = await withModelRefreshLock(reportPath, async () => {
  const persist = async (result) => {
    result.completed_at = new Date().toISOString()
    const staged = `${reportPath}.${randomUUID()}.tmp`
    await writeFile(staged, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 })
    await rename(staged, reportPath)
    return result
  }
  // A check which completed while this invocation waited for it; reused
  // only when its participation context still matches.
  let prior = null
  try {
    const candidate = JSON.parse(await readFile(reportPath, 'utf8'))
    if (Date.parse(candidate.completed_at) >= requestedAt && candidate.cli_updates && candidate.families) prior = candidate
  } catch { /* no completed overlapping check */ }
  let eligibility
  try {
    eligibility = await resolveEligibility()
  } catch (error) {
    // Unknown eligibility is an error, never a clean empty success.
    return await persist({ checked_at: new Date().toISOString(), families: {}, error: redact(error instanceof Error ? error.message : String(error), environmentSecrets()) })
  }
  const eligible = eligibility.eligible
  if (prior && sameEligibility(prior.eligible, eligible)) return prior
  const cliUpdates = await ensureProviderClis({ providers: eligible })
  let result
  let callerExecutable
  if (!eligible.length) {
    // No Caller spawn: there is nothing to discover, and the catalog stays.
    result = {
      checked_at: new Date().toISOString(),
      families: Object.fromEntries(PROVIDERS.map(provider => [provider, { status: 'skipped', reason: SKIP_REASON }])),
    }
  } else {
    try {
      const callerBin = callerBinRoot()
      callerExecutable = join(callerBin, 'agent-interface')
      const env = {
        ...process.env,
        CLAUDE_CLI: join(projectRoot, 'scripts', 'claude-subscription.mjs'),
        PATH: [callerBin, ...(process.env.PATH || '').split(delimiter).filter(Boolean)].join(delimiter),
      }
      for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN']) delete env[key]
      // Absent selection keeps the bare all-provider call, which older
      // Callers still answer; a scoped check names its providers.
      const args = eligible.length === PROVIDERS.length ? ['--refresh-models'] : ['--refresh-models', '--families', eligible.join(',')]
      const { stdout } = await runUpdateCommand(callerExecutable, args, {
        cwd: agentInterfaceRoot(), env, timeoutMs: 10 * 60_000,
      })
      result = JSON.parse(stdout)
      if (!result || !result.families || typeof result.families !== 'object' || Array.isArray(result.families) || !Object.keys(result.families).length) throw new Error('Caller returned an invalid model discovery report')
      for (const provider of PROVIDERS) {
        if (!eligible.includes(provider)) result.families[provider] = { status: 'skipped', reason: SKIP_REASON }
        else if (!result.families[provider]) result.families[provider] = { status: 'unavailable', error: 'Caller did not report discovery results' }
      }
    } catch (error) {
      // A failed run must replace an old green check, not leave “nothing new”.
      result = { checked_at: new Date().toISOString(), families: {}, error: redact(callerFailure(callerExecutable, error), environmentSecrets()), ...(error && typeof error === 'object' && error.diagnostic ? { diagnostic: error.diagnostic } : {}) }
    }
  }
  for (const family of Object.values(result.families)) if (typeof family.error === 'string') family.error = redact(family.error, environmentSecrets())
  if (callerExecutable) result.caller_executable = callerExecutable
  result.cli_updates = cliUpdates
  result.eligible = eligible
  return await persist(result)
})
if (process.argv.includes('--json')) console.log(JSON.stringify(report))
else {
  const updates = Object.entries(report.cli_updates || {}).map(([name, item]) => `${name} CLI: ${item.status}${item.after ? ` ${item.after}` : ''}${item.error ? ` (${item.error})` : ''}`).join('; ')
  const families = Object.entries(report.families || {}).map(([name, family]) => `${name}: ${family.status}`).join('; ')
  console.log(`${report.completed_at} ${updates} — ${report.error || families}`)
}
if (report.error || Object.values(report.cli_updates || {}).some(item => item.status === 'unavailable') || Object.values(report.families || {}).some(item => item.status !== 'ok' && item.status !== 'skipped')) process.exitCode = 1
