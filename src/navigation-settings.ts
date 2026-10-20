import { defaultNavigation, getNavigation, moveNavigation, navigationViews, NAVIGATION_CHANGED, NAVIGATION_KEY, saveNavigation, VIEW_ITEMS } from './navigation'

const UP = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="m3.5 8.5 3.5-3.5 3.5 3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>'
const DOWN = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="m3.5 5.5 3.5 3.5 3.5-3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>'

export function navigationSection(): HTMLElement {
  const section = document.createElement('section')
  section.className = 'st-tab'
  section.dataset.tab = 'navigation'
  section.hidden = true
  section.innerHTML = `
    <p class="st-help">Choose and arrange your shortcuts. Changes are saved in this browser.</p>
    ${(['menu', 'topBar'] as const).map((surface) => `<div class="tp-section" role="group" aria-label="${surface === 'menu' ? 'Menu shortcuts' : 'Top bar shortcuts'}">
      <div class="tp-group-label">${surface === 'menu' ? 'Menu' : 'Top bar'}</div>
      <ol class="st-navigation-list" data-list="${surface}"></ol>
      <select class="st-select st-navigation-add" data-add="${surface}" aria-label="Add view to ${surface === 'menu' ? 'menu' : 'top bar'}"></select>
    </div>`).join('')}
    <div class="st-row"><button type="button" class="st-clear" data-reset>Reset navigation</button></div>
    <p class="st-help st-navigation-status" role="status" aria-live="polite" aria-atomic="true"></p>`
  const status = section.querySelector<HTMLElement>('[role="status"]')!
  function sync(): void {
    const focusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const active = focusedElement?.dataset.navigationFocus
    const adding = focusedElement instanceof HTMLSelectElement ? focusedElement.dataset.add : undefined
    const preferences = getNavigation()
    for (const surface of ['menu', 'topBar'] as const) {
      const name = surface === 'menu' ? 'menu' : 'top bar'
      const views = navigationViews(preferences, surface)
      section.querySelector(`[data-list="${surface}"]`)!.innerHTML = views.map(({ key, label }, index) => `<li class="st-navigation-row">
        <label class="st-navigation-choice"><input type="checkbox" checked data-view="${key}" data-surface="${surface}" data-navigation-focus="${surface}-${key}-visibility" aria-label="${label} in ${name}" />${label}</label>
        <button type="button" class="st-navigation-move" data-view="${key}" data-surface="${surface}" data-move="up" data-navigation-focus="${surface}-${key}-up" aria-label="Move ${label} up in ${name}" ${index === 0 ? 'disabled' : ''}>${UP}</button>
        <button type="button" class="st-navigation-move" data-view="${key}" data-surface="${surface}" data-move="down" data-navigation-focus="${surface}-${key}-down" aria-label="Move ${label} down in ${name}" ${index === views.length - 1 ? 'disabled' : ''}>${DOWN}</button>
      </li>`).join('')
      const add = section.querySelector<HTMLSelectElement>(`[data-add="${surface}"]`)!
      const available = VIEW_ITEMS.filter(({ key }) => !preferences[key][surface])
      add.innerHTML = `<option value="">Add a view…</option>${available.map(({ key, label }) => `<option value="${key}">${label}</option>`).join('')}`
      add.hidden = available.length === 0
      if (adding === surface && add.hidden) section.querySelector<HTMLElement>(`[data-list="${surface}"] li:last-child input`)?.focus({ preventScroll: true })
    }
    if (active) {
      const control = section.querySelector<HTMLElement>(`[data-navigation-focus="${CSS.escape(active)}"]`)
      const enabled = control && !control.matches(':disabled') ? control : control?.closest('li')?.querySelector('input')
      // Removing a shortcut leaves focus on its surface's Add control.
      const surface = active.startsWith('menu-') ? 'menu' : 'topBar'
      const target = enabled ?? section.querySelector<HTMLSelectElement>(`[data-add="${surface}"]`)
      target?.focus({ preventScroll: true })
    }
  }
  function save(preferences: ReturnType<typeof getNavigation>, message = ''): void {
    try {
      saveNavigation(preferences)
      status.classList.remove('st-help-error')
      status.textContent = message
    } catch (error) {
      sync()
      status.classList.add('st-help-error')
      status.textContent = `Navigation was not saved: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  section.addEventListener('change', (event) => {
    const input = event.target
    if (!(input instanceof HTMLInputElement || input instanceof HTMLSelectElement)) return
    const surface = input instanceof HTMLSelectElement ? input.dataset.add : input.dataset.surface
    const view = VIEW_ITEMS.find(({ key }) => key === (input instanceof HTMLSelectElement ? input.value : input.dataset.view))
    if (!view || (surface !== 'menu' && surface !== 'topBar')) return
    const preferences = getNavigation()
    preferences[view.key][surface] = input instanceof HTMLSelectElement || input.checked
    if (preferences[view.key][surface]) preferences[`${surface}Order`] = [...preferences[`${surface}Order`].filter((key) => key !== view.key), view.key]
    save(preferences)
  })
  section.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-move]')
    const view = VIEW_ITEMS.find(({ key }) => key === button?.dataset.view)
    const surface = button?.dataset.surface
    if (!button || !view || (surface !== 'menu' && surface !== 'topBar')) return
    const preferences = moveNavigation(getNavigation(), surface, view.key, button.dataset.move === 'up' ? -1 : 1)
    const position = navigationViews(preferences, surface).findIndex(({ key }) => key === view.key) + 1
    save(preferences, `${view.label} moved to position ${position} in ${surface === 'menu' ? 'menu' : 'top bar'}.`)
  })
  section.querySelector('[data-reset]')!.addEventListener('click', () => save(defaultNavigation(), 'Navigation reset.'))
  window.addEventListener(NAVIGATION_CHANGED, sync)
  window.addEventListener('storage', (event) => { if (event.key === NAVIGATION_KEY || event.key === null) sync() })
  sync()
  return section
}
