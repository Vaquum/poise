// Each CLI's sign-in state, read from its own non-interactive status command
// and nothing else: no credential file is ever opened. Only the account name
// a status command prints leaves this module, never a token or key.

import { CLAUDE_SUBSCRIPTION_CLI, claudeSubscriptionEnvironment, type RunFileOptions, type RunFileResult } from '../process'
import { claudeSubscriptionReady, sanitizeSubscriptionType } from '../claude-auth'
import { ACCOUNT_CLIS, GH_STORED_ACCOUNTS_ENV, type AccountCli } from './clis'
import { ACCOUNT_IDS, type AccountId, type ConnectedAccount, type GhAccount } from './types'

export type RunCommand = (command: string, args: readonly string[], options?: RunFileOptions) => Promise<RunFileResult>

const PROBE_TIMEOUT_MS = 10_000
const PROBE_OUTPUT_BYTES = 64 * 1024
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/
const VERSION = /\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g
const CONTROL = /[\u0000-\u001f\u007f]/

interface SignIn {
  signedIn: boolean | null
  identity: string | null
  detail: string | null
  accounts?: GhAccount[]
}

const unknown = (detail: string): SignIn => ({ signedIn: null, identity: null, detail })

// Overrides for every command a probe runs. gh reads its stored accounts, not
// a token from the environment; the muse launcher updates itself when it
// starts, and a status read must not.
const PROBE_ENV: Partial<Record<AccountId, NodeJS.ProcessEnv>> = {
  gh: GH_STORED_ACCOUNTS_ENV,
  muse: { MUSE_NO_AUTO_UPDATE: '1' },
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function options(env: NodeJS.ProcessEnv = {}): RunFileOptions {
  return { env, timeoutMs: PROBE_TIMEOUT_MS, maxOutputBytes: PROBE_OUTPUT_BYTES }
}

function text(value: unknown): string {
  if (typeof value === 'string') return value
  return Buffer.isBuffer(value) ? value.toString('utf8') : ''
}

/** One line of a CLI's own message, short and printable. */
function line(value: string): string {
  const first = value.replace(ANSI, '').split(/\r?\n/).map((part) => part.trim()).find(Boolean) ?? ''
  const printable = [...first].filter((char) => !CONTROL.test(char)).join('')
  return printable.length > 200 ? `${printable.slice(0, 199)}…` : printable
}

/** A command that ran and exited non-zero: the status commands that answer
 *  "signed out" that way still printed their answer. */
function exitedNonZero(error: unknown): error is { code: number, stdout?: unknown, stderr?: unknown } {
  return isRecord(error) && typeof error.code === 'number' && error.killed !== true
}

/** Why a command failed, in words, with the first line of its stderr. */
function failure(command: string, error: unknown): string {
  const record = isRecord(error) ? error : {}
  const timedOut = record.killed === true ? /^Command timed out after (\d+)ms/.exec(String(record.message)) : null
  let reason: string
  if (record.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') reason = `printed more than ${PROBE_OUTPUT_BYTES / 1024} KiB`
  else if (timedOut) reason = `did not answer within ${Number(timedOut[1]) / 1000} seconds`
  else if (typeof record.code === 'number') reason = `exited with code ${record.code}`
  else if (typeof record.signal === 'string') reason = `was stopped by ${record.signal}`
  else reason = `could not run (${error instanceof Error ? error.message : String(error)})`
  const said = line(text(record.stderr))
  return `\`${command}\` ${reason}${said ? `: ${said}` : ''}`
}

function versionOf(output: string): string | null {
  return VERSION.exec(output.replace(ANSI, ''))?.[0] ?? null
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

/** `claude auth status --json`, through Poise's wrapper. */
function parseClaudeStatus(stdout: string): SignIn | null {
  let value: unknown
  try { value = JSON.parse(stdout) } catch { return null }
  if (!isRecord(value) || typeof value.loggedIn !== 'boolean') return null
  if (claudeSubscriptionReady(value)) {
    const plan = sanitizeSubscriptionType(value.subscriptionType)
    const email = typeof value.email === 'string' && value.email.length <= 254 && !CONTROL.test(value.email) ? value.email : null
    return { signedIn: true, identity: email, detail: plan ? `Claude ${capitalize(plan)} subscription` : 'Claude subscription' }
  }
  if (value.loggedIn) {
    return {
      signedIn: false,
      identity: null,
      detail: 'Claude Code is signed in, but not to a Claude subscription. Poise runs Claude only on a subscription; reconnect with your Claude account.',
    }
  }
  return { signedIn: false, identity: null, detail: null }
}

/** `codex login status`, which answers on stderr. Codex prints no account
 *  name; an API key it shows masked is never repeated. */
function parseCodexStatus(output: string): SignIn | null {
  if (/^Logged in using ChatGPT\b/m.test(output)) return { signedIn: true, identity: null, detail: 'Signed in with ChatGPT' }
  if (/^Logged in using an API key\b/m.test(output)) return { signedIn: true, identity: null, detail: 'Signed in with an OpenAI API key' }
  if (/^Not logged in\b/m.test(output)) return { signedIn: false, identity: null, detail: null }
  return null
}

/** `gh auth status --json hosts --hostname github.com`: every account gh
 *  holds for github.com and which one is active. */
function parseGhStatus(stdout: string): SignIn | null {
  let value: unknown
  try { value = JSON.parse(stdout) } catch { return null }
  if (!isRecord(value) || !isRecord(value.hosts)) return null
  const entries = value.hosts['github.com'] ?? []
  if (!Array.isArray(entries)) return null
  const accounts: GhAccount[] = []
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.login !== 'string' || !GITHUB_LOGIN.test(entry.login)) return null
    const signedIn = entry.state === 'success'
    const problem = typeof entry.error === 'string' && line(entry.error) ? line(entry.error) : `gh reports its state as ${line(String(entry.state)) || 'unknown'}`
    accounts.push({ login: entry.login, active: entry.active === true, signedIn, detail: signedIn ? null : problem })
  }
  const failing = accounts.filter((account) => !account.signedIn).map((account) => account.login)
  return {
    signedIn: accounts.some((account) => account.signedIn),
    identity: accounts.find((account) => account.active && account.signedIn)?.login ?? null,
    detail: failing.length ? `gh cannot use ${failing.join(', ')}; reconnect ${failing.length === 1 ? 'that account' : 'those accounts'}.` : null,
    accounts,
  }
}

async function claudeSignIn(run: RunCommand): Promise<SignIn> {
  let stdout: string
  try {
    stdout = (await run(CLAUDE_SUBSCRIPTION_CLI, ['auth', 'status', '--json'], options(claudeSubscriptionEnvironment()))).stdout
  } catch (error) {
    // Signed out, it still answers on stdout and exits 1.
    if (!exitedNonZero(error) || !text(error.stdout).trim()) return unknown(failure('claude auth status', error))
    stdout = text(error.stdout)
  }
  return parseClaudeStatus(stdout) ?? unknown('`claude auth status` gave no answer Poise can read.')
}

async function codexSignIn(run: RunCommand): Promise<SignIn> {
  let output: string
  try {
    const result = await run('codex', ['login', 'status'], options())
    output = `${result.stderr}\n${result.stdout}`
  } catch (error) {
    // Signed out, it says so and exits 1.
    if (!exitedNonZero(error)) return unknown(failure('codex login status', error))
    output = `${text(error.stderr)}\n${text(error.stdout)}`
  }
  return parseCodexStatus(output) ?? unknown('`codex login status` gave no answer Poise can read.')
}

async function ghSignIn(run: RunCommand): Promise<SignIn> {
  let stdout: string
  try {
    // With --json, gh exits 0 whatever the accounts' state; anything else failed.
    stdout = (await run('gh', ['auth', 'status', '--json', 'hosts', '--hostname', 'github.com'], options(PROBE_ENV.gh))).stdout
  } catch (error) {
    return unknown(failure('gh auth status', error))
  }
  return parseGhStatus(stdout) ?? unknown('`gh auth status` gave no answer Poise can read.')
}

function unreported(name: string, more = ''): () => Promise<SignIn> {
  return async () => unknown(`${name}'s CLI has no command that reports whether it is signed in.${more}`)
}

const SIGN_IN: Record<AccountId, (run: RunCommand) => Promise<SignIn>> = {
  claude: claudeSignIn,
  codex: codexSignIn,
  gh: ghSignIn,
  grok: unreported('Grok'),
  muse: unreported('Muse'),
  antigravity: unreported('Antigravity', ' It shows its sign-in screen when it starts signed out.'),
}


async function probe(cli: AccountCli, run: RunCommand): Promise<ConnectedAccount> {
  const known = { id: cli.id, login: { label: cli.login.label } }
  let version: string
  try {
    version = (await run(cli.command, ['--version'], options(PROBE_ENV[cli.id]))).stdout
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') {
      return { ...known, installed: false, version: null, signedIn: null, identity: null, detail: `${cli.command} is not installed: Poise cannot find it on its PATH.` }
    }
    return { ...known, installed: true, version: null, ...unknown(failure(`${cli.command} --version`, error)) }
  }
  return { ...known, installed: true, version: versionOf(version), ...await SIGN_IN[cli.id](run) }
}

/** Every CLI at once, each bounded by PROBE_TIMEOUT_MS per command. */
export function probeAccounts(run: RunCommand): Promise<ConnectedAccount[]> {
  return Promise.all(ACCOUNT_IDS.map((id) => probe(ACCOUNT_CLIS[id], run)))
}
