// GET /api/accounts: Settings → Connected accounts. Answers are kept briefly
// so opening Settings twice does not run six CLIs twice; a terminal exiting
// drops them, since a login may have just changed one.

import { runFile } from '../process'
import { probeAccounts } from './status'
import type { ConnectedAccount } from './types'

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

const accounts = new AccountsCache(() => probeAccounts(runFile))

export function listAccounts(): Promise<ConnectedAccount[]> {
  return accounts.list()
}

export function invalidateAccounts(): void {
  accounts.invalidate()
}
