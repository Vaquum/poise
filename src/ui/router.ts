// Moving between places (#556, Design). One page: the frame stays, and the
// place the address names mounts under it. Each move is a history entry, so
// Back and Forward work; a place's listeners, timers and polling stop when it
// leaves, and it arrives through the motion runtime, once per mount.
import { reveal } from '../motion'
import { readAddress, type Address, type Place } from './address'
import { closeMenus, showPlace } from './shell'
import { closeRef, paintTerms } from './reference'

export interface PlaceContext {
  address: Address
  /** The address's query, canonical: every parameter the place may read. */
  query: URLSearchParams
  root: HTMLElement
  /** Aborted when the place leaves: pass it to every listener the place adds. */
  signal: AbortSignal
  /** setInterval and setTimeout that stop when the place leaves. */
  every(ms: number, fn: () => void): void
  after(ms: number, fn: () => void): void
}

/** A place mounts into its root and may return what to do as it leaves. */
export type MountPlace = (ctx: PlaceContext) => void | (() => void) | Promise<void | (() => void)>

type PlaceModule = { mount: MountPlace }
const PLACES: Record<Place, () => Promise<PlaceModule>> = {
  overview: () => import('./places/placeholder'),
  board: () => import('./places/placeholder'),
  chat: () => import('./places/placeholder'),
  manager: () => import('./places/placeholder'),
  editor: () => import('./places/placeholder'),
  observe: () => import('./places/placeholder'),
  settings: () => import('./places/placeholder'),
}
// As classic's: Chat, the Manager and the Editor only fade in.
const FADE_ONLY = new Set<Place>(['chat', 'manager', 'editor'])

let root: HTMLElement
let current: { place: Place, controller: AbortController, leave?: () => void } | null = null
let sequence = 0

async function mountAddress(): Promise<void> {
  const mine = ++sequence
  const { address, query } = readAddress(location.search)
  const canonical = `${location.pathname}?${query}${location.hash}`
  if (canonical !== `${location.pathname}${location.search}${location.hash}`) history.replaceState(history.state, '', canonical)
  closeMenus()
  closeRef()
  if (current) {
    current.controller.abort()
    try { current.leave?.() } catch (error) { console.error('[ui] a place failed to leave cleanly:', error) }
    current = null
  }
  showPlace(address)
  const module = await PLACES[address.place]()
  if (mine !== sequence) return
  const controller = new AbortController()
  const { signal } = controller
  const ctx: PlaceContext = {
    address, query, root, signal,
    every(ms, fn) { const id = setInterval(fn, ms); signal.addEventListener('abort', () => clearInterval(id)) },
    after(ms, fn) { const id = setTimeout(fn, ms); signal.addEventListener('abort', () => clearTimeout(id)) },
  }
  current = { place: address.place, controller }
  root.replaceChildren()
  root.dataset.place = address.place
  scrollTo(0, 0)
  const leave = await module.mount(ctx)
  if (current?.controller !== controller) { if (typeof leave === 'function') leave(); return }
  if (typeof leave === 'function') current.leave = leave
  paintTerms(root)
  reveal(root, FADE_ONLY.has(address.place) ? { distance: 0 } : {})
}

/** Moves to `href`, a link within this page, as a new history entry. */
export function go(href: string, replace = false): void {
  const url = new URL(href, location.href)
  const from = current?.place ?? null
  if (replace) history.replaceState({ from }, '', url)
  else history.pushState({ from }, '', url)
  void mountAddress()
}

/** A link to a place on this page, followed without a reload. */
function ownLink(e: MouseEvent): HTMLAnchorElement | null {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return null
  const a = (e.target as Element).closest<HTMLAnchorElement>('a[href]')
  if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download')) return null
  const url = new URL(a.href, location.href)
  return url.origin === location.origin && url.pathname === location.pathname && url.searchParams.has('view') ? a : null
}

export function startRouter(placeRoot: HTMLElement): void {
  root = placeRoot
  document.addEventListener('click', (e) => {
    const a = ownLink(e)
    if (!a) return
    e.preventDefault()
    // Back to the place you came from returns to that very entry, as you left it.
    if (a.matches('[data-back]') && history.state?.from === readAddress(new URL(a.href).search).address.place) { history.back(); return }
    go(a.href)
  })
  document.addEventListener('poise:go', (e) => go((e as CustomEvent<{ href: string }>).detail.href))
  addEventListener('popstate', () => { void mountAddress() })
  void mountAddress()
}
