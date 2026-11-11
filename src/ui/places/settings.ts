// Settings (#556; docs/design/interface/poise-ds/SETTINGS.md): one place for
// every configuration, one section at a time. Left, Find and the sections, each
// counting the settings changed from their defaults; right, the section, which
// scrolls inside the view so the top bar never moves. Every setting saves
// itself on its row (settings/rows.ts), one field at a time with what this tab
// read (settings/save.ts). `?view=settings&settings=<section>` opens a section,
// `&setting=<key>` lights one row, and `/` focuses Find.
import { placeHref, SECTIONS, type Section } from '../address'
import { $, esc } from '../dom'
import { hydrateIcons, icon } from '../icons'
import { paintTerms } from '../reference'
import { routeBack } from '../shell'
import { toggleStylePanel } from '../style-panel'
import type { MountPlace, PlaceContext } from '../router'
import { setLocalSettings, type AppSettings } from '../../config'
import { declareUnsavedWork } from '../../self-update-guards'
import { workspaceMode } from '../../workspace-mode'
import { fetchGatewayAccount, type GatewayAccount } from '../../gateway-client'
import { Rows, words, hasDef, isDefault, type Row } from './settings/rows'
import { createSaveQueue, postSettings, type Known } from './settings/save'
import type { SectionContext, SectionDef } from './settings/types'
import { conflictWords } from './settings/words'
import { GENERAL } from './settings/general'
import { ACCOUNTS } from './settings/accounts'
import { MODELS } from './settings/models'
import { EXTENSIONS } from './settings/extensions'
import { PUBLISHING } from './settings/publishing'
import { BEHAVIORS } from './settings/behaviors'
import { SNIPPETS } from './settings/snippets'
import { ADMIN } from './settings/admin'
import { STYLE } from './settings/style'
import { MANAGER } from './settings/manager'
import './settings/registry'
import './settings/classic.css'
import './settings/settings.css'

const DEFS: Record<Section, SectionDef> = {
  general: GENERAL, accounts: ACCOUNTS, models: MODELS, extensions: EXTENSIONS, publishing: PUBLISHING,
  behaviors: BEHAVIORS, snippets: SNIPPETS, admin: ADMIN, style: STYLE, manager: MANAGER,
}

