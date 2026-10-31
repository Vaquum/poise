import { cancelMotion, spring } from './motion'
import { defaultNavigation, getNavigation, navigationViews, NAVIGATION_CHANGED, NAVIGATION_KEY, placeNavigation, saveNavigation, VIEW_ITEMS, type NavigationPreferences, type NavigationSurface, type ViewName } from './navigation'

const GRIP = '<svg width="12" height="16" viewBox="0 0 12 16" aria-hidden="true" fill="currentColor"><circle cx="4" cy="4" r="1"/><circle cx="8" cy="4" r="1"/><circle cx="4" cy="8" r="1"/><circle cx="8" cy="8" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="8" cy="12" r="1"/></svg>'
const CLOSE = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="m3 3 6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>'
const surfaces = ['topBar', 'menu'] as const
const surfaceName = (surface: NavigationSurface) => surface === 'menu' ? 'menu' : 'top bar'
const viewLabel = (view: ViewName) => VIEW_ITEMS.find(item => item.key === view)!.label
interface Pickup {
  view: ViewName; source: NavigationSurface | null; target: NavigationSurface | null; index: number
  preferences: NavigationPreferences; mode: 'pointer' | 'keyboard' | 'click'; pointer: number | null
  x: number; y: number
}
interface Pending { view: ViewName; source: NavigationSurface | null; pointer: number; x: number; y: number }

