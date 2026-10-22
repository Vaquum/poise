// Durable sign-in history shared by Accounts and first-run setup. No credentials.

import { getMeta, setMeta } from '../db'
import { isAccountId, UNREPORTED_SIGN_IN, type AccountId } from './types'

/** When each agent CLI's login last finished successfully in a Connect
 *  terminal, or the person said it had. Grok, Muse and Antigravity report no
 *  sign-in status, so this is how setup knows which of them were signed in here. */
export type AccountLogins = Partial<Record<AccountId, string>>

// Antigravity runs the whole app; a clean exit cannot establish sign-in.
const EXIT_IS_NO_LOGIN: ReadonlySet<string> = new Set(['antigravity'])
const LOGINS_KEY = 'account_logins'

export function accountLogins(): AccountLogins {
  const raw = getMeta(LOGINS_KEY)
  if (!raw) return {}
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    return Object.fromEntries(Object.entries(value).filter(([id, at]) => isAccountId(id) && typeof at === 'string')) as AccountLogins
  } catch {
    return {}
  }
}

/** A Connect terminal's login exited with `code`; a clean exit is a finished
 *  login, except where the terminal runs a whole app rather than a login.
 *  Storing a Muse API key counts as its login. */
export function recordLogin(preset: string, code: number): void {
  const id = preset === 'muse-api-key' ? 'muse' : preset
  if (code !== 0 || !isAccountId(id) || EXIT_IS_NO_LOGIN.has(id)) return
  setMeta(LOGINS_KEY, JSON.stringify({ ...accountLogins(), [id]: new Date().toISOString() }))
}

/** The person says whether a CLI that reports no sign-in is signed in. */
export function markLogin(account: unknown, signedIn: unknown): void {
  if (typeof account !== 'string' || !(UNREPORTED_SIGN_IN as readonly string[]).includes(account)) {
    throw new Error(`account must be one of ${UNREPORTED_SIGN_IN.join(', ')}: the others report their own sign-in`)
  }
  if (typeof signedIn !== 'boolean') throw new Error('signedIn must be true or false')
  const logins: AccountLogins = { ...accountLogins() }
  if (signedIn) logins[account as AccountId] = new Date().toISOString()
  else delete logins[account as AccountId]
  setMeta(LOGINS_KEY, JSON.stringify(logins))
}

