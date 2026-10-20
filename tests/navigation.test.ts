import { describe, expect, it } from 'vitest'
import { defaultNavigation, moveNavigation, navigationViews, parseNavigation } from '../src/navigation'

describe('navigation preferences', () => {
  it('preserves the existing menu and top bar by default', () => {
    const preferences = defaultNavigation()
    expect(navigationViews(preferences, 'menu').map(({ key }) => key)).toEqual(['analytics', 'logging'])
    expect(navigationViews(preferences, 'topBar').map(({ key }) => key)).toEqual(['current', 'swarm', 'chat', 'main', 'behaviors', 'snippets', 'editor'])
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
    expect(navigationViews(preferences, 'menu').map(({ key }) => key)).toEqual(['logging', 'analytics'])
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
})
