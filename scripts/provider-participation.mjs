// Which providers take part in model maintenance: a provider participates
// when Poise has a durable record that it was configured, or when its live
// status positively verifies a usable sign-in. Never-configured providers
// are skipped; a provider whose eligibility cannot be established is an
// error, never a silent skip. Plain JavaScript, so both the TypeScript
// server and the standalone refresh script resolve the same rule.
import { spawn } from 'node:child_process'
import { existsSync, constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

export const PROVIDERS = ['claude', 'codex', 'grok', 'antigravity', 'muse']
/** The only skip reason: withdrawal removes the record, so a withdrawn
 *  provider reads exactly like one never configured. */
export const SKIP_REASON = 'never_configured'
const LIVE_PROVIDERS = ['claude', 'codex']
const LOGINS_KEY = 'account_logins'
export const ELIGIBILITY_PROBE_TIMEOUT_MS = 10_000
const PROBE_OUTPUT_BYTES = 64 * 1024

export class EligibilityError extends Error {}

const moduleDir = dirname(fileURLToPath(import.meta.url))
const CLAUDE_WRAPPER = join(moduleDir, 'claude-subscription.mjs')

/** The settings database, resolved exactly like server/db.ts. */
export function participationDbPath(env = process.env) {
  return env.POISE_DB || join(env.HOME || homedir(), '.poise', 'cache.db')
}

function loginsFromValue(dbPath, raw) {
  if (raw === undefined || raw === null) return {}
  let value
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new EligibilityError(`The provider record in ${dbPath} is corrupt: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new EligibilityError(`The provider record in ${dbPath} is corrupt`)
  return Object.fromEntries(Object.entries(value).filter(([, at]) => typeof at === 'string' && at !== ''))
}

/** The durable configuration record. A missing database, or one the server
 *  has not initialized yet, truthfully holds no records; anything else that
 *  cannot be read fails instead of reading as unconfigured. */
export function readAccountLogins(dbPath = participationDbPath()) {
  if (!existsSync(dbPath)) return {}
  const db = new Database(dbPath, { timeout: 5000 })
  try {
    let raw
    try {
      raw = db.prepare('SELECT value FROM meta WHERE key = ?').get(LOGINS_KEY)?.value
    } catch (error) {
      if (error instanceof Error && /no such table/i.test(error.message)) return {}
      throw error
    }
    return loginsFromValue(dbPath, raw)
  } catch (error) {
    if (error instanceof EligibilityError) throw error
    throw new EligibilityError(`The provider record in ${dbPath} could not be read: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    db.close()
  }
}

/** Remember a positive live observation, so a later lost sign-in reads as
 *  a failure, not as never configured. The read and the write hold one
 *  write transaction, so an overlapping server login can neither be erased
 *  nor erase this memo. Best effort: the observation still applies to this
 *  run when the memo cannot be kept. */
export function recordObservedParticipation(dbPath, provider) {
  if (!LIVE_PROVIDERS.includes(provider) || !existsSync(dbPath)) return
  let db
  try {
    db = new Database(dbPath, { timeout: 5000 })
    db.exec('BEGIN IMMEDIATE')
    let raw
    try {
      raw = db.prepare('SELECT value FROM meta WHERE key = ?').get(LOGINS_KEY)?.value
    } catch {
      db.exec('ROLLBACK')
      return
    }
    let current
    try {
      current = loginsFromValue(dbPath, raw)
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    if (!current[provider]) {
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
        .run(LOGINS_KEY, JSON.stringify({ ...current, [provider]: new Date().toISOString() }))
    }
    db.exec('COMMIT')
  } catch (error) {
    try {
      db?.exec('ROLLBACK')
    } catch { /* already rolled back */ }
    console.error(`[models] could not record the observed ${provider} sign-in: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    db?.close()
  }
}

/** Resolve a provider launcher on PATH. Shared with the updaters, and with
 *  the Claude probe, whose wrapper failure alone cannot tell a missing CLI
 *  from a failed one. */
export async function executable(command, env) {
  const candidates = isAbsolute(command) ? [command] : (env.PATH || '').split(delimiter).filter(Boolean).filter(isAbsolute).map(dir => join(dir, command))
  for (const path of candidates) {
    try { await access(path, constants.X_OK); return path } catch { /* next PATH entry */ }
  }
  throw new Error(`${command} is not installed on Poise's PATH`)
}

/** `claude auth status --json`: signed in means a Claude subscription, the
 *  only sign-in Poise runs Claude on (server/claude-auth.ts). Null when the
 *  output says nothing usable. */
export function parseClaudeSignIn(stdout) {
  let value
  try {
    value = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.loggedIn !== 'boolean') return null
  return value.loggedIn === true && value.authMethod === 'claude.ai' && value.apiProvider === 'firstParty'
}

/** `codex login status`, which answers on stderr. Null when the output says
 *  nothing usable. */
export function parseCodexSignIn(output) {
  if (/^Logged in using (ChatGPT|an API key)\b/m.test(output)) return true
  if (/^Not logged in\b/m.test(output)) return false
  return null
}

// Status reads see the stored sign-in, never a credential from the
// environment: the same non-secret coordinates the updater subprocesses get,
// plus Claude's configured credential location.
function probeEnvironment(source, extra = []) {
  const keys = ['HOME', 'USERPROFILE', 'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP', 'USER', 'LANG', 'LC_ALL', 'SHELL',
    'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', ...extra]
  return { ...Object.fromEntries(keys.filter(key => source[key] !== undefined).map(key => [key, source[key]])), CI: '1', NO_COLOR: '1' }
}

let trackChild = () => {}
let untrackChild = () => {}
/** The refresh runner owns every probe's process group while it runs, so
 *  stopping the runner cannot leave a status probe behind the lock. */
export function setProbeChildTracker(track, untrack) {
  trackChild = track
  untrackChild = untrack
}

function runProbe(command, args, { env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true })
    trackChild(child)
    let stdout = '', stderr = '', finished = false
    const done = (action) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      untrackChild(child)
      action()
    }
    const timer = setTimeout(() => {
      done(() => reject(Object.assign(new Error(`${command} status probe timed out`), { code: 'PROBE_TIMEOUT' })))
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch { /* already exited */ }
      child.stdout?.destroy()
      child.stderr?.destroy()
    }, timeoutMs)
    const collect = (chunk, into) => {
      if (finished) return
      if (into === 'stdout') stdout += chunk
      else stderr += chunk
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > PROBE_OUTPUT_BYTES) {
        done(() => reject(Object.assign(new Error(`${command} status probe printed more than ${PROBE_OUTPUT_BYTES / 1024} KiB`), { code: 'PROBE_OUTPUT_LIMIT' })))
        try {
          if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL')
          else child.kill('SIGKILL')
        } catch { /* already exited */ }
      }
    }
    child.stdout?.on('data', chunk => collect(chunk, 'stdout'))
    child.stderr?.on('data', chunk => collect(chunk, 'stderr'))
    child.once('error', error => done(() => reject(error)))
    child.once('close', code => done(() => resolve({ stdout, stderr, code })))
  })
}

