// GET /api/accounts: Settings → Connected accounts. Answers are kept briefly
// so opening Settings twice does not run six CLIs twice; a terminal exiting
// drops them, since a login may have just changed one.

import { homedir } from 'node:os'
import { runFile } from '../process'
import { loadCatalog } from '../models'
import { environmentSecrets, redact } from '../../gateway/src/diagnostics/redaction.mjs'
import { probeAccount } from './status'
import { accountLogins, claimProviderVerification, recordObservedSignIn, recordProviderRecovery } from './logins'
import { ACCOUNT_IDS, hasRecordedSignIn, type AccountId, type ConnectedAccount } from './types'

export const ACCOUNTS_CACHE_MS = 15_000

export class AccountsCache {
  private entry: { promise: Promise<ConnectedAccount[]>, settledAt: number | null } | null = null

  constructor(
    private readonly probe: () => Promise<ConnectedAccount[]>,
    private readonly now: () => number = Date.now,
  ) {}

  /** The last answer while it is fresh, the one being read, or a new read. */
  list(): Promise<ConnectedAccount[]> {
    const current = this.entry
    if (current && (current.settledAt === null || this.now() - current.settledAt < ACCOUNTS_CACHE_MS)) return current.promise
    const entry: { promise: Promise<ConnectedAccount[]>, settledAt: number | null } = { promise: this.probe(), settledAt: null }
    this.entry = entry
    entry.promise.then(
      () => { if (this.entry === entry) entry.settledAt = this.now() },
      () => { if (this.entry === entry) this.entry = null },
    )
    return entry.promise
  }

  /** Forget every answer, including one still being read. */
  invalidate(): void {
    this.entry = null
  }
}

/** In service mode Poise also reads the accounts on its own this often, so a
 *  sign-in that lapses is alerted while the browser is closed. */
export const ACCOUNTS_CHECK_MS = 15 * 60_000

/** Runs `check` every `intervalMs`, never at once, until the returned stop is
 *  called. A failed check is logged and the next one runs as planned. */
export function scheduleAccountsCheck(check: () => Promise<unknown>, intervalMs = ACCOUNTS_CHECK_MS): () => void {
  const timer = setInterval(() => {
    void check().catch((error: unknown) => console.error('[accounts] the scheduled check failed:', error))
  }, intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}

const accounts = new Map(ACCOUNT_IDS.map(id => [id, new AccountsCache(async () => [await probeAccount(id, runFile)])]))

export async function listAccounts(id?: AccountId): Promise<ConnectedAccount[]> {
  const result = id ? await accounts.get(id)!.list() : (await Promise.all(ACCOUNT_IDS.map(id => accounts.get(id)!.list()))).flat()
  // Join after the cached probe settles: setup edits must be visible at once,
  // including when a probe was already pending before a confirmation was removed.
  const logins = accountLogins()
  try {
    for (const account of result) {
      if ((account.id === 'claude' || account.id === 'codex') && account.signedIn === true && !logins[account.id]) {
        recordObservedSignIn(account.id)
      }
    }
  } catch (error) {
    console.error('[accounts] could not record an observed sign-in:', error)
  }
  if (result.some(account => account.id === 'codex' && account.installed && account.signedIn === true)) await verifyCodexRecovery()
  return result.map(account => {
    const recorded = { ...account, signInRecordedAt: logins[account.id] }
    return hasRecordedSignIn(recorded) ? recorded : account
  })
}

async function verifyCodexRecovery(): Promise<void> {
  const failure = claimProviderVerification('codex')
  if (!failure) return
  try {
    const model = (await loadCatalog()).models.find(model => model.identity === failure.model && model.provider === 'codex')
    if (!model) throw new Error('The rejected Codex model is absent from the catalog')
    const startedAt = Date.now()
    // Match issue review's ChatGPT route, ignoring configuration and API-key
    // overrides. A login status response is not a successful provider request.
    const { stdout } = await runFile(process.env.CODEX_CLI || 'codex', ['exec', '--ignore-user-config', '--ignore-rules',
      '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--model', model.selector,
      '-c', 'approval_policy="never"', '-c', 'forced_login_method="chatgpt"', '-c', 'web_search="disabled"',
      '--disable', 'shell_tool', '--disable', 'unified_exec', '--disable', 'multi_agent',
      '--json', 'Reply with exactly OK. Do not use tools.'], {
      cwd: homedir(), timeoutMs: 30_000, maxOutputBytes: 64 * 1024,
      env: { CODEX_HOME: process.env.CODEX_HOME, OPENAI_API_KEY: undefined, CODEX_API_KEY: undefined, OPENAI_BASE_URL: undefined },
    })
    const events = stdout.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    if (events.some(event => ['error', 'turn.failed'].includes(String(event.type)))
      || !events.some(event => event.type === 'turn.completed')
      || !events.some(event => event.type === 'item.completed' && event.item && typeof event.item === 'object'
        && 'type' in event.item && event.item.type === 'agent_message' && 'text' in event.item && event.item.text === 'OK')) {
      throw new Error('Codex did not complete the native sign-in verification')
    }
    recordProviderRecovery('codex', failure.callId, startedAt)
  } catch (error) {
    console.error('[accounts] native Codex sign-in verification failed:', redact(String(error), environmentSecrets()))
  }
}

export function invalidateAccounts(): void {
  for (const cache of accounts.values()) cache.invalidate()
}
