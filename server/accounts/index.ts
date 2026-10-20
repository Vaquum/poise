// GET /api/accounts: Settings → Connected accounts. Answers are kept briefly
// so opening Settings twice does not run six CLIs twice; a terminal exiting
// drops them, since a login may have just changed one.

import { runFile } from '../process'
import { probeAccount } from './status'
import { accountLogins } from './logins'
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
  return result.map(account => {
    const recorded = { ...account, signInRecordedAt: logins[account.id] }
    return hasRecordedSignIn(recorded) ? recorded : account
  })
}

export function invalidateAccounts(): void {
  for (const cache of accounts.values()) cache.invalidate()
}
