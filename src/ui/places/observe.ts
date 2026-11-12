// Observe (#556): what happened, and why, in four parts under one header.
// Tasks is the behavior chain's evidence; Behaviors was Swarm, GitHub was
// Archive, and Logging keeps its name and its links. A part mounts when it is
// first shown and reads only while it shows; the Scope is Board's choice of
// organization, and the part you chose last is remembered in this browser
// unless the address names one.
import './observe.css'
import './observe/registry'
import { placeSettings, startRefreshTicker } from '../../config'
import { registerReloadGuard } from '../../self-update-watch'
import { $, $$, esc, store } from '../dom'
import { hydrateIcons } from '../icons'
import { closeMenus, routeBack } from '../shell'
import { PARTS, type Part } from '../address'
import type { MountPlace, PlaceContext } from '../router'
import { readyOrganizations, saveScope, savedScope } from './observe/util'
import type { ObservePart, PartContext } from './observe/part'
import { createTasks } from './observe/tasks'
import { createBehaviors } from './observe/behaviors'
import { createGithub } from './observe/github'
import { createLogging } from './observe/logging'

const TAB_KEY = 'poise-observe-tab'
const NAMES: Record<Part, string> = { tasks: 'Tasks', behaviors: 'Behaviors', github: 'GitHub', logging: 'Logging' }
const GLOSS: Record<Part, string> = {
  tasks: 'Every task the chain carries, issue to merge: its phase, what it waits for, its evidence and its timeline.',
  behaviors: 'Every agent run, live: what the behaviors run, and chat turns, editor chats and fixes.',
  github: 'Pull requests, issues and CI runs, newest first.',
  logging: 'Poise’s retained diagnostics: what failed or warned, with its evidence.',
}
const CREATE: Record<Part, (ctx: PartContext) => ObservePart> = { tasks: createTasks, behaviors: createBehaviors, github: createGithub, logging: createLogging }
const isPart = (value: unknown): value is Part => (PARTS as readonly unknown[]).includes(value)

function shellHTML(): string {
  return `<main class="obv">
    <header class="obv-head">
      <div class="obv-tabs" role="tablist" aria-label="Observe" data-ref="obs.tabs">
        ${PARTS.map((part) => `<button type="button" role="tab" id="obv-tab-${part}" aria-controls="obv-panel-${part}" aria-selected="false" tabindex="-1" data-tab="${part}" data-ref="obs.${part}">${NAMES[part]}<span class="n" data-tabn="${part}"></span></button>`).join('')}
      </div>
      <p class="t-gloss obv-gloss" data-gloss></p>
      <a class="back" href="#" data-back hidden data-ref="back"></a>
      <div class="obv-scope" data-scope hidden><span class="t-micro">Scope</span><button type="button" class="pick" data-menu="obv-org-menu" aria-haspopup="menu" aria-expanded="false" data-ref="obs.org"><span data-org-label>All orgs</span></button></div>
    </header>
    ${PARTS.map((part) => `<section class="obv-panel" role="tabpanel" id="obv-panel-${part}" aria-labelledby="obv-tab-${part}" data-panel="${part}" hidden></section>`).join('')}
    <div class="menu" id="obv-org-menu" hidden role="menu" aria-label="Organization"></div>
  </main>`
}

