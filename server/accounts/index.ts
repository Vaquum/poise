// GET /api/accounts: Settings → Connected accounts. Answers are kept briefly
// so opening Settings twice does not run six CLIs twice; a terminal exiting
// drops them, since a login may have just changed one.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runFile } from '../process'
import { agentInterfaceCwd, loadCatalog } from '../models'
import { codexVerificationDetail, providerSignInVerificationFailed, type CodexVerificationReason } from '../alerts/producers'
import { probeAccount } from './status'
import { accountLogins, claimProviderVerification, recordObservedSignIn, recordProviderRecovery, releaseProviderVerification } from './logins'
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

function classifyCodexVerificationFailure(error: unknown): CodexVerificationReason {
  const output = error as { stdout?: string, stderr?: string, message?: string }
  const haystack = [output.stderr, output.stdout,
    typeof output.message === 'string' ? output.message : (error instanceof Error ? error.message : String(error)),
  ].filter((part): part is string => typeof part === 'string').join('\n')
  if (haystack.includes('unavailable to the next Caller worker')) return 'credentials_unavailable'
  if (/401|unauthorized|missing Authorization|not signed in|not logged in|invalid_grant|refresh_token|authentication[_ ](?:failed|error)|already used|rejected.*(login|credential|auth)|(login|credential).*rejected/i.test(haystack)) {
    return 'authentication_failed'
  }
  return 'verification_incomplete'
}

async function verifyCodexRecovery(): Promise<void> {
  const failure = claimProviderVerification('codex')
  if (!failure) return
  // The claim reserves this reconnect; a failed or timed-out verification
  // must release it so a later Connect can be recorded and verified anew.
  const login = failure.reconnectedAt?.toString() ?? null
  let work: string | undefined
  try {
    const model = (await loadCatalog()).models.find(model => model.identity === failure.model && model.provider === 'codex')
    if (!model) throw new Error('The rejected Codex model is absent from the catalog')
    work = await mkdtemp(join(tmpdir(), 'poise-codex-verification-'))
    // Caller owns the worker credential home and tool-free request options.
    // The probe owns its diagnostics: provider output never reaches Logging.
    const { stdout } = await runFile('agent-interface', ['--verify-codex-login', model.identity, '--pwd', work], {
      cwd: agentInterfaceCwd(), timeoutMs: 30_000, maxOutputBytes: 64 * 1024, reportFailure: false,
      env: { CODEX_HOME: process.env.CODEX_HOME, OPENAI_API_KEY: undefined, CODEX_API_KEY: undefined, OPENAI_BASE_URL: undefined },
    })
    const events = stdout.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    if (events.some(event => ['error', 'turn.failed'].includes(String(event.type)))
      || events.filter(event => event.type === 'turn.completed').length !== 1
      || events.some(event => event.item && (typeof event.item !== 'object' || !('type' in event.item)
        || !['agent_message', 'reasoning', 'todo_list', 'error'].includes(String(event.item.type))))
      || !events.some(event => event.type === 'item.completed' && event.item && typeof event.item === 'object'
        && 'type' in event.item && event.item.type === 'agent_message' && 'text' in event.item && event.item.text === 'OK')) {
      throw Object.assign(new Error('Codex did not complete the native sign-in verification'), { stdout })
    }
    // Record completion, not request start: a second Connect during verification
    // must still read as older than the verification it did not cause.
    recordProviderRecovery('codex', failure.callId, Date.now())
  } catch (error) {
    // Never publish provider text: opaque auth.json values survive redaction.
    const reason = classifyCodexVerificationFailure(error)
    console.error('[accounts] native Codex sign-in verification failed:', codexVerificationDetail(reason))
    providerSignInVerificationFailed('codex', failure.callId, reason)
    releaseProviderVerification('codex', login)
  } finally {
    if (work) await rm(work, { recursive: true, force: true })
  }
}

export function invalidateAccounts(): void {
  for (const cache of accounts.values()) cache.invalidate()
}
