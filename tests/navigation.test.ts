import { describe, expect, it } from 'vitest'
import { defaultNavigation, moveNavigation, navigationViews, parseNavigation, placeNavigation } from '../src/navigation'

describe('navigation preferences', () => {
  it('preserves the existing menu and top bar by default', () => {
    const preferences = defaultNavigation()
    expect(navigationViews(preferences, 'menu').map(({ key }) => key)).toEqual(['analytics', 'logging', 'extensions'])
    expect(navigationViews(preferences, 'topBar').map(({ key }) => key)).toEqual(['current', 'swarm', 'chat', 'main', 'behaviors', 'snippets', 'editor'])
  })

  it('places Extensions in the menu, not the top bar, for preferences saved before it existed', () => {
    const saved = { ...Object.fromEntries(['current', 'swarm', 'chat', 'main', 'behaviors', 'snippets', 'editor', 'analytics', 'logging'].map((key) => [key, { menu: key === 'logging', topBar: key !== 'logging' }])), menuOrder: ['logging'], topBarOrder: ['current'] }
    const preferences = parseNavigation(saved)
    expect(preferences.extensions).toEqual({ menu: true, topBar: false })
    expect(navigationViews(preferences, 'menu').map(({ key }) => key)).toEqual(['logging', 'extensions'])
    expect(navigationViews(preferences, 'topBar').some(({ key }) => key === 'extensions')).toBe(false)
  })

  it('accepts both, neither and either surface, keeping defaults for newly introduced views', () => {
    expect(parseNavigation({ current: { menu: true, topBar: true }, chat: { menu: false, topBar: false }, analytics: { menu: false, topBar: true } })).toEqual({
      ...defaultNavigation(), current: { menu: true, topBar: true }, chat: { menu: false, topBar: false }, analytics: { menu: false, topBar: true },
    })
  })

  it('rejects invalid saved state with a recovery destination', () => {
    for (const value of [null, [], 'current', { current: null }, { current: { menu: 'true', topBar: true } }, { current: { menu: false } }, { menuOrder: ['chat', 'chat'] }, { topBarOrder: ['missing'] }, { menuOrder: null }]) {
      expect(() => parseNavigation(value)).toThrow('Settings → Navigation')
    }
  })
  it('restores orders and appends newly introduced views without changing saved positions', () => {
    const preferences = parseNavigation({ menuOrder: ['logging', 'analytics'], topBarOrder: ['chat', 'current'] })
    expect(navigationViews(preferences, 'menu').map(({ key }) => key)).toEqual(['logging', 'analytics', 'extensions'])
    expect(navigationViews(preferences, 'topBar').map(({ key }) => key)).toEqual(['chat', 'current', 'swarm', 'main', 'behaviors', 'snippets', 'editor'])
    expect(parseNavigation({})).toEqual(defaultNavigation())
  })

  it('moves adjacent visible shortcuts independently without mutating the prior preferences', () => {
    const original = defaultNavigation()
    original.swarm.topBar = false
    const moved = moveNavigation(original, 'topBar', 'chat', -1)
    expect(navigationViews(moved, 'topBar').map(({ key }) => key)).toEqual(['chat', 'current', 'main', 'behaviors', 'snippets', 'editor'])
    expect(moved.menuOrder).toEqual(original.menuOrder)
    expect(original.topBarOrder[0]).toBe('current')
    expect(moveNavigation(moved, 'topBar', 'chat', -1)).toEqual(moved)
    expect(moveNavigation(moved, 'topBar', 'editor', 1)).toEqual(moved)
    expect(moveNavigation(moved, 'topBar', 'swarm', 1)).toEqual(moved)
  })

  it('inserts at visible boundaries while retaining hidden keys and leaving the input untouched', () => {
    const original = defaultNavigation()
    original.swarm.topBar = false
    const before = structuredClone(original)
    const moved = placeNavigation(original, 'chat', 'topBar', 'topBar', 0)
    expect(navigationViews(moved, 'topBar').map(v => v.key)).toEqual(['chat', 'current', 'main', 'behaviors', 'snippets', 'editor'])
    expect(moved.topBarOrder).toContain('swarm')
    expect(moved.menuOrder).toEqual(original.menuOrder)
    expect(original).toEqual(before)
    expect(navigationViews(placeNavigation(moved, 'chat', 'topBar', 'topBar', 99), 'topBar').at(-1)?.key).toBe('chat')
    expect(navigationViews(placeNavigation(moved, 'editor', 'topBar', 'topBar', 2), 'topBar')[2].key).toBe('editor')
  })

  it('moves across surfaces atomically, merging an existing destination copy without duplicates', () => {
    const original = defaultNavigation()
    original.current.menu = true
    const moved = placeNavigation(original, 'current', 'topBar', 'menu', 0)
    expect(moved.current).toEqual({ menu: true, topBar: false })
    expect(navigationViews(moved, 'menu').map(v => v.key)).toEqual(['current', 'analytics', 'logging', 'extensions'])
    expect(navigationViews(moved, 'topBar').some(v => v.key === 'current')).toBe(false)
    expect(moved.menuOrder.filter(key => key === 'current')).toHaveLength(1)
    const reverse = placeNavigation(moved, 'logging', 'menu', 'topBar', 1)
    expect(reverse.logging).toEqual({ menu: false, topBar: true })
    expect(navigationViews(reverse, 'topBar')[1].key).toBe('logging')
    expect(original.current.topBar).toBe(true)
  })

  it('copies to both or empty surfaces, repositions existing copies and preserves no-op identity', () => {
    const original = defaultNavigation()
    const copied = placeNavigation(original, 'current', null, 'menu', 1)
    expect(copied.current).toEqual({ menu: true, topBar: true })
    expect(navigationViews(copied, 'menu').map(v => v.key)).toEqual(['analytics', 'current', 'logging', 'extensions'])
    expect(placeNavigation(copied, 'current', null, 'menu', 1)).toBe(copied)
    expect(placeNavigation(copied, 'current', 'menu', 'menu', 1)).toBe(copied)
    expect(navigationViews(placeNavigation(copied, 'current', null, 'menu', 0), 'menu')[0].key).toBe('current')
    for (const view of Object.values(original)) if (typeof view === 'object' && !Array.isArray(view)) view.menu = false
    expect(navigationViews(placeNavigation(original, 'chat', null, 'menu', 5), 'menu').map(v => v.key)).toEqual(['chat'])
    expect(() => placeNavigation(original, 'analytics', 'menu', 'topBar', 0)).toThrow('hidden')
    expect(() => placeNavigation(original, 'chat', null, 'menu', NaN)).toThrow('integer')
    expect(parseNavigation(copied)).toEqual(copied)
  })
})
