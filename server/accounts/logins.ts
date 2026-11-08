// Durable sign-in history shared by Accounts and first-run setup. No credentials.

import { db, getMeta, setMeta } from '../db'
import { isAccountId, UNREPORTED_SIGN_IN, type AccountId } from './types'

/** When each agent CLI's login last finished successfully in a Connect
 *  terminal, or the person said it had. Grok, Muse and Antigravity report no
 *  sign-in status, so this is how setup knows which of them were signed in here. */
export type AccountLogins = Partial<Record<AccountId, string>>

// Antigravity runs the whole app; a clean exit cannot establish sign-in.
const EXIT_IS_NO_LOGIN: ReadonlySet<string> = new Set(['antigravity'])
const LOGINS_KEY = 'account_logins'

interface ProviderSignInFailure {
  callId: string
  model: string
  since: number
  rejectedAt: number
  verifiedAt: number | null
  consumedAt: number | null
  reconnectedAt: number | null
  verificationLogin: string | null
}
const rejectionKey = (id: AccountId) => `account_runtime_rejection:${id}`

export function providerSignInFailure(id: AccountId): ProviderSignInFailure | null {
  const raw = getMeta(rejectionKey(id))
  if (!raw) return null
  const value = JSON.parse(raw) as ProviderSignInFailure
  if (!value || typeof value.callId !== 'string' || typeof value.model !== 'string'
    || !Number.isSafeInteger(value.since) || !Number.isSafeInteger(value.rejectedAt) || value.since > value.rejectedAt
    || ![value.verifiedAt, value.consumedAt, value.reconnectedAt].every(at => at === null || Number.isSafeInteger(at))
    || !(value.verificationLogin === null || typeof value.verificationLogin === 'string')) {
    throw new Error(`The ${id} runtime sign-in evidence is corrupt`)
  }
  return value
}

export function recordProviderRejection(id: AccountId, callId: string, model: string, rejectedAt: number): void {
  if (!Number.isSafeInteger(rejectedAt)) throw new Error('Provider rejection has no completion time')
  db.transaction(() => {
    const previous = providerSignInFailure(id)
    if (previous && previous.rejectedAt >= rejectedAt) return
    const recovered = previous?.verifiedAt != null && previous.verifiedAt > previous.rejectedAt
    // A Connect that finished after the call completed but before this record
    // must keep its eligibility: carry a fresh reconnect forward instead of
    // resetting it to null.
    let reconnectedAt: number | null = null
    const prevReconnect = previous?.reconnectedAt
    if (typeof prevReconnect === 'number' && prevReconnect > rejectedAt) reconnectedAt = prevReconnect
    else {
      const loginAt = accountLogins()[id]
      const loginMs = typeof loginAt === 'string' ? Date.parse(loginAt) : NaN
      if (Number.isSafeInteger(loginMs) && loginMs > rejectedAt) reconnectedAt = loginMs
    }
    setMeta(rejectionKey(id), JSON.stringify({ callId, model, rejectedAt,
      since: !previous || recovered ? rejectedAt : previous.since,
      verifiedAt: null, consumedAt: null, reconnectedAt, verificationLogin: null } satisfies ProviderSignInFailure))
  }).immediate()
}

/** Reserve the one native verification allowed by a fresh completed Connect.
 *  Status polling alone never spends model requests or proves recovery. */
export function claimProviderVerification(id: AccountId): ProviderSignInFailure | null {
  return db.transaction(() => {
    const failure = providerSignInFailure(id)
    const login = failure?.reconnectedAt?.toString()
    if (!failure || failure.verifiedAt !== null || !login || Number(login) <= failure.rejectedAt
      || failure.verificationLogin === login) return null
    setMeta(rejectionKey(id), JSON.stringify({ ...failure, verificationLogin: login }))
    return failure
  }).immediate()
}

/** Called only for successful native requests on the review's credential route. */
export function recordProviderRecovery(id: AccountId, callId: string, startedAt: number): void {
  db.transaction(() => {
    const failure = providerSignInFailure(id)
    if (!failure || failure.callId !== callId || startedAt <= failure.rejectedAt || failure.verifiedAt !== null) return
    setMeta(rejectionKey(id), JSON.stringify({ ...failure, verifiedAt: startedAt }))
  }).immediate()
}

export function providerRecoveryAvailable(id: AccountId): boolean {
  const failure = providerSignInFailure(id)
  return !!failure && failure.verifiedAt !== null && failure.verifiedAt > failure.rejectedAt && failure.consumedAt === null
}

export function consumeProviderRecovery(id: AccountId): boolean {
  return db.transaction(() => {
    if (!providerRecoveryAvailable(id)) return false
    const failure = providerSignInFailure(id)!
    setMeta(rejectionKey(id), JSON.stringify({ ...failure, consumedAt: Date.now() }))
    return true
  }).immediate()
}

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

/** The record for participation decisions, which fail closed: a corrupt
 *  value throws instead of reading as never configured. Displayed history
 *  keeps the lenient read above. */
export function accountLoginsStrict(): AccountLogins {
  const raw = getMeta(LOGINS_KEY)
  if (!raw) return {}
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new Error(`The provider record is corrupt: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The provider record is corrupt')
  return Object.fromEntries(Object.entries(value).filter(([id, at]) => isAccountId(id) && typeof at === 'string')) as AccountLogins
}

/** A live status positively verified a Claude/Codex sign-in, including one
 *  made outside Poise. Remembered once: history proves configuration, and a
 *  later lost sign-in must read as a failure, not as never configured. A
 *  corrupt record throws, so callers never overwrite it with a partial one. */
export function recordObservedSignIn(id: AccountId): void {
  if (id !== 'claude' && id !== 'codex') return
  const logins = accountLoginsStrict()
  if (logins[id]) return
  setMeta(LOGINS_KEY, JSON.stringify({ ...logins, [id]: new Date().toISOString() }))
}

/** A Connect terminal's login exited with `code`; a clean exit is a finished
 *  login, except where the terminal runs a whole app rather than a login.
 *  Storing a Muse API key counts as its login. */
export function recordLogin(preset: string, code: number): void {
  const id = preset === 'muse-api-key' ? 'muse' : preset
  if (code !== 0 || !isAccountId(id) || EXIT_IS_NO_LOGIN.has(id)) return
  const completedAt = Date.now()
  setMeta(LOGINS_KEY, JSON.stringify({ ...accountLogins(), [id]: new Date(completedAt).toISOString() }))
  const failure = providerSignInFailure(id)
  if (failure && completedAt > failure.rejectedAt) {
    setMeta(rejectionKey(id), JSON.stringify({ ...failure, reconnectedAt: completedAt }))
  }
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