export function navigationSection(): HTMLElement {
  const section = document.createElement('section')
  section.className = 'st-tab st-navigation'
  section.dataset.tab = 'navigation'
  section.hidden = true
  section.innerHTML = `
    <p class="st-help st-navigation-intro">Drag or click to arrange your shortcuts.</p>
    <p id="st-navigation-instructions" class="st-navigation-sr">Click a shortcut to pick up, then click to place. With a keyboard, Space or Enter picks up; Up and Down arrange, Left chooses top bar, Right chooses menu, Home and End reach the ends, Enter drops and Escape cancels.</p>
    <div class="st-navigation-columns">${surfaces.map(surface => `<div role="group" aria-label="${surface === 'menu' ? 'Menu' : 'Top bar'} shortcuts">
      <div class="st-navigation-heading">${surface === 'menu' ? 'Menu' : 'Top bar'}</div>
      <ol class="st-navigation-list" data-list="${surface}"></ol>
    </div>`).join('')}</div>
    <div class="st-navigation-library">
      <div class="st-navigation-heading">All views</div>
      <p class="st-help">Drag into either area. A view can appear in both.</p>
      <div class="st-navigation-palette">${VIEW_ITEMS.map(({ key, label }) => `<button type="button" class="st-navigation-source" data-pickup="${key}" data-source="palette" data-navigation-focus="palette-${key}" aria-label="Add ${label}">${GRIP}<span>${label}</span></button>`).join('')}</div>
      <div class="st-navigation-choices" hidden></div>
    </div>
    <div class="st-navigation-footer"><span>Changes apply instantly</span><button type="button" class="st-navigation-reset" data-reset>Restore defaults</button></div>
    <p class="st-help st-navigation-status" role="status" aria-live="polite" aria-atomic="true"></p>
    <button type="button" class="st-navigation-sr" data-keyboard hidden aria-label="Arrange shortcut"></button>`
  const status = section.querySelector<HTMLElement>('[role="status"]')!
  const controller = section.querySelector<HTMLButtonElement>('[data-keyboard]')!
  const intro = section.querySelector<HTMLElement>('.st-navigation-intro')!
  const choices = section.querySelector<HTMLElement>('.st-navigation-choices')!
  const ghost = document.createElement('div')
  ghost.className = 'st-navigation-ghost'
  ghost.setAttribute('aria-hidden', 'true')
  let pickup: Pickup | null = null, pending: Pending | null = null, adding: ViewName | null = null
  let scrollFrame = 0, suppressClick = false
  const list = (surface: NavigationSurface) => section.querySelector<HTMLElement>(`[data-list="${surface}"]`)!
  const body = () => section.closest<HTMLElement>('.tp-body')!
  const focusView = (view: ViewName, source: NavigationSurface | null) => {
    const key = `${source ?? 'palette'}-${view}`
    ;(section.querySelector<HTMLElement>(`[data-navigation-focus="${key}"]`) ?? section.querySelector<HTMLElement>(`[data-navigation-focus="palette-${view}"]`))?.focus({ preventScroll: true })
  }
  function announce(message: string): void {
    status.classList.remove('st-help-error')
    status.textContent = message
  }
  function preventNativeDragScroll(event: TouchEvent): void {
    if (pickup?.mode === 'pointer') event.preventDefault()
  }
  function renderLists(preferences = getNavigation(), animate = false): void {
    const before = new Map<string, DOMRect>()
    for (const row of section.querySelectorAll<HTMLElement>('.st-navigation-row')) {
      if (animate) before.set(row.dataset.row!, row.getBoundingClientRect())
      cancelMotion(row, 'navigation-layout')
    }
    for (const surface of surfaces) {
      const items = navigationViews(preferences, surface).filter(({ key }) => !(pickup?.view === key && (pickup.source === surface || pickup.target === surface)))
      const target = pickup?.target === surface
      const gap = `<li class="st-navigation-gap" aria-hidden="true">${pickup?.mode === 'keyboard' ? viewLabel(pickup.view) : ''}</li>`
      list(surface).classList.toggle('st-navigation-target', target)
      list(surface).innerHTML = items.map(({ key, label }, index) => `${target && pickup!.index === index ? gap : ''}<li class="st-navigation-row" data-row="${surface}-${key}">
        <button type="button" class="st-navigation-handle" data-pickup="${key}" data-source="${surface}" data-navigation-focus="${surface}-${key}" aria-label="Arrange ${label} in ${surfaceName(surface)}" aria-describedby="st-navigation-instructions">${GRIP}<span>${label}</span></button>
        <button type="button" class="st-navigation-remove" data-remove="${key}" data-surface="${surface}" data-navigation-focus="remove-${surface}-${key}" aria-label="Remove ${label} from ${surfaceName(surface)}">${CLOSE}</button>
      </li>`).join('') + (target && pickup!.index >= items.length ? gap : '') + (!items.length && !target ? '<li class="st-navigation-empty">Drop a view here</li>' : '')
    }
    // Native touch stays targeted at the original handle after preview replaces it.
    for (const handle of section.querySelectorAll<HTMLElement>('[data-pickup]')) {
      handle.addEventListener('touchmove', preventNativeDragScroll, { passive: false })
    }
    if (animate) for (const row of section.querySelectorAll<HTMLElement>('.st-navigation-row')) {
      const previous = before.get(row.dataset.row!)
      if (!previous) continue
      const y = previous.top - row.getBoundingClientRect().top
      if (Math.abs(y) < .5) continue
      spring(row, 'navigation-layout', { from: { y }, to: { y: 0 }, write: ({ y }) => { row.style.transform = `translateY(${y}px)` }, complete: () => { row.style.transform = ''; cancelMotion(row, 'navigation-layout') } })
    }
  }
  function showChoices(): void {
    choices.hidden = adding === null
    choices.innerHTML = adding ? `<span>${viewLabel(adding)}</span>${surfaces.map(surface => `<button type="button" class="st-clear" data-add="${surface}" data-navigation-focus="add-${surface}-${adding}" ${getNavigation()[adding!][surface] ? 'disabled' : ''}>Add to ${surfaceName(surface)}</button>`).join('')}` : ''
  }
  function sync(): void {
    const active = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.navigationFocus : undefined
    renderLists()
    showChoices()
    if (active) {
      const target = section.querySelector<HTMLElement>(`[data-navigation-focus="${active}"]`)
      if (target) target.focus({ preventScroll: true })
      else {
        const view = VIEW_ITEMS.find(({ key }) => active.endsWith(`-${key}`))
        if (view) focusView(view.key, null)
      }
    }
  }
  function save(preferences: NavigationPreferences, message: string): boolean {
    try {
      saveNavigation(preferences)
      announce(message)
      return true
    } catch (error) {
      sync()
      status.classList.add('st-help-error')
      status.textContent = `Navigation was not saved: ${error instanceof Error ? error.message : String(error)}`
      return false
    }
  }
  function positionGhost(): void {
    if (!pickup || pickup.mode === 'keyboard') return
    ghost.style.left = `${Math.max(4, Math.min(innerWidth - ghost.offsetWidth - 4, pickup.x + 12))}px`
    ghost.style.top = `${Math.max(4, Math.min(innerHeight - ghost.offsetHeight - 4, pickup.y - 18))}px`
  }
  function renderPreview(): void {
    if (!pickup) return
    renderLists(pickup.preferences, true)
    if (pickup.mode === 'keyboard') {
      const gap = section.querySelector<HTMLElement>('.st-navigation-gap')!
      const viewport = body().getBoundingClientRect(), rect = gap.getBoundingClientRect()
      if (rect.top < viewport.top) body().scrollTop -= viewport.top - rect.top
      else if (rect.bottom > viewport.bottom) body().scrollTop += rect.bottom - viewport.bottom
      controller.setAttribute('aria-label', `${viewLabel(pickup.view)}, position ${pickup.index + 1} in ${surfaceName(pickup.target!)}`)
    }
  }
  function begin(view: ViewName, source: NavigationSurface | null, mode: Pickup['mode'], x = 0, y = 0, pointer: number | null = null): void {
    adding = null; showChoices()
    const preferences = getNavigation()
    if (source && !preferences[view][source]) { pending = null; sync(); announce('Navigation changed. Move cancelled.'); return }
    pickup = { view, source, target: source, index: source ? navigationViews(preferences, source).findIndex(item => item.key === view) : 0, preferences, mode, pointer, x, y }
    section.classList.add('st-navigation-held')
    intro.textContent = mode === 'click' ? 'Click a position, or outside to cancel.' : 'Drag or click to arrange your shortcuts.'
    controller.hidden = false
    controller.setAttribute('aria-label', `Moving ${viewLabel(view)}. Escape cancels.`)
    controller.focus({ preventScroll: true })
    if (mode !== 'keyboard') {
      ghost.innerHTML = `${GRIP}<span>${viewLabel(view)}</span>`
      document.body.append(ghost)
      positionGhost()
      if (pointer !== null) section.setPointerCapture(pointer)
    }
    renderPreview()
    announce(mode === 'click' ? `${viewLabel(view)} picked up. Click in either area to place. Escape cancels.` : `${viewLabel(view)} picked up. Up and Down arrange, Left chooses top bar, Right chooses menu, Enter drops, Escape cancels.`)
  }
  function clearPickup(): Pickup | null {
    const previous = pickup
    pickup = null; pending = null
    cancelAnimationFrame(scrollFrame)
    controller.hidden = true
    ghost.remove()
    section.classList.remove('st-navigation-held')
    intro.textContent = 'Drag or click to arrange your shortcuts.'
    if (previous?.pointer !== null && previous?.pointer !== undefined && section.hasPointerCapture(previous.pointer)) section.releasePointerCapture(previous.pointer)
    return previous
  }
  function cancel(focus = true, message = 'Navigation move cancelled.'): void {
    const previous = clearPickup()
    if (!previous) return
    renderLists()
    announce(message)
    if (focus) focusView(previous.view, previous.source)
  }
  function finish(): void {
    if (!pickup?.target) { cancel(); return }
    const previous = clearPickup()!
    const next = placeNavigation(previous.preferences, previous.view, previous.source, previous.target!, previous.index)
    renderLists()
    if (next === previous.preferences) {
      announce(`${viewLabel(previous.view)} is already in that position.`)
      focusView(previous.view, previous.target)
      return
    }
    const success = save(next, `${viewLabel(previous.view)} placed in ${surfaceName(previous.target!)}, position ${previous.index + 1}.`)
    focusView(previous.view, success ? previous.target : previous.source)
  }
  function hitTarget(x: number, y: number): { surface: NavigationSurface; index: number } | null {
    if (!pickup) return null
    const viewport = body().getBoundingClientRect()
    if (x < viewport.left || x >= viewport.right || y < viewport.top || y >= viewport.bottom) return null
    const hit = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-list]')
    if (!hit || !section.contains(hit)) return null
    const surface = hit.dataset.list as NavigationSurface
    const rows = [...hit.querySelectorAll<HTMLElement>('.st-navigation-row')].filter(row => row.dataset.row !== `${surface}-${pickup!.view}`)
    const gap = hit.querySelector<HTMLElement>('.st-navigation-gap')?.getBoundingClientRect()
    if (gap && y >= gap.top && y < gap.bottom) return { surface, index: pickup.index }
    const box = hit.getBoundingClientRect()
    const index = rows.findIndex(row => y < box.top + row.offsetTop + row.offsetHeight / 2)
    return { surface, index: index < 0 ? rows.length : index }
  }
  function track(x: number, y: number): void {
    if (!pickup) return
    pickup.x = x; pickup.y = y
    positionGhost()
    const target = hitTarget(x, y)
    const surface = target?.surface ?? null
    const length = surface ? navigationViews(pickup.preferences, surface).filter(item => item.key !== pickup!.view).length : 0
    const index = Math.min(target?.index ?? 0, length)
    if (surface !== pickup.target || index !== pickup.index) {
      pickup.target = surface; pickup.index = index
      renderPreview()
    }
  }
  function autoScroll(): void {
    if (pickup?.mode !== 'pointer') return
    const viewport = body().getBoundingClientRect()
    if (pickup.x >= viewport.left && pickup.x < viewport.right) {
      const delta = pickup.y < viewport.top + 48 ? -12 : pickup.y > viewport.bottom - 48 ? 12 : 0
      if (delta) { body().scrollTop += delta; track(pickup.x, pickup.y) }
    }
    scrollFrame = requestAnimationFrame(autoScroll)
  }
  section.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0 || pickup) return
    suppressClick = false
    const button = (event.target as Element).closest<HTMLElement>('[data-pickup]')
    if (!button) return
    pending = { view: button.dataset.pickup as ViewName, source: button.dataset.source === 'palette' ? null : button.dataset.source as NavigationSurface, pointer: event.pointerId, x: event.clientX, y: event.clientY }
  })
  document.addEventListener('pointermove', event => {
    if (pending?.pointer === event.pointerId && !pickup && Math.hypot(event.clientX - pending.x, event.clientY - pending.y) >= 5) {
      begin(pending.view, pending.source, 'pointer', event.clientX, event.clientY, event.pointerId)
      suppressClick = true
      scrollFrame = requestAnimationFrame(autoScroll)
    }
    if (pickup?.mode === 'click' || pickup?.pointer === event.pointerId) { event.preventDefault(); track(event.clientX, event.clientY) }
  }, { passive: false })
  document.addEventListener('pointerup', event => {
    if (pickup?.mode === 'pointer' && pickup.pointer === event.pointerId) { track(event.clientX, event.clientY); finish() }
    pending = null
    setTimeout(() => { suppressClick = false }, 0)
  })
  const pointerCancelled = (event: Event) => {
    const id = (event as PointerEvent).pointerId
    if (pending?.pointer === id) pending = null
    if (pickup?.pointer === id) cancel()
  }
  section.addEventListener('lostpointercapture', event => { if (event.target === section) pointerCancelled(event) })
  document.addEventListener('pointercancel', pointerCancelled)
  document.addEventListener('click', event => {
    if (pickup?.mode === 'click' && !event.composedPath().includes(section)) cancel(false)
  })
  section.addEventListener('click', event => {
    if (suppressClick && event.detail !== 0) { event.preventDefault(); return }
    const button = (event.target as Element).closest<HTMLButtonElement>('button')
    if (pickup?.mode === 'click' && !button?.hasAttribute('data-reset') && !button?.dataset.remove) { track(event.clientX, event.clientY); finish(); return }
    if (!button) return
    if (button.hasAttribute('data-reset')) { cancel(false); save(defaultNavigation(), 'Navigation reset.'); button.focus(); return }
    const view = (button.dataset.remove ?? button.dataset.pickup ?? adding) as ViewName | null
    if (!view) return
    if (button.dataset.remove) {
      cancel(false)
      const surface = button.dataset.surface as NavigationSurface
      const preferences = getNavigation(), items = navigationViews(preferences, surface), index = items.findIndex(item => item.key === view)
      const success = save({ ...preferences, [view]: { ...preferences[view], [surface]: false } }, `${viewLabel(view)} removed from ${surfaceName(surface)}.`)
      if (!success) section.querySelector<HTMLElement>(`[data-navigation-focus="remove-${surface}-${view}"]`)?.focus({ preventScroll: true })
      else focusView(items[index + 1]?.key ?? items[index - 1]?.key ?? view, items.length === 1 ? null : surface)
    } else if (button.dataset.add) {
      const surface = button.dataset.add as NavigationSurface, preferences = getNavigation()
      if (preferences[view][surface]) return
      const success = save(placeNavigation(preferences, view, null, surface, navigationViews(preferences, surface).length), `${viewLabel(view)} added to ${surfaceName(surface)}.`)
      if (success) { adding = null; showChoices(); focusView(view, surface) }
    } else if (button.dataset.source === 'palette') { adding = view; showChoices(); choices.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true }) }
    else begin(view, button.dataset.source as NavigationSurface, event.detail === 0 ? 'keyboard' : 'click', event.clientX, event.clientY)
  })
  section.addEventListener('keydown', event => {
    if (event.key === 'Escape' && pickup) { event.preventDefault(); event.stopPropagation(); cancel(); return }
    if (event.key === 'Tab' && pickup) { cancel(); return }
    if (pickup?.mode === 'keyboard' && event.target !== controller) { cancel(false); return }
    if (pickup?.mode === 'keyboard') {
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', ' ', 'Enter'].includes(event.key)) return
      event.preventDefault()
      if (event.key === ' ' || event.key === 'Enter') { finish(); return }
      const old = `${pickup.target}-${pickup.index}`
      if (event.key === 'ArrowLeft') pickup.target = 'topBar'
      if (event.key === 'ArrowRight') pickup.target = 'menu'
      const length = navigationViews(pickup.preferences, pickup.target!).filter(item => item.key !== pickup!.view).length
      if (event.key === 'ArrowUp') pickup.index--
      if (event.key === 'ArrowDown') pickup.index++
      if (event.key === 'Home') pickup.index = 0
      if (event.key === 'End') pickup.index = length
      pickup.index = Math.max(0, Math.min(length, pickup.index))
      renderPreview()
      if (old !== `${pickup.target}-${pickup.index}`) announce(`${viewLabel(pickup.view)}, position ${pickup.index + 1} in ${surfaceName(pickup.target!)}.`)
      return
    }
    const handle = (event.target as Element).closest<HTMLElement>('.st-navigation-handle')
    if (handle && (event.key === ' ' || event.key === 'Enter')) {
      event.preventDefault()
      begin(handle.dataset.pickup as ViewName, handle.dataset.source as NavigationSurface, 'keyboard')
    }
  })
  const external = () => { pending = null; if (pickup) cancel(true, 'Navigation changed in another tab. Move cancelled.'); sync() }
  window.addEventListener(NAVIGATION_CHANGED, external)
  window.addEventListener('storage', event => { if (event.key === NAVIGATION_KEY || event.key === null) external() })
  window.addEventListener('poise:settings-closed', () => cancel(false))
  window.addEventListener('poise:settings-section-changed', () => { if (section.hidden) cancel(false) })
  window.addEventListener('blur', () => cancel(false))
  window.addEventListener('resize', () => cancel())
  window.addEventListener('beforeprint', () => cancel(false))
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancel(false) })
  const typography = () => [...document.documentElement.style].filter(key => key.startsWith('--typo-') || key === 'font-size' || key === 'font-family').map(key => `${key}:${document.documentElement.style.getPropertyValue(key)}`).join(';')
  let previousTypography = typography()
  new MutationObserver(() => { const next = typography(); if (next !== previousTypography) { previousTypography = next; cancel() } }).observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
  document.fonts.addEventListener('loadingdone', () => cancel())
  sync()
  return section
}