async function readSettings(): Promise<Known> {
  const response = await fetch('/api/settings', { cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' } })
  const data = await response.json().catch(() => null) as Known | null
  if (!response.ok || !data || typeof data !== 'object') throw new Error((data as { error?: string } | null)?.error || `Poise answered ${response.status}`)
  return data
}

export const mount: MountPlace = async (ctx: PlaceContext) => {
  const { address, query, root, signal } = ctx
  root.innerHTML = `<main class="set" data-settings>
    <nav class="set-nav" aria-label="Settings sections" data-tip-side="right">
      <div class="set-find"><input class="search" type="search" placeholder="Find a setting" aria-label="Find a setting" autocomplete="off" spellcheck="false" data-find data-ref="set.find"><span class="kbd" aria-hidden="true">/</span></div>
      <div class="set-results" role="listbox" aria-label="Settings found" data-results hidden></div>
      <div class="set-secs" data-secs></div>
    </nav>
    <div class="set-main" data-scroll><div class="set-col"><header class="set-head" data-ref="set.head"><a class="back" href="#" data-back hidden data-ref="back"></a><h1 data-title></h1><p data-what></p></header><div class="set-body" data-body></div></div></div>
  </main>`
  routeBack($('[data-back]', root), address)
  const secsEl: HTMLElement = $('[data-secs]', root), bodyEl: HTMLElement = $('[data-body]', root), scrollEl: HTMLElement = $('[data-scroll]', root)
  const findEl: HTMLInputElement = $('[data-find]', root), resultsEl: HTMLElement = $('[data-results]', root)

  const queue = createSaveQueue(postSettings, (settings) => setLocalSettings(settings as unknown as AppSettings))
  let service = false, gateway: GatewayAccount | null = null
  let current: Section = 'general'
  let sectionAbort: AbortController | null = null
  let rows: Rows | null = null
  let leaveSection: (() => void) | null = null

  const visible = (k: Section): boolean => k !== 'admin' || !!gateway?.isAdmin
  const sectionCtx = (sectionSignal: AbortSignal, rowsOf: Rows): SectionContext => ({
    rows: rowsOf, queue, known: () => queue.known(), signal: sectionSignal, query, service,
    every: (ms, fn) => { const id = setInterval(fn, ms); sectionSignal.addEventListener('abort', () => clearInterval(id)) },
    after: (ms, fn) => { const id = setTimeout(fn, ms); sectionSignal.addEventListener('abort', () => clearTimeout(id)) },
    go: (k, setting) => { show(k); if (setting) light(setting, { focus: true }) },
    rerender: () => { if (rows && DEFS[current].rows) rows.render(DEFS[current].rows!(ctxNow!), bodyEl) ; paintNav() },
  })
  let ctxNow: SectionContext | null = null

  // ---------- The sections column ----------
  /** A section's rows, for counting and Find, built from what is known. */
  const rowsFor = (k: Section): Row[] => {
    const def = DEFS[k]
    if (!def.rows || !ctxNow) return []
    try { return def.rows({ ...ctxNow }) } catch { return [] }
  }
  const changedIn = (k: Section): number => rowsFor(k).filter((r) => hasDef(r) && !isDefault(r)).length
  function paintNav(): void {
    secsEl.innerHTML = SECTIONS.filter(visible).map((k) => {
      const n = changedIn(k)
      return `<a class="set-go" href="${esc(placeHref('settings', { settings: k, back: address.back }))}" data-go="${k}" data-ref="set.go"${k === current ? ' aria-current="page"' : ''}><span class="t">${esc(DEFS[k].name)}</span>${n ? `<span class="n" data-ref="set.changed">${n} changed</span>` : ''}</a>`
    }).join('')
      + '<span class="t-micro set-else">Beside your work</span>'
      + `<button type="button" class="set-go" data-style-open data-ref="set.style">${icon('palette', 'sm')}<span class="t">Style panel</span></button>`
      + `<a class="set-go" href="${esc(placeHref('manager', { back: 'settings' }))}" data-ref="set.manager-place">${icon('sliders', 'sm')}<span class="t">The Manager</span></a>`
    hydrateIcons(secsEl)
  }

  // ---------- One section ----------
  async function show(k: Section, { keepScroll = false } = {}): Promise<void> {
    current = visible(k) ? k : 'general'
    const def = DEFS[current]
    sectionAbort?.abort()
    try { leaveSection?.() } catch (error) { console.error('[settings] a section failed to leave cleanly:', error) }
    leaveSection = null
    const controller = new AbortController()
    sectionAbort = controller
    signal.addEventListener('abort', () => controller.abort(), { signal: controller.signal })
    const top = scrollEl.scrollTop
    $('[data-title]', root).innerHTML = `${esc(def.name)}${def.scope ? ` <span class="chip is-outline" data-ref="set.scope">${esc(def.scope)}</span>` : ''}`
    $('[data-what]', root).textContent = def.what
    document.title = `Poise — Settings · ${def.name}`
    const url = new URL(location.href)
    if (url.searchParams.get('settings') !== current) {
      url.searchParams.set('settings', current)
      history.replaceState(history.state, '', url)
    }
    // A saved answer carries every setting: the rows not being edited show what is saved now.
    rows = new Rows(bodyEl, { send: (_row, save) => queue.send(_row.key, save), changed: () => { rows?.paintAll(); paintNav() }, conflictWords }, controller.signal)
    ctxNow = sectionCtx(controller.signal, rows)
    paintNav()
    bodyEl.innerHTML = ''
    bodyEl.dataset.section = current
    if (def.mount) {
      const leave = await def.mount(bodyEl, ctxNow)
      if (controller.signal.aborted) { if (typeof leave === 'function') leave(); return }
      if (typeof leave === 'function') leaveSection = leave
    } else {
      if (def.load) {
        bodyEl.innerHTML = '<p class="set-loading t-gloss">Loading…</p>'
        try { await def.load(ctxNow) } catch (error) { console.error('[settings] a section could not read what it shows:', error) }
        if (controller.signal.aborted) return
      }
      rows.render(def.rows!(ctxNow), bodyEl)
    }
    paintTerms(bodyEl)
    paintNav()
    scrollEl.scrollTop = keepScroll ? top : 0
  }

  // Lights one row, from Find or from ?setting=. Only Find moves focus there.
  function light(key: string, { focus = false } = {}): void {
    const el = root.querySelector<HTMLElement>(`[data-setting="${CSS.escape(key)}"]`)
    if (!el) return
    el.scrollIntoView({ block: 'center' })
    el.classList.remove('is-lit')
    void el.offsetWidth
    el.classList.add('is-lit')
    ctx.after(1800, () => el.classList.remove('is-lit'))
    if (focus) el.querySelector<HTMLElement>('.srow-r input, .srow-r select, .srow-r textarea, .srow-r .seg button, .srow-r .sswitch, .srow-r .btn-ghost:not([aria-disabled="true"]), .srow-r .ib')?.focus({ preventScroll: true })
  }

  // ---------- Find: every section, by name, explanation or value ----------
  interface Hit { sec: Section, key: string | null, name: string, where: string, text: string }
  const short = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t)
  function index(): Hit[] {
    return SECTIONS.filter(visible).flatMap((k): Hit[] => {
      const def = DEFS[k]
      const own: Hit = { sec: k, key: null, name: def.name, where: short(def.what, 56), text: `${def.name} ${def.what} ${def.findText ?? ''}` }
      return [own, ...rowsFor(k).map((r) => {
        const value = r.value ? words(r) : ''
        return { sec: k, key: r.key, name: r.label, where: `${def.name} · ${short(value || r.group, 56)}`, text: `${r.label} ${r.gloss.replace(/<[^>]+>/g, '')} ${r.group} ${def.name} ${value} ${r.findText?.() ?? ''}` }
      })]
    })
  }
  let hits: Hit[] = [], at = 0
  function find(): void {
    const q = findEl.value.trim().toLowerCase()
    if (!q) { resultsEl.hidden = true; secsEl.hidden = false; return }
    hits = index().filter((h) => h.text.toLowerCase().includes(q)).slice(0, 8)
    at = 0
    resultsEl.hidden = false
    secsEl.hidden = true
    paintHits()
  }
  function paintHits(): void {
    resultsEl.innerHTML = hits.length
      ? hits.map((h, i) => `<button type="button" class="res" role="option" aria-selected="${i === at}" data-hit="${i}"><span class="t">${esc(h.name)}</span><span class="t-gloss">${esc(h.where)}</span></button>`).join('')
      : `<p class="none">Nothing matches “${esc(findEl.value.trim())}”. Try a word from what a setting does.</p>`
  }
  async function open(h: Hit | undefined): Promise<void> {
    if (!h) return
    findEl.value = ''
    find()
    if (h.sec !== current) await show(h.sec)
    if (h.key) light(h.key, { focus: true })
  }
  findEl.addEventListener('input', find, { signal })
  findEl.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (hits.length) { at = (at + (e.key === 'ArrowDown' ? 1 : hits.length - 1)) % hits.length; paintHits() } }
    if (e.key === 'Enter') { e.preventDefault(); void open(hits[at]) }
    if (e.key === 'Escape' && findEl.value) { e.preventDefault(); e.stopPropagation(); findEl.value = ''; find() }
  }, { signal })
  resultsEl.addEventListener('click', (e) => { const b = (e.target as Element).closest<HTMLElement>('[data-hit]'); if (b) void open(hits[Number(b.dataset.hit)]) }, { signal })
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || (e.target as Element | null)?.closest?.('input, textarea, select, [contenteditable="true"], .xterm')) return
    e.preventDefault()
    findEl.focus()
  }, { signal })

  // A section's link switches here, in place: the address names it, and Back still leaves Settings.
  secsEl.addEventListener('click', (e) => {
    const a = (e.target as Element).closest<HTMLAnchorElement>('[data-go]')
    if (a) {
      if ((e as MouseEvent).metaKey || (e as MouseEvent).ctrlKey || (e as MouseEvent).shiftKey) return
      e.preventDefault()
      if (a.dataset.go !== current) void show(a.dataset.go as Section)
      return
    }
    if ((e.target as Element).closest('[data-style-open]')) toggleStylePanel(true)
  }, { signal })

  const undeclare = declareUnsavedWork('settings', () => ({ dirty: !!rows?.pending() && !queue.busy(), saving: queue.busy() }))

  // ---------- Start ----------
  const [settings, mode] = await Promise.allSettled([readSettings(), workspaceMode()])
  if (signal.aborted) { undeclare(); return }
  if (settings.status === 'fulfilled') { queue.setKnown(settings.value); setLocalSettings(settings.value as unknown as AppSettings) }
  else bodyEl.innerHTML = `<p class="is-err" role="alert">Settings could not be read: ${esc((settings.reason as Error).message)}. What you see may be out of date.</p>`
  service = mode.status === 'fulfilled' && mode.value.service
  if (service) gateway = await fetchGatewayAccount().catch(() => null)
  if (signal.aborted) { undeclare(); return }
  // /?settings=link opens Accounts at Poise Link; /?settings=admin opens Admin
  // for the gateway's admins and Poise Link for everyone else, as classic does.
  const toLink = address.section === 'link' || (address.section === 'admin' && !gateway?.isAdmin)
  const wanted = toLink ? 'accounts' : address.section
  const first: Section = (SECTIONS as readonly string[]).includes(wanted ?? '') ? wanted as Section : 'general'
  await show(first)
  const setting = query.get('setting') || (toLink && service ? 'link.pair' : '')
  if (setting) ctx.after(60, () => light(setting))

  return () => {
    undeclare()
    sectionAbort?.abort()
    try { leaveSection?.() } catch (error) { console.error('[settings] a section failed to leave cleanly:', error) }
  }
}
