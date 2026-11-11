// The single vocabulary of Poise. The frame registers the shared words; each
// place registers its own when it loads. Tooltips, the full reference and the
// words on screen all read from here, so they cannot drift apart.
import { SHARED } from './shared'
import type { RefEntry, Registry } from './types'

export type { RefEntry, Registry, RefText } from './types'

const REF: Registry = { ...SHARED }

export function register(entries: Registry): void {
  Object.assign(REF, entries)
}

export function entry(key: string | undefined): RefEntry | undefined {
  return key ? REF[key] : undefined
}

/** The word on screen for a key: `term('state.running')` is Running. */
export function term(key: string): string {
  return REF[key]?.name || key
}

export function registered(): Registry {
  return REF
}
