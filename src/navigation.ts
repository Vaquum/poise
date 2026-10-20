import { noticeFeed } from './notices'

export const NAVIGATION_KEY = 'poise-navigation'
export const NAVIGATION_CHANGED = 'poise:navigation-changed'
export const VIEW_ITEMS = [
  { key: 'current', label: 'Current' },
  { key: 'swarm', label: 'Swarm' },
  { key: 'chat', label: 'Chat' },
  { key: 'main', label: 'Archive' },
  { key: 'behaviors', label: 'Behaviors' },
  { key: 'snippets', label: 'Snippets' },
  { key: 'editor', label: 'Editor' },
  { key: 'analytics', label: 'Analytics' },
  { key: 'logging', label: 'Logging' },
] as const
export type ViewName = typeof VIEW_ITEMS[number]['key']
export type NavigationPlacement = { menu: boolean, topBar: boolean }
export type NavigationSurface = keyof NavigationPlacement
export type NavigationPreferences = Record<ViewName, NavigationPlacement> & { menuOrder: ViewName[], topBarOrder: ViewName[] }

export function defaultNavigation(): NavigationPreferences {
  return { ...Object.fromEntries(VIEW_ITEMS.map(({ key }) => [key, {
    menu: key === 'analytics' || key === 'logging',
    topBar: key !== 'analytics' && key !== 'logging',
  }])), menuOrder: ['analytics', 'logging', ...VIEW_ITEMS.map(({ key }) => key).filter((key) => key !== 'analytics' && key !== 'logging')],
  topBarOrder: VIEW_ITEMS.map(({ key }) => key) } as NavigationPreferences
}

export function parseNavigation(value: unknown): NavigationPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Saved navigation must be an object. Reset it in Settings → Navigation.')
  const saved = value as Record<string, unknown>
  const preferences = defaultNavigation()
  for (const { key } of VIEW_ITEMS) {
    if (!(key in saved)) continue // New views retain their default placement.
    const placement = saved[key]
    if (!placement || typeof placement !== 'object' || !('menu' in placement) || !('topBar' in placement)
      || typeof placement.menu !== 'boolean' || typeof placement.topBar !== 'boolean') {
      throw new Error(`Saved navigation for ${key} is invalid. Reset it in Settings → Navigation.`)
    }
    preferences[key] = { menu: placement.menu, topBar: placement.topBar }
  }
  for (const surface of ['menu', 'topBar'] as const) {
    const field = `${surface}Order` as const
    const order = saved[field]
    if (order === undefined) continue
    if (!Array.isArray(order) || !order.every((key): key is ViewName => VIEW_ITEMS.some((view) => view.key === key)) || new Set(order).size !== order.length) {
      throw new Error(`Saved ${surface} order is invalid. Reset it in Settings → Navigation.`)
    }
    preferences[field] = [...order, ...preferences[field].filter((key) => !order.includes(key))]
  }
  return preferences
}

export function navigationViews(preferences: NavigationPreferences, surface: NavigationSurface): typeof VIEW_ITEMS[number][] {
  return preferences[`${surface}Order`].filter((key) => preferences[key][surface]).map((key) => VIEW_ITEMS.find((view) => view.key === key)!)
}

export function moveNavigation(preferences: NavigationPreferences, surface: NavigationSurface, view: ViewName, direction: -1 | 1): NavigationPreferences {
  const visible = navigationViews(preferences, surface).map(({ key }) => key)
  const index = visible.indexOf(view)
  const target = visible[index + direction]
  if (index < 0 || target === undefined) return preferences
  const order = [...preferences[`${surface}Order`]]
  const from = order.indexOf(view)
  const to = order.indexOf(target)
  const moved = order[from]
  order[from] = order[to]
  order[to] = moved
  return { ...preferences, [`${surface}Order`]: order }
}

/** One placement transaction; source=null copies from the reusable view palette. */
export function placeNavigation(preferences: NavigationPreferences, view: ViewName, source: NavigationSurface | null, target: NavigationSurface, index: number): NavigationPreferences {
  if (!Number.isInteger(index)) throw new Error('Navigation position must be an integer.')
  if (source && !preferences[view][source]) throw new Error(`Cannot move a hidden ${view} shortcut.`)
  const visible = navigationViews(preferences, target).map(({ key }) => key)
  const next = visible.filter((key) => key !== view)
  const position = Math.max(0, Math.min(index, next.length))
  next.splice(position, 0, view)
  const removesSource = source !== null && source !== target
  if (!removesSource && preferences[view][target] && visible.every((key, i) => key === next[i])) return preferences
  const field = `${target}Order` as const
  const order = preferences[field].filter((key) => key !== view)
  const anchor = next[position + 1]
  order.splice(anchor ? order.indexOf(anchor) : order.length, 0, view)
  return { ...preferences, [field]: order, [view]: { ...preferences[view], [target]: true, ...(removesSource ? { [source!]: false } : {}) } }
}

export function getNavigation(): NavigationPreferences {
  try {
    const saved = localStorage.getItem(NAVIGATION_KEY)
    const preferences = saved === null ? defaultNavigation() : parseNavigation(JSON.parse(saved))
    noticeFeed.reportReadErrors('navigation', [])
    return preferences
  } catch (error) {
    noticeFeed.reportReadErrors('navigation', [{ key: 'navigation', title: 'Navigation preferences could not be read', body: `${error instanceof Error ? error.message : String(error)} Showing the default layout.` }])
    return defaultNavigation()
  }
}

export function saveNavigation(preferences: NavigationPreferences): void {
  localStorage.setItem(NAVIGATION_KEY, JSON.stringify(parseNavigation(preferences)))
  window.dispatchEvent(new CustomEvent(NAVIGATION_CHANGED))
}