async function probeLive(provider, env) {
  const timeoutMs = ELIGIBILITY_PROBE_TIMEOUT_MS
  if (provider === 'claude') {
    // The wrapper hides a missing CLI behind its own exit code, so look for
    // the launcher before asking it anything.
    try {
      await executable('claude', { PATH: env.PATH })
    } catch {
      return { live: 'missing' }
    }
    const probeEnv = probeEnvironment(env, ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_SHELL_PREFIX'])
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN']) delete probeEnv[key]
    probeEnv.CLAUDE_CLI = CLAUDE_WRAPPER
    let result
    try {
      result = await runProbe(process.execPath, [CLAUDE_WRAPPER, 'auth', 'status', '--json'], { env: probeEnv, timeoutMs })
    } catch (error) {
      if (error.code === 'ENOENT') return { live: 'missing' }
      throw new EligibilityError(`claude eligibility is unknown: \`claude auth status\` ${probeFailure(error)}`)
    }
    // Signed out, it still answers on stdout and exits 1.
    const parsed = result.stdout.trim() ? parseClaudeSignIn(result.stdout) : null
    if (parsed === null) throw new EligibilityError('claude eligibility is unknown: `claude auth status` gave no answer Poise can read')
    return { live: parsed }
  }
  let result
  try {
    result = await runProbe('codex', ['login', 'status'], { env: probeEnvironment(env), timeoutMs })
  } catch (error) {
    if (error.code === 'ENOENT') return { live: 'missing' }
    throw new EligibilityError(`codex eligibility is unknown: \`codex login status\` ${probeFailure(error)}`)
  }
  const parsed = parseCodexSignIn(`${result.stderr}\n${result.stdout}`)
  if (parsed === null) throw new EligibilityError('codex eligibility is unknown: `codex login status` gave no answer Poise can read')
  return { live: parsed }
}

function probeFailure(error) {
  if (error.code === 'PROBE_TIMEOUT') return `did not answer within ${ELIGIBILITY_PROBE_TIMEOUT_MS / 1000} seconds`
  if (error.code === 'PROBE_OUTPUT_LIMIT') return `printed more than ${PROBE_OUTPUT_BYTES / 1024} KiB`
  if (typeof error.code === 'number') return `exited with code ${error.code}`
  return `could not run (${error instanceof Error ? error.message : String(error)})`
}

/** The one eligibility rule. `logins` is the durable record, `live` the
 *  verified sign-in per live provider (true/false) or 'missing' for a CLI
 *  that is not installed; anything else is unknown and fails. `record`
 *  persists a positive observation for the caller that owns the database. */
export function decideEligibility(logins, live, record = () => {}) {
  const eligible = []
  const skipped = {}
  for (const provider of PROVIDERS) {
    if (typeof logins[provider] === 'string' && logins[provider] !== '') {
      eligible.push(provider)
      continue
    }
    if (!LIVE_PROVIDERS.includes(provider)) {
      skipped[provider] = SKIP_REASON
      continue
    }
    const observed = live[provider]
    if (observed === true) {
      record(provider)
      eligible.push(provider)
    } else if (observed === false || observed === 'missing') {
      skipped[provider] = SKIP_REASON
    } else if (typeof observed === 'string' && observed !== '') {
      throw new EligibilityError(`${provider} eligibility is unknown: ${observed}`)
    } else {
      throw new EligibilityError(`${provider} eligibility is unknown: no configuration record and no verified sign-in`)
    }
  }
  return { eligible, skipped }
}

/** Evidence the server forwards from its own account observation, so the
 *  refresh it starts does not probe the CLIs again. */
export function parseEvidence(raw) {
  let value
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new EligibilityError(`POISE_PROVIDER_EVIDENCE is not JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const problem = 'POISE_PROVIDER_EVIDENCE must be { logins: { <provider>: <iso> }, live: { claude: true | false | \'missing\' | null, codex: true | false | \'missing\' | null } }'
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new EligibilityError(problem)
  const { logins, live } = value
  if (!logins || typeof logins !== 'object' || Array.isArray(logins)
    || Object.values(logins).some(at => typeof at !== 'string')) throw new EligibilityError(problem)
  if (!live || typeof live !== 'object' || Array.isArray(live)
    || !LIVE_PROVIDERS.every(provider => live[provider] === true || live[provider] === false || live[provider] === 'missing' || live[provider] === null)) {
    throw new EligibilityError(problem)
  }
  return { logins, live }
}

function evidenceDetail(provider, liveValue, logins) {
  if (logins[provider]) return null
  if (liveValue === true || liveValue === false) return null
  return 'no configuration record, and the server observation could not verify a sign-in'
}

/** Eligibility for this run: the server's forwarded evidence when present,
 *  otherwise the same database and, for unrecorded Claude/Codex, the same
 *  status commands the server probes with. */
export async function resolveEligibility(env = process.env) {
  const forwarded = env.POISE_PROVIDER_EVIDENCE
  if (forwarded !== undefined && forwarded !== '') {
    const { logins, live } = parseEvidence(forwarded)
    return {
      ...decideEligibility(logins, {
        claude: live.claude === null ? evidenceDetail('claude', null, logins) : live.claude,
        codex: live.codex === null ? evidenceDetail('codex', null, logins) : live.codex,
      }),
      source: 'evidence',
    }
  }
  const dbPath = participationDbPath(env)
  const logins = readAccountLogins(dbPath)
  const live = {}
  await Promise.all(LIVE_PROVIDERS.filter(provider => !logins[provider]).map(async (provider) => {
    live[provider] = (await probeLive(provider, env)).live
  }))
  return { ...decideEligibility(logins, live, provider => recordObservedParticipation(dbPath, provider)), source: 'standalone' }
}

export function sameEligibility(priorEligible, eligible) {
  const prior = Array.isArray(priorEligible) ? [...priorEligible] : [...PROVIDERS]
  return prior.length === eligible.length && prior.every(provider => eligible.includes(provider))
}
