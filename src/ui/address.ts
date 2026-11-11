// Addresses (#556, Design → Addresses). A place is ?view=<place>. Observe adds
// part=, Settings adds settings=, Board and Observe's GitHub part add item=,
// and back= names the place to return to. Classic's entry points map onto the
// places, so every link the service and notices send keeps working.

export const PLACES = ['overview', 'board', 'chat', 'manager', 'editor', 'observe', 'settings'] as const
export type Place = typeof PLACES[number]
export const PARTS = ['tasks', 'behaviors', 'github', 'logging'] as const
export type Part = typeof PARTS[number]
export const SECTIONS = ['general', 'accounts', 'models', 'extensions', 'publishing', 'behaviors', 'snippets', 'admin', 'style', 'manager'] as const
export type Section = typeof SECTIONS[number]

export const PLACE_NAMES: Record<Place, string> = {
  overview: 'Overview', board: 'Board', chat: 'Chat', manager: 'Manager', editor: 'Editor', observe: 'Observe', settings: 'Settings',
}

export const isPlace = (value: unknown): value is Place => (PLACES as readonly unknown[]).includes(value)
const isPart = (value: unknown): value is Part => (PARTS as readonly unknown[]).includes(value)
// Settings takes its sections, and the service's own entry points into them:
// /?settings=link opens Accounts' pairing (gateway/src/link.ts).
const isSectionEntry = (value: unknown): boolean => (SECTIONS as readonly unknown[]).includes(value) || value === 'link'
const ITEM = /^[\w.-]+\/[\w.-]+#\d+$/

export interface Address {
  place: Place
  /** Observe's part, when the address names one. */
  part: Part | null
  /** Settings' section, or `link`, when the address names one. */
  section: string | null
  /** The place to return to, only ever one of the places. */
  back: Place | null
  /** A card or row to open: `owner/name#number`, for Board and Observe. */
  item: string | null
}

/** Reads an address and returns it with its canonical query: the place's own
 *  words, every other parameter kept for the place to read. */
export function readAddress(search: string): { address: Address, query: URLSearchParams } {
  const query = new URLSearchParams(search)
  const view = query.get('view')
  let place: Place = 'overview'
  let part: Part | null = null
  if (isPlace(view)) place = view
  else if (view === 'logging') {
    // Classic's one address: Logging's durable links, and a chain's journal at a
    // step from a notice, which now lives in Observe → Tasks.
    place = 'observe'
    part = query.has('chain') ? 'tasks' : 'logging'
  } else if (!view && isSectionEntry(query.get('settings'))) place = 'settings'
  if (place === 'observe' && !part) part = isPart(query.get('part')) ? query.get('part') as Part : null
  const section = place === 'settings' && isSectionEntry(query.get('settings')) ? query.get('settings') : null
  const back = isPlace(query.get('back')) && query.get('back') !== place ? query.get('back') as Place : null
  const item = (place === 'board' || place === 'observe') && ITEM.test(query.get('item') ?? '') ? query.get('item') : null

  query.set('view', place)
  if (part) query.set('part', part); else query.delete('part')
  if (section) query.set('settings', section); else query.delete('settings')
  if (back) query.set('back', back); else query.delete('back')
  if (item) query.set('item', item); else query.delete('item')
  // view first, as every link writes it.
  const ordered = new URLSearchParams([['view', place], ...[...query].filter(([k]) => k !== 'view')])
  return { address: { place, part, section, back, item }, query: ordered }
}

/** A link to a place: `placeHref('settings', { settings: 'style', back: 'board' })`. */
export function placeHref(place: Place, params: Record<string, string | null | undefined> = {}): string {
  const query = new URLSearchParams({ view: place })
  for (const [k, v] of Object.entries(params)) if (v) query.set(k, v)
  return `?${query}`
}