export const mount: MountPlace = async (ctx: PlaceContext) => {
  const { address, query, root, signal } = ctx
  root.innerHTML = shellHTML()
  hydrateIcons(root)
  routeBack($('[data-back]', root), address)
  startRefreshTicker()
  // Organizations and the time zone come with the settings, and every part reads by them.
  await placeSettings()
  if (signal.aborted) return

  // ---------- The Scope: Board's choice, or wider for this visit when a link needs it ----------
  let org = savedScope()
  const scopeListeners = new Set<() => void>()
  const scope = {
    org: () => org,
    set(next: string, remember: boolean) {
      if (remember) saveScope(next)
      if (next === org) return
      org = next
      paintScope()
      scopeListeners.forEach((fn) => fn())
    },
    onChange(fn: () => void) { scopeListeners.add(fn) },
  }
  function paintScope(): void {
    const orgs = readyOrganizations()
    const box = $('[data-scope]', root)
    box.hidden = orgs.length < 2 || current === 'logging'
    $('[data-org-label]', root).textContent = org || 'All orgs'
    $('#obv-org-menu', root).innerHTML = ['', ...orgs].map((login) => `<button type="button" class="menu-row" role="menuitemradio" aria-checked="${login === org}" data-org="${esc(login)}" data-ref="obs.org">${login ? esc(login) : 'All orgs'}</button>`).join('')
  }
  $('#obv-org-menu', root).addEventListener('click', (e: Event) => {
    const row = (e.target as Element).closest<HTMLElement>('[data-org]')
    if (!row) return
    closeMenus()
    scope.set(row.dataset.org ?? '', true)
  })

  // ---------- The parts ----------
  const parts = new Map<Part, ObservePart>()
  const back = address.back
  let current: Part = isPart(address.part) ? address.part : isPart(store.get(TAB_KEY, '')) ? store.get(TAB_KEY, '') as Part : 'behaviors'
  const partContext = (part: Part): PartContext => ({
    root: $(`[data-panel="${part}"]`, root),
    query,
    back,
    signal,
    every: ctx.every,
    after: ctx.after,
    scope,
    visible: () => current === part && !document.hidden,
    count: (html) => { $(`[data-tabn="${part}"]`, root).innerHTML = html },
    go: (href) => document.dispatchEvent(new CustomEvent('poise:go', { detail: { href } })),
  })

  function show(next: Part, chosen: boolean): void {
    current = next
    if (chosen) store.set(TAB_KEY, next)
    $$('[role="tab"]', root).forEach((tab: HTMLElement) => {
      const on = tab.dataset.tab === next
      tab.setAttribute('aria-selected', String(on))
      tab.tabIndex = on ? 0 : -1
    })
    $$('[data-panel]', root).forEach((panel: HTMLElement) => { panel.hidden = panel.dataset.panel !== next })
    $('[data-gloss]', root).textContent = GLOSS[next]
    paintScope()
    // The address names the part shown, so a reload or a copied link opens it again.
    const url = new URL(location.href)
    if (url.searchParams.get('part') !== next) {
      url.searchParams.set('part', next)
      history.replaceState(history.state, '', url)
    }
    for (const [part, view] of parts) if (part !== next) view.hide()
    let view = parts.get(next)
    if (!view) { view = CREATE[next](partContext(next)); parts.set(next, view) }
    view.show()
  }

  const tabs = $('.obv-tabs', root)
  tabs.addEventListener('click', (e: Event) => {
    const tab = (e.target as Element).closest<HTMLElement>('[data-tab]')
    if (tab && isPart(tab.dataset.tab) && tab.dataset.tab !== current) show(tab.dataset.tab, true)
  })
  tabs.addEventListener('keydown', (e: KeyboardEvent) => {
    const step = ({ ArrowRight: 1, ArrowLeft: -1 } as Record<string, number>)[e.key]
    if (!step) return
    e.preventDefault()
    const next = PARTS[(PARTS.indexOf(current) + step + PARTS.length) % PARTS.length]
    show(next, true)
    $(`[data-tab="${next}"]`, root)?.focus()
  })
  document.addEventListener('visibilitychange', () => { if (!document.hidden) parts.get(current)?.show() }, { signal })

  // A Stop, Replay, Hold, Resume or review sent and not yet answered holds a reload onto a new build.
  const unguard = registerReloadGuard(() => ([...parts.values()].some((view) => view.busy()) ? ['command'] : []))
  show(current, false)
  return () => {
    unguard()
    for (const view of parts.values()) view.leave()
  }
}
