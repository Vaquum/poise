// The Settings save round trip, without the panel: which drafts changed, the
// smallest partial update that carries them, and what to say when another
// tab got there first. DOM-free so the unit suite covers it; src/settings.ts
// wires it to the panel and the baselines a save carries.

// What the server applies when nothing is stored; shown so an empty field
// never reads as "no prefix" or "never times out".
export const CHAT_DEFAULTS = { branchPrefix: 'chat/', idleTimeoutMinutes: 120, maxConcurrentLocalTurns: 4, updateTurnBoundMinutes: 15 }

// GitHub logins and organization names are 1–39 characters of alphanumerics
// and single hyphens, not starting or ending with one. Both fields were stored
// with nothing but .trim(), so a pasted URL or a typo saved cleanly and every
// downstream query silently returned nothing.
export const GITHUB_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/

export type GeneralField = 'me' | 'agentAccount' | 'timezone' | 'branchPrefix' | 'idleTimeoutMinutes' | 'maxConcurrentLocalTurns' | 'updateTurnBoundMinutes'
export type GeneralTopField = 'me' | 'agentAccount' | 'timezone' | 'chat'

export interface GeneralDraft {
  me: string
  agentAccount: string
  timezone: string
  branchPrefix: string
  idleTimeoutMinutes: number
  maxConcurrentLocalTurns: number
  updateTurnBoundMinutes: number
}

export interface DraftProblem { message: string, field: GeneralField }

// Only drafts are validated: an untouched field cannot block the save, even
// when what it shows would not validate today.
export function validateGeneralDraft(draft: GeneralDraft, stored: { me: string, agentAccount: string }, dirty: ReadonlySet<GeneralField>): DraftProblem | null {
  if (dirty.has('me')) {
    if (!draft.me) return { message: 'Your GitHub account is required.', field: 'me' }
    // A value identical to the stored one is grandfathered past the
    // consecutive-hyphen check, mirroring the server: refusing a stored value
    // would refuse every save on installs that stored one while permissive.
    if (!GITHUB_NAME.test(draft.me) || (draft.me.includes('--') && draft.me !== stored.me)) {
      return { message: 'Your GitHub account must be a GitHub login, not a URL or email.', field: 'me' }
    }
  }
  if (dirty.has('agentAccount') && draft.agentAccount && (!GITHUB_NAME.test(draft.agentAccount) || (draft.agentAccount.includes('--') && draft.agentAccount !== stored.agentAccount))) {
    return { message: 'The agent account must be a GitHub login, not a URL or email.', field: 'agentAccount' }
  }
  // A branch prefix is a git ref fragment: no spaces, no `..`, no leading
  // slash. A bad one would make every new session fail at branch creation.
  if (dirty.has('branchPrefix') && (!/^[A-Za-z0-9._\/-]+$/.test(draft.branchPrefix) || draft.branchPrefix.startsWith('/') || draft.branchPrefix.includes('..'))) {
    return { message: 'Branch prefix must be a valid git ref fragment, like chat/.', field: 'branchPrefix' }
  }
  // The backend and the runtime take 0 as no idle expiry
  // (validateChatSettings, armIdleTimer); the panel used to require at least
  // 1, so a stored 0 blocked every save.
  if (dirty.has('idleTimeoutMinutes') && (!Number.isInteger(draft.idleTimeoutMinutes) || draft.idleTimeoutMinutes < 0 || draft.idleTimeoutMinutes > 10080)) {
    return { message: 'Idle timeout must be a whole number of minutes between 0 and 10080.', field: 'idleTimeoutMinutes' }
  }
  if (dirty.has('maxConcurrentLocalTurns') && (!Number.isInteger(draft.maxConcurrentLocalTurns) || draft.maxConcurrentLocalTurns < 1 || draft.maxConcurrentLocalTurns > 64)) {
    return { message: 'Concurrent local turns must be a whole number between 1 and 64.', field: 'maxConcurrentLocalTurns' }
  }
  if (dirty.has('updateTurnBoundMinutes') && (!Number.isInteger(draft.updateTurnBoundMinutes) || draft.updateTurnBoundMinutes < 1 || draft.updateTurnBoundMinutes > 10080)) {
    return { message: 'Update turn bound must be a whole number of minutes between 1 and 10080.', field: 'updateTurnBoundMinutes' }
  }
  return null
}

export interface GeneralPayload { body: Record<string, unknown>, expect: Record<string, unknown>, fields: GeneralTopField[] }

