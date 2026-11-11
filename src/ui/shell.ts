// The frame every place shares, from the mocks' shell.js and bell.js: the top
// bar and its Settings menu, the connection, the bell, toasts, the route back
// and the instruction lifecycle. It is drawn once; moving between places
// never re-renders it.
import { $, $$, esc } from './dom'
import { icon, hydrateIcons } from './icons'
import { noticeFeed, READ_INTERVAL_MS } from '../notices'
import { PLACE_NAMES, placeHref, type Address, type Place } from './address'
import { styleSettingsHref } from './style-panel'

// ---------- Motion read from tokens ----------
let probe: HTMLElement | null = null
/** A duration token and the spring, resolved, for animations a script runs. */
export function motion(dur = '--dur-settle'): { duration: number, easing: string } {
  if (!probe) { probe = document.createElement('i'); probe.hidden = true; document.body.append(probe) }
  probe.style.transition = `opacity var(${dur}) var(--ease-spring)`
  const cs = getComputedStyle(probe)
  return { duration: (parseFloat(cs.transitionDuration) || 0) * 1000, easing: cs.transitionTimingFunction || 'ease-out' }
}

// ---------- Instruction progress: accepted → queued → executing → completed ----------
export const STAGES = ['Accepted', 'Queued', 'Executing', 'Completed'] as const
export type Stage = typeof STAGES[number]
export function lifeHTML(stage: Stage, label?: string, skipQueued?: boolean): string {
  const i = STAGES.indexOf(stage)
  return STAGES.map((s, k) => {
    let cls = ''
    if (skipQueued && s === 'Queued' && i > 1) cls = 'skip'
    else if (k < i || (k === i && stage === 'Completed')) cls = 'd'
    else if (k === i) cls = 'now'
    return `${k ? `<b${k <= i ? ' class="d"' : ''}></b>` : ''}<i${cls ? ` class="${cls}"` : ''}></i>`
  }).join('') + `<span class="lbl"><b>${stage}</b>${label ? ` · ${esc(label)}` : ''}</span>`
}
export function lifeTo(el: HTMLElement | null, stage: Stage, label?: string, skipQueued?: boolean): void {
  if (!el) return
  el.dataset.life = stage
  el.innerHTML = lifeHTML(stage, label, skipQueued)
}

// ---------- Feedback that says what happened and when it applies ----------
let toastEl: HTMLElement | null = null
let toastTimer = 0
export function toast(text: string, state?: string): void {
  if (!toastEl) {
    toastEl = Object.assign(document.createElement('div'), { className: 'toast', hidden: true })
    toastEl.setAttribute('role', 'status')
    toastEl.setAttribute('aria-live', 'polite')
    document.body.append(toastEl)
  }
  toastEl.innerHTML = `${state ? `<span class="sc" data-state="${esc(state)}"></span>` : ''}<span>${esc(text)}</span>`
  toastEl.hidden = false
  clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => { if (toastEl) toastEl.hidden = true }, 4200)
}

// ---------- Menus: [data-menu="id"] opens that menu; [data-menu-open] opens Settings ----------
let openFor: HTMLElement | null = null
export function closeMenus(): void {
  $$('.menu').forEach((m: HTMLElement) => { m.hidden = true })
  $$('[aria-expanded="true"][aria-haspopup]').forEach((b: HTMLElement) => b.setAttribute('aria-expanded', 'false'))
  openFor = null
}
export function openMenu(menu: HTMLElement | null, anchor: HTMLElement, align = 'left'): void {
  const again = openFor === anchor
  closeMenus()
  if (!menu || again) return
  const r = anchor.getBoundingClientRect(), gap = 8
  menu.hidden = false
  menu.style.top = `${r.bottom + gap}px`
  if (align === 'right') { menu.style.left = ''; menu.style.right = `${innerWidth - r.right}px` } else { menu.style.right = ''; menu.style.left = `${r.left}px` }
  anchor.setAttribute('aria-expanded', 'true')
  openFor = anchor
  $('[role^="menuitem"]:not([aria-disabled="true"])', menu)?.focus({ preventScroll: true })
}

// ---------- The top bar ----------
const NAV: [Place, string][] = [['overview', 'nav.overview'], ['board', 'nav.current'], ['chat', 'nav.chat'], ['editor', 'nav.editor'], ['observe', 'nav.observe']]
const SECTION_LINKS: [string, string][] = [
  ['general', 'General'], ['accounts', 'Accounts'], ['models', 'Models'], ['extensions', 'Extensions'], ['publishing', 'Publishing'],
  ['behaviors', 'Behaviors'], ['snippets', 'Snippets'], ['admin', 'Admin'], ['style', 'Style'], ['manager', 'Manager'],
]

function topbarHTML(): string {
  return `<header class="topbar">
    <nav class="ia" aria-label="Poise">
      ${NAV.map(([place, ref]) => `<a href="${placeHref(place)}" data-place="${place}" data-ref="${ref}">${PLACE_NAMES[place]}</a>`).join('')}
      <button class="nav" data-menu-open aria-haspopup="menu" aria-expanded="false" data-ref="nav.settings">Settings${icon('down', 'sm')}</button>
    </nav>
    <div class="right">
      <span class="live" role="status" data-ref="conn">Live</span>
      <button class="icon-btn" data-bell-open aria-label="Notifications. Opens Answer here in Overview." data-ref="bell">${icon('bell')}<span class="badge" data-bell hidden></span></button>
    </div>
  </header>`
}

