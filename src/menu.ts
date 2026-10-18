import { effectiveTimezone } from './config'
import { releaseLine } from './release'
import type { SettingsSection } from './settings'
import { cancelMotion, motionValue, reveal, spring } from './motion'

// Analytics is a view too, reached from the burger menu rather than the nav.
type ViewName = 'current' | 'swarm' | 'chat' | 'main' | 'behaviors' | 'snippets' | 'editor' | 'analytics' | 'logging'

const VIEW_KEY = 'poise-view'

const ICON_TYPO  = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 3h10M4 3v8M10 3v8M4 11h1.5M8.5 11H10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
const ICON_ANALYTICS = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 12h10M3.5 10V7M7 10V3M10.5 10V5.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
const ICON_MODELS = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 3.5h10M2 7h10M2 10.5h10" stroke="currentColor" stroke-width="1.3"/><circle cx="5" cy="3.5" r="1.5" fill="var(--surface)" stroke="currentColor" stroke-width="1.3"/><circle cx="9" cy="7" r="1.5" fill="var(--surface)" stroke="currentColor" stroke-width="1.3"/><circle cx="5" cy="10.5" r="1.5" fill="var(--surface)" stroke="currentColor" stroke-width="1.3"/></svg>'
const ICON_ACCOUNTS = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="4" r="2.3" stroke="currentColor" stroke-width="1.3"/><path d="M2 12c0-2.8 2-4.5 5-4.5s5 1.7 5 4.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>'
const ICON_PUBLISHING = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 9V2.5M4.25 5.25 7 2.5l2.75 2.75M2.5 9.5v2h9v-2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>'
const ICON_SETTINGS = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="2" stroke="currentColor" stroke-width="1.3"/><path d="M7 1v1.8M7 11.2V13M1 7h1.8M11.2 7H13M2.76 2.76l1.27 1.27M9.97 9.97l1.27 1.27M2.76 11.24l1.27-1.27M9.97 4.03l1.27-1.27" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>'
const ICON_BURGER = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 5h10M3 8h10M3 11h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
const ICON_CLOSE = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'

const VIEW_ITEMS: { key: ViewName; label: string }[] = [
  { key: 'current',   label: 'Current'   },
  { key: 'swarm',     label: 'Swarm'     },
  { key: 'chat',      label: 'Chat'      },
  { key: 'main',      label: 'Archive'   },
  { key: 'behaviors', label: 'Behaviors' },
  { key: 'snippets',  label: 'Snippets'  },
  { key: 'editor',    label: 'Editor'    },
]

function loadView(): ViewName {
  try {
    const v = localStorage.getItem(VIEW_KEY)
    // Stream was renamed to Current (and Pipe before that). Collapse the
    // legacy slugs to the new one once.
    if (v === 'pipe' || v === 'stream') {
      localStorage.setItem(VIEW_KEY, 'current')
      return 'current'
    }
    if (v === 'flow' || v === 'trust') {
      // Flow + Trust were dropped — land on Current (the new default).
      localStorage.setItem(VIEW_KEY, 'current')
      return 'current'
    }
    if (v === 'current' || v === 'swarm' || v === 'chat' || v === 'main' || v === 'behaviors' || v === 'snippets' || v === 'editor' || v === 'analytics' || v === 'logging') return v
  } catch { /* ignore */ }
  return 'current'
}
function saveView(v: ViewName) { localStorage.setItem(VIEW_KEY, v) }

export interface MenuCallbacks {
  onSelectView: (view: ViewName) => void
  onOpenTypography: () => void
  onOpenSettings: (section: SettingsSection) => void
  /** Show the Analytics view, opening on Today even while it already shows. */
  onOpenAnalytics: () => void
  /** Close whatever panel is open, through its own close path. The burger
   *  used to strip the `open` class off the panels directly, which skipped
   *  the close functions and left them focusable and announced while
   *  off-screen — the exact invariant those functions exist to maintain. */
  onClosePanels: () => void
}

const PANEL_IDS = ['typo-panel', 'settings-panel']
const ICON_BACK = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="m8.5 3-4 4 4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'