// The smallest supported partial update: only drafted fields, with the values
// this tab read for the fields it sends, so a stale draft is refused instead
// of overwriting another tab's save.
export function generalPayload(draft: GeneralDraft, dirty: ReadonlySet<GeneralField>, baselines: ReadonlyMap<string, unknown>): GeneralPayload | null {
  const body: Record<string, unknown> = {}
  const expect: Record<string, unknown> = {}
  const fields: GeneralTopField[] = []
  for (const key of ['me', 'agentAccount', 'timezone'] as const) {
    if (!dirty.has(key)) continue
    body[key] = draft[key]
    fields.push(key)
    if (baselines.has(key)) expect[key] = baselines.get(key)
  }
  const chat: Record<string, unknown> = {}
  for (const key of ['branchPrefix', 'idleTimeoutMinutes', 'maxConcurrentLocalTurns', 'updateTurnBoundMinutes'] as const) {
    if (dirty.has(key)) chat[key] = draft[key]
  }
  if (Object.keys(chat).length > 0) {
    body.chat = chat
    fields.push('chat')
    if (baselines.has('chat')) expect.chat = baselines.get('chat')
  }
  return fields.length > 0 ? { body, expect, fields } : null
}

export interface ModelChoice { default: string, fallback: string, secondary?: string, tertiary?: string }

// Only drafted places are validated, like the general fields above.
export function validateModelChoices(changes: Record<string, ModelChoice>): string | null {
  for (const [key, choice] of Object.entries(changes)) {
    if (choice.default === choice.fallback) return `${key}: the fallback must differ from the default.`
    if (choice.secondary && choice.secondary === choice.default) return `${key}: the secondary reviewer must differ from the default.`
    if (choice.tertiary && (choice.tertiary === choice.default || choice.tertiary === choice.secondary)) {
      return `${key}: the tertiary reviewer must differ from the default and the secondary.`
    }
  }
  return null
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

// A draft typed mid-save keeps a baseline at what the server now holds: the
// save succeeded, so that is the previous baseline with the sent leaves
// applied. Storing only the sent leaves would 409 the next save against the
// server's whole-object comparison.
export function mergeSaveBaseline(before: unknown, sent: unknown): unknown {
  return isRecord(before) && isRecord(sent) ? { ...before, ...sent } : sent
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => deepEqual(value, b[index]))
  }
  if (!isRecord(a) || !isRecord(b)) return false
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => deepEqual(a[key], b[key]))
}

export interface ConflictLeaf { field: string, leaf: string | null, current: unknown }

// The refused save's `current`, narrowed to the drafted leaves that actually
// moved, so the message and Read again name what changed, not the section.
export function conflictLeaves(current: Record<string, unknown>, baselines: ReadonlyMap<string, unknown>): ConflictLeaf[] {
  const leaves: ConflictLeaf[] = []
  for (const [field, value] of Object.entries(current)) {
    const baseline = baselines.get(field)
    if (isRecord(value) && isRecord(baseline)) {
      let moved = false
      for (const [sub, subValue] of Object.entries(value)) {
        if (!deepEqual(subValue, baseline[sub])) {
          leaves.push({ field, leaf: sub, current: subValue })
          moved = true
        }
      }
      // Shapes differ without a moved leaf (a removed key): name the field.
      if (!moved) leaves.push({ field, leaf: null, current: value })
    } else {
      leaves.push({ field, leaf: null, current: value })
    }
  }
  return leaves
}

const FIELD_LABELS: Record<string, string> = { me: 'Your GitHub account', agentAccount: 'GitHub automation account', timezone: 'Time zone' }
const CHAT_LABELS: Record<string, string> = { branchPrefix: 'Branch prefix', idleTimeoutMinutes: 'Idle timeout', maxConcurrentLocalTurns: 'Concurrent local turns', updateTurnBoundMinutes: 'Update turn bound' }

function formatScalar(value: unknown): string {
  if (typeof value === 'string') return value ? `"${value}"` : '(empty)'
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value) ?? String(value)
}

function formatChoice(value: unknown): string {
  if (isRecord(value) && typeof value.default === 'string') {
    const parts = [`default ${formatScalar(value.default)}`, `fallback ${formatScalar(value.fallback)}`]
    if (typeof value.secondary === 'string') parts.push(`secondary ${formatScalar(value.secondary)}`)
    if (typeof value.tertiary === 'string') parts.push(`tertiary ${formatScalar(value.tertiary)}`)
    return parts.join(', ')
  }
  return formatScalar(value)
}

export function conflictMessage(leaves: ConflictLeaf[]): string {
  const parts = leaves.map((entry) => {
    if (entry.field === 'chat' && entry.leaf) return `${CHAT_LABELS[entry.leaf] ?? entry.leaf} is now ${formatScalar(entry.current)}`
    if (entry.field === 'models' && entry.leaf) return `Models "${entry.leaf}" is now ${formatChoice(entry.current)}`
    if (entry.leaf) return `${entry.field}.${entry.leaf} is now ${formatScalar(entry.current)}`
    return `${FIELD_LABELS[entry.field] ?? entry.field} is now ${formatScalar(entry.current)}`
  })
  const changed = parts.length > 0 ? parts.join('; ') : 'Settings changed on the server'
  return `${changed}. Your edits are kept — Save again to overwrite, or Read again for the saved values.`
}
