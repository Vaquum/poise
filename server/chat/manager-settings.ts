import { db, getMeta, setMeta } from '../db'
import { HttpError } from '../http'
import { diagnostic } from '../logging'
import { readSwitch } from '../snippet-library'
import { WAKE_OPTIONS, parseManagerWake, type ManagerWake, type WakeMinutes } from '../../src/chat-manager-settings-types'
import { MANAGER_SWITCH } from '../../src/chat-switches'

const KEY = 'chat_manager_wake'
const FAILURE_KEY = 'chat_manager_wake_failure'
const ARMED_PREFIX = 'chat_manager_wake_armed:'

export const DEFAULT_MANAGER_WAKE: ManagerWake = { everyMinutes: 60, revision: 0 }

/** The saved wake interval, or the 60-minute default when unset. An
 *  unreadable value is a 500: only a repair save replaces it. */
export function readWake(): ManagerWake {
  const raw = getMeta(KEY)
  if (!raw) return { ...DEFAULT_MANAGER_WAKE }
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new HttpError(500, 'The Manager wake interval could not be read. Choose an interval to replace it.') }
  const data = parseManagerWake(value)
  if (!data) throw new HttpError(500, 'The Manager wake interval could not be read. Choose an interval to replace it.')
  return data
}

function validWakeInput(input: unknown): { everyMinutes: WakeMinutes, revision: number } {
  const data = input as { everyMinutes?: unknown, revision?: unknown } | null
  const everyMinutes = data && typeof data === 'object' ? data.everyMinutes : undefined
  if (!(WAKE_OPTIONS as readonly unknown[]).includes(everyMinutes)) throw new HttpError(400, 'everyMinutes must be 5, 10, 15, 30 or 60')
  const revision = (data as { revision?: unknown }).revision
  if (!Number.isSafeInteger(revision) || (revision as number) < 0) throw new HttpError(400, 'revision must be a non-negative integer')
  return { everyMinutes: everyMinutes as WakeMinutes, revision: revision as number }
}

/** Compare-and-swap on the revision, in one transaction. An identical save
 *  returns the value unchanged, with no bump and no diagnostic; revision 0
 *  repairs an unreadable value. Retrying a completed save is harmless. */
export const saveWake = db.transaction((input: unknown): { wake: ManagerWake, changed: boolean, recovered: boolean } => {
  const next = validWakeInput(input)
  let current: ManagerWake | null = null
  let unreadable = false
  try {
    current = readWake()
  } catch (error) {
    if (!(error instanceof HttpError) || error.statusCode !== 500) throw error
    unreadable = true
  }
  if (unreadable || !current) {
    if (next.revision !== 0) throw new HttpError(500, 'The Manager wake interval could not be read. Choose an interval to replace it.')
    const wake = { everyMinutes: next.everyMinutes, revision: 1 }
    setMeta(KEY, JSON.stringify(wake))
    diagnostic({ level: 'warning', operation: 'chat.manager.wake.saved', message: 'The Manager wake interval was repaired',
      context: { everyMinutes: wake.everyMinutes, revision: wake.revision, recovered: true } })
    return { wake, changed: true, recovered: true }
  }
  if (current.everyMinutes === next.everyMinutes) return { wake: current, changed: false, recovered: false }
  if (next.revision !== current.revision) throw new HttpError(409, 'The wake interval changed in another tab. Your choice has not replaced it.')
  const wake = { everyMinutes: next.everyMinutes, revision: current.revision + 1 }
  setMeta(KEY, JSON.stringify(wake))
  diagnostic({ level: 'warning', operation: 'chat.manager.wake.saved', message: 'The Manager wake interval changed',
    context: { everyMinutes: wake.everyMinutes, revision: wake.revision } })
  return { wake, changed: true, recovered: false }
})

/** The latest failed wake turn, or null. A wake turn that succeeds clears it. */
export function readWakeFailure(): { at: string, error: string } | null {
  const raw = getMeta(FAILURE_KEY)
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as { at?: unknown, error?: unknown }
    return typeof value.at === 'string' && typeof value.error === 'string' && value.at && value.error
      ? { at: value.at, error: value.error } : null
  } catch { return null }
}

export function recordWakeFailure(at: string, error: string): void {
  setMeta(FAILURE_KEY, JSON.stringify({ at, error }))
}

export function clearWakeFailure(): void {
  db.prepare('DELETE FROM meta WHERE key = ?').run(FAILURE_KEY)
}

/** Whether the instance's wake lifecycle is armed: the person created its
 *  Manager through the New session dialog, or one pre-existed at boot. The
 *  sync keeps a wake timer only while armed, and re-creates a `/manager`
 *  removed outside Poise (Snippets refuses removals) only once armed; it
 *  never starts the lifecycle from a bare manager and charter alone. */
export function wakeArmed(instance: string): boolean {
  return getMeta(ARMED_PREFIX + instance) === '1'
}

export function markWakeArmed(instance: string): void {
  setMeta(ARMED_PREFIX + instance, '1')
}

// Upgrade arming, once at import: a Manager with a charter that pre-existed
// this process arms like a fresh creation. Managers the person creates
// later arm through POST instead and never need this; anything created any
// other way (direct runtime.create in tests) stays unarmed in this process.
// Should such a manager still exist with a charter at a later boot, arming
// it then is intended — the product has no wakeless-Manager state, and in
// production every Manager is POST-created and already armed.
try {
  const managers = db.prepare("SELECT DISTINCT instance FROM chat_sessions WHERE role = 'manager'").all() as Array<{ instance: string }>
  if (managers.length > 0) {
    let text: string | null = null
    try {
      text = readSwitch(MANAGER_SWITCH)?.content ?? null
    } catch { text = null }
    if (text && text.trim()) for (const manager of managers) setMeta(ARMED_PREFIX + manager.instance, '1')
  }
} catch { /* a missing table or unreadable library arms nothing */ }