export function initMenu(callbacks: MenuCallbacks): { switchTo: (v: ViewName) => void; currentView: () => ViewName } {
  let current: ViewName = loadView()
  let positionFrame = 0
  let activePanel: HTMLElement | null = null
  let activeSection: string | undefined
  const nav = document.createElement('nav')
  nav.id = 'top-nav'
  nav.innerHTML = VIEW_ITEMS.map((v) => `<button class="nav-item" data-view="${v.key}">${v.label}</button>`).join('')

  const toggle = document.createElement('button')
  toggle.id = 'menu-toggle'
  toggle.type = 'button'
  toggle.innerHTML = ICON_BURGER
  toggle.setAttribute('aria-label', 'Menu')
  toggle.setAttribute('aria-controls', 'menu-surface')
  toggle.setAttribute('aria-expanded', 'false')

  const globalBar = document.createElement('div')
  globalBar.id = 'app-bar-global'
  globalBar.append(nav, toggle)
  document.body.appendChild(globalBar)

  // One frame stays attached to the burger while its contents change.
  const surface = document.createElement('div')
  surface.id = 'menu-surface'
  surface.hidden = true
  const menu = document.createElement('nav')
  menu.id = 'menu-popover'
  menu.setAttribute('aria-label', 'Menu')
  menu.hidden = true
  menu.innerHTML = `
    <div class="menu-release" hidden>
      <a class="menu-release-commit" target="_blank" rel="noopener noreferrer"></a><span class="menu-release-when"></span>
    </div>
    <div class="menu-divider menu-release-divider" hidden></div>
    <button type="button" class="menu-item" data-action="analytics">
      <span class="menu-icon">${ICON_ANALYTICS}</span><span class="menu-text">Analytics</span>
    </button>
    <button type="button" class="menu-item" data-action="logging">
      <span class="menu-icon">${ICON_MODELS}</span><span class="menu-text">Logging</span>
    </button>
    <div class="menu-divider"></div>
    <div class="menu-group-label">Settings</div>
    <button type="button" class="menu-item" data-action="settings" data-settings="general">
      <span class="menu-icon">${ICON_SETTINGS}</span><span class="menu-text">General</span>
    </button>
    <button type="button" class="menu-item" data-action="settings" data-settings="models">
      <span class="menu-icon">${ICON_MODELS}</span><span class="menu-text">Models</span>
    </button>
    <button type="button" class="menu-item" data-action="settings" data-settings="accounts">
      <span class="menu-icon">${ICON_ACCOUNTS}</span><span class="menu-text">Accounts</span>
    </button>
    <button type="button" class="menu-item" data-action="settings" data-settings="publishing">
      <span class="menu-icon">${ICON_PUBLISHING}</span><span class="menu-text">Publishing</span>
    </button>
    <button type="button" class="menu-item" data-action="typography">
      <span class="menu-icon">${ICON_TYPO}</span><span class="menu-text">Typography</span>
    </button>
    <button type="button" class="menu-item" data-action="settings" data-settings="admin" hidden>
      <span class="menu-icon">${ICON_SETTINGS}</span><span class="menu-text">Admin</span>
    </button>`
  surface.append(menu)
  document.body.append(surface)

  function openPanel(): HTMLElement | null {
    return surface.querySelector<HTMLElement>('.menu-panel.open')
  }

  function positionSurface(): void {
    const box = toggle.getBoundingClientRect()
    if (!box.width) return
    const available = Math.max(80, innerHeight - box.bottom - 12)
    const panel = openPanel()
    const terminalVisible = panel?.dataset.section === 'accounts' && panel.classList.contains('st-terminal-open')
    const wantedWidth = panel ? terminalVisible ? 640 : 420 : 252
    surface.style.top = `${box.bottom - 1}px`
    // Anchor by a measured coordinate: a reserved scrollbar gutter can make
    // viewport-relative right offsets differ even when clientWidth is unchanged.
    surface.style.left = `${box.right}px`
    surface.style.maxHeight = `${available}px`
    if (surface.hidden || surface.inert) return
    const rect = surface.getBoundingClientRect()
    spring(surface, 'size', { from: { width: rect.width || wantedWidth, height: rect.height || menu.scrollHeight + 2 },
      to: () => ({ width: Math.min(wantedWidth, toggle.getBoundingClientRect().right - 12), height: panel ? Math.min(680, innerHeight - toggle.getBoundingClientRect().bottom - 12) : Math.min(menu.scrollHeight + 2, innerHeight - toggle.getBoundingClientRect().bottom - 12) }),
      write: ({ width, height }) => { surface.style.width = `${Math.max(0, width)}px`; surface.style.height = `${Math.max(0, height)}px` },
      complete: () => cancelMotion(surface, 'size') })
  }

  function queuePosition(): void {
    if (positionFrame) return
    positionFrame = requestAnimationFrame(() => { positionFrame = 0; positionSurface() })
  }

  function syncSurface(): void {
    const panel = openPanel()
    const opened = !menu.hidden || !!panel
    toggle.innerHTML = opened ? ICON_CLOSE : ICON_BURGER
    toggle.classList.toggle('is-close', opened)
    toggle.setAttribute('aria-expanded', String(opened))
    surface.dataset.panel = panel?.id ?? ''
    if (panel) menu.hidden = true
    if (opened) {
      surface.hidden = false
      surface.removeAttribute('inert')
      for (const retiring of surface.querySelectorAll<HTMLElement>('[data-flow-retained]')) delete retiring.dataset.flowRetained
      positionSurface()
      if (panel && (panel !== activePanel || panel.dataset.section !== activeSection)) {
        const body = panel.querySelector<HTMLElement>('.tp-body')
        if (body) body.scrollTop = 0
        if (body) reveal(body, { distance: 8 })
      }
      surface.classList.add('open')
    } else {
      if (surface.hidden) return
      const retiring = activePanel ?? surface.querySelector<HTMLElement>('[data-flow-retained]') ?? menu
      retiring.dataset.flowRetained = ''
      surface.classList.remove('open')
      surface.setAttribute('inert', '')
      if (surface.contains(document.activeElement) || document.activeElement === document.body) toggle.focus({ preventScroll: true })
    }
    const presented = motionValue(surface, 'visibility')?.progress ?? Number(getComputedStyle(surface).opacity)
    spring(surface, 'visibility', { from: { progress: presented }, to: { progress: opened ? 1 : 0 },
      write: ({ progress }) => { surface.style.opacity = String(Math.max(0, Math.min(1, progress))); surface.style.translate = `0 ${(1 - progress) * 20}px` },
      complete: () => {
        if (!opened) {
          surface.hidden = true
          cancelMotion(surface, 'size')
          for (const retiring of surface.querySelectorAll<HTMLElement>('[data-flow-retained]')) delete retiring.dataset.flowRetained
        }
        cancelMotion(surface, 'visibility')
      } })
    activePanel = panel
    activeSection = panel?.dataset.section
  }

  const knownPanels = new WeakSet<HTMLElement>()
  const panelObserver = new MutationObserver(syncSurface)
  function mountPanels(): void {
    for (const id of PANEL_IDS) {
      const panel = document.getElementById(id)
      if (!panel || knownPanels.has(panel)) continue
      knownPanels.add(panel)
      panel.classList.add('menu-panel')
      const header = panel.querySelector('.tp-header')
      const back = document.createElement('button')
      back.type = 'button'
      back.className = 'tp-back'
      back.setAttribute('aria-label', 'Back to menu')
      back.dataset.help = 'Back to menu'
      back.innerHTML = ICON_BACK
      back.addEventListener('click', () => { callbacks.onClosePanels(); openMenu(); menu.querySelector<HTMLButtonElement>('.menu-item:not([hidden])')?.focus() })
      header?.prepend(back)
      const title = panel.querySelector<HTMLElement>('.tp-title')
      if (title && !title.hasAttribute('tabindex')) title.tabIndex = -1
      surface.append(panel)
      panelObserver.observe(panel, { attributes: true, attributeFilter: ['class', 'data-section'] })
      syncSurface()
    }
    const adminButton = menu.querySelector<HTMLButtonElement>('[data-settings="admin"]')!
    adminButton.hidden = !document.querySelector('#settings-panel [data-tab="admin"]')
  }
  mountPanels()
  window.addEventListener('poise:panel-opening', (event) => {
    const id = (event as CustomEvent<{ id: string }>).detail.id
    if (openPanel() && openPanel()?.id !== id) callbacks.onClosePanels()
  })
  // Typography's Reset replaces its panel; service mode adds Admin later.
  new MutationObserver(mountPanels).observe(document.body, { childList: true, subtree: true })

  const appEl = document.getElementById('app')!
  let observedHeader: HTMLElement | null = null
  const barResizeObserver = new ResizeObserver(() => { publishBarHeight(); queuePosition() })
  function publishBarHeight(): void {
    const h = observedHeader?.getBoundingClientRect().height ?? 0
    if (h > 0) document.documentElement.style.setProperty('--app-bar-h', `${Math.round(h)}px`)
  }
  function mountGlobalControls(): void {
    const header = appEl.querySelector<HTMLElement>('.view:not([hidden]) .view-header')
    if (!header) return
    if (globalBar.parentElement !== header) header.appendChild(globalBar)
    if (observedHeader !== header) {
      barResizeObserver.disconnect()
      observedHeader = header
      barResizeObserver.observe(header)
      barResizeObserver.observe(globalBar)
    }
    publishBarHeight()
    queuePosition()
  }
  let mountQueued = false
  new MutationObserver(() => {
    if (mountQueued) return
    mountQueued = true
    requestAnimationFrame(() => { mountQueued = false; mountGlobalControls() })
  }).observe(appEl, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] })
  mountGlobalControls()
  window.addEventListener('resize', queuePosition)
  window.addEventListener('scroll', () => {
    document.body.classList.toggle('is-scrolled', window.scrollY > 2)
    queuePosition()
  }, { passive: true })

  const analyticsItem = menu.querySelector<HTMLButtonElement>('[data-action="analytics"]')!
  const loggingItem = menu.querySelector<HTMLButtonElement>('[data-action="logging"]')!
  function setActiveItem(): void {
    nav.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === current))
    // No nav item lights up on Analytics, so its menu entry says where you are.
    analyticsItem.classList.toggle('active', current === 'analytics')
    if (current === 'analytics') analyticsItem.setAttribute('aria-current', 'page')
    else analyticsItem.removeAttribute('aria-current')
    loggingItem.classList.toggle('active', current === 'logging')
    if (current === 'logging') loggingItem.setAttribute('aria-current', 'page')
    else loggingItem.removeAttribute('aria-current')
  }
  setActiveItem()

  const releaseEl = menu.querySelector<HTMLElement>('.menu-release')!
  const releaseDivider = menu.querySelector<HTMLElement>('.menu-release-divider')!
  async function showRelease(): Promise<void> {
    try {
      const res = await fetch('/api/release')
      const line = res.ok ? releaseLine(await res.json(), effectiveTimezone()) : null
      if (!line) return
      const link = releaseEl.querySelector<HTMLAnchorElement>('.menu-release-commit')!
      link.textContent = line.commit
      link.href = line.href
      link.setAttribute('aria-label', line.label)
      link.dataset.help = line.label
      releaseEl.querySelector<HTMLElement>('.menu-release-when')!.textContent = line.when ? ` · ${line.when}` : ''
      releaseEl.hidden = false
      releaseDivider.hidden = false
      queuePosition()
    } catch { /* Offline: keep the last known release. */ }
  }

  function openMenu(): void {
    menu.hidden = false
    menu.classList.add('open')
    void showRelease()
    syncSurface()
  }
  function closeMenu(): void {
    menu.hidden = true
    menu.classList.remove('open')
    syncSurface()
  }
  releaseEl.addEventListener('click', (event) => {
    if ((event.target as HTMLElement).closest('a')) closeMenu()
  })
  toggle.addEventListener('click', (event) => {
    event.stopPropagation()
    if (openPanel()) callbacks.onClosePanels()
    else if (menu.hidden) openMenu()
    else closeMenu()
    syncSurface()
  })
  nav.addEventListener('click', (event) => {
    const next = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-view]')?.dataset.view as ViewName | undefined
    if (!next || next === current) return
    current = next
    saveView(current)
    setActiveItem()
    callbacks.onSelectView(current)
  })
  menu.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-action]')
    if (!button) return
    menu.hidden = true
    menu.classList.remove('open')
    callbacks.onClosePanels()
    if (button.dataset.action === 'settings') callbacks.onOpenSettings(button.dataset.settings as SettingsSection)
    else if (button.dataset.action === 'typography') callbacks.onOpenTypography()
    else if (button.dataset.action === 'analytics') {
      callbacks.onOpenAnalytics()
      // Closing the menu returns focus to the burger, which first has to move
      // into the new view's header: inside the view just hidden it cannot
      // take focus.
      mountGlobalControls()
    }
    else if (button.dataset.action === 'logging') {
      current = 'logging'; saveView(current); setActiveItem(); callbacks.onSelectView(current)
      mountGlobalControls()
    }
    syncSurface()
    openPanel()?.querySelector<HTMLElement>('.tp-title')?.focus({ preventScroll: true })
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !menu.hidden && !event.defaultPrevented) {
      event.preventDefault()
      closeMenu()
      toggle.focus()
    } else if (!menu.hidden && menu.contains(event.target as Node) && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      const items = [...menu.querySelectorAll<HTMLElement>('.menu-item:not([hidden])')]
      const index = items.indexOf(document.activeElement as HTMLElement)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
      event.preventDefault()
      items[next]?.focus()
    }
  })
  toggle.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' || openPanel()) return
    event.preventDefault()
    openMenu()
    menu.querySelector<HTMLButtonElement>('.menu-item')?.focus()
  })
  document.addEventListener('click', (event) => {
    if (!menu.hidden && !surface.contains(event.target as Node) && !toggle.contains(event.target as Node)) closeMenu()
  })
  return {
    switchTo: (v: ViewName) => { current = v; saveView(v); setActiveItem(); callbacks.onSelectView(v) },
    currentView: () => current,
  }
}