function menuHTML(): string {
  return `<div class="menu" id="main-menu" hidden role="menu" aria-label="Settings">
    <div class="grp t-micro">Settings</div>
    <button class="menu-row" role="menuitem" data-style-open data-ref="set.style"><i data-i="palette" class="sm"></i>Style panel</button>
    <a class="menu-row" role="menuitem" data-menu-manager data-ref="set.manager"><i data-i="sliders" class="sm"></i>Manager’s controls<span class="t-gloss">Rhythm · Stability · Autonomy</span></a>
    <div class="sep"></div>
    ${SECTION_LINKS.map(([section, label]) => `<a class="menu-row" role="menuitem" data-menu-section="${section}" data-ref="set.go"><span class="t">${label}</span></a>`).join('')}
  </div>`
}

/** Draws the frame: the top bar, the Settings menu and the place's mount. */
export function mountFrame(host: HTMLElement): HTMLElement {
  host.innerHTML = `<div class="frame">${topbarHTML()}<div class="place" data-place-root></div></div>${menuHTML()}`
  hydrateIcons(host)
  document.addEventListener('click', (e) => {
    const t = e.target as Element
    const opener = t.closest<HTMLElement>('[data-menu], [data-menu-open]')
    if (opener) { openMenu(document.getElementById(opener.dataset.menu || 'main-menu'), opener, opener.dataset.menuAlign); return }
    if (t.closest('.menu [aria-disabled="true"]')) return
    if (t.closest('.menu [data-style-open]') || t.closest('.menu a')) { closeMenus(); return }
    if (!t.closest('.menu')) closeMenus()
  })
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openFor) { const a = openFor; closeMenus(); a.focus() } })
  watchConnection($('[data-ref="conn"]', host))
  watchBell($('[data-ref="bell"]', host))
  return $('[data-place-root]', host)
}

/** Marks the place you are in and points the menu's links back to it. */
export function showPlace(address: Address): void {
  const here = address.place
  // The Manager is reached from Chat, and its tab is Chat's.
  const tab = here === 'manager' ? 'chat' : here
  $$('.ia [data-place]').forEach((a: HTMLElement) => {
    const on = a.dataset.place === tab
    a.classList.toggle('on', on)
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current')
  })
  const settings = $('.ia [data-menu-open]')
  settings?.classList.toggle('on', here === 'settings')
  if (here === 'settings') settings?.setAttribute('aria-current', 'page'); else settings?.removeAttribute('aria-current')
  const back = here === 'settings' ? address.back : here
  $('[data-menu-manager]')?.setAttribute('href', placeHref('manager', { pane: 'controls', back: here === 'manager' ? address.back : back }))
  $$('[data-menu-section]').forEach((a: HTMLElement) => {
    a.setAttribute('href', placeHref('settings', { settings: a.dataset.menuSection, back }))
    if (here === 'settings' && address.section === a.dataset.menuSection) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current')
  })
  styleSettingsHref(placeHref('settings', { settings: 'style', back }))
  bellBack = here
}

// ---------- The route back ----------
const BACK_WORDS: Record<Place, string> = { ...PLACE_NAMES, manager: 'the Manager' }
/** Fills a place's [data-back] link: Back to the place you came from. */
export function routeBack(el: HTMLAnchorElement | null, address: Address): void {
  if (!el) return
  el.hidden = !address.back
  if (!address.back) return
  el.href = placeHref(address.back)
  el.innerHTML = `${icon('chev', 'sm')}Back to ${BACK_WORDS[address.back]}`
}

// ---------- The connection says when what you see may be out of date ----------
function watchConnection(el: HTMLElement | null): void {
  if (!el) return
  let heard = Date.now()
  const paint = () => {
    const word = !navigator.onLine ? 'Offline' : document.visibilityState === 'visible' && Date.now() - heard > READ_INTERVAL_MS * 2.5 ? 'Reconnecting…' : 'Live'
    if (el.textContent !== word) el.textContent = word
    el.classList.toggle('is-reconnecting', word !== 'Live')
  }
  noticeFeed.subscribe(() => { heard = Date.now(); paint() })
  // A tab coming back reads at once; it is not out of date until that read is late.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') heard = Date.now(); paint() })
  addEventListener('online', paint)
  addEventListener('offline', paint)
  setInterval(paint, READ_INTERVAL_MS / 2)
}

// ---------- The bell: what needs you, opening Overview's Answer here ----------
let bellBack: Place = 'overview'
function watchBell(btn: HTMLElement | null): void {
  const badge = btn?.querySelector<HTMLElement>('[data-bell]')
  if (!btn || !badge) return
  const paint = () => {
    const count = noticeFeed.current.notices.length
    badge.textContent = String(count)
    badge.hidden = !count
    badge.dataset.tone = 'needs-you'
    btn.setAttribute('aria-label', `Notifications, ${count} open. Opens Answer here in Overview.`)
  }
  noticeFeed.subscribe(paint)
  paint()
  btn.addEventListener('click', () => {
    const href = `${placeHref('overview', { back: bellBack === 'overview' ? null : bellBack })}#answer`
    document.dispatchEvent(new CustomEvent('poise:go', { detail: { href } }))
  })
}
