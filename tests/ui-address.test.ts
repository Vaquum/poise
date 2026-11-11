import { describe, expect, it } from 'vitest'
import { placeHref, readAddress } from '../src/ui/address'

const read = (search: string) => {
  const { address, query } = readAddress(search)
  return { ...address, query: query.toString() }
}

describe('the new interface reads its addresses', () => {
  it('opens Overview by default and for names that are not places', () => {
    expect(read('')).toMatchObject({ place: 'overview', query: 'view=overview' })
    expect(read('?view=swarm')).toMatchObject({ place: 'overview' })
  })

  it('opens each place by name', () => {
    expect(read('?view=board').place).toBe('board')
    expect(read('?view=manager').place).toBe('manager')
  })

  it('maps Logging links onto Observe → Logging, keeping the diagnostic and interval', () => {
    expect(read('?view=logging&event=evt_1&from=2026-11-10T00:00:00Z&to=2026-11-11T00:00:00Z')).toEqual({
      place: 'observe', part: 'logging', section: null, back: null, item: null,
      query: 'view=observe&event=evt_1&from=2026-11-10T00%3A00%3A00Z&to=2026-11-11T00%3A00%3A00Z&part=logging',
    })
    expect(read('?view=logging&incident=inc_2').part).toBe('logging')
  })

  it('maps a chain journal at a step onto Observe → Tasks', () => {
    expect(read('?view=logging&chain=c1&after=4')).toMatchObject({ place: 'observe', part: 'tasks', query: 'view=observe&chain=c1&after=4&part=tasks' })
  })

  it('opens the Settings sections the service links to', () => {
    expect(read('?settings=accounts')).toMatchObject({ place: 'settings', section: 'accounts' })
    expect(read('?settings=link')).toMatchObject({ place: 'settings', section: 'link' })
    expect(read('?settings=admin')).toMatchObject({ place: 'settings', section: 'admin' })
    expect(read('?settings=nonsense')).toMatchObject({ place: 'overview', section: null })
  })

  it('accepts only a place as the route back', () => {
    expect(read('?view=settings&back=board').back).toBe('board')
    expect(read('?view=settings&back=https://example.com').back).toBeNull()
    expect(read('?view=board&back=board').back).toBeNull()
  })

  it('opens an item only on Board and Observe', () => {
    expect(read('?view=board&item=acme/site%2312').item).toBe('acme/site#12')
    expect(read('?view=observe&part=github&item=acme/site%2312').item).toBe('acme/site#12')
    expect(read('?view=chat&item=acme/site%2312').item).toBeNull()
    expect(read('?view=board&item=not-an-item').item).toBeNull()
  })

  it('writes links with the place first', () => {
    expect(placeHref('settings', { settings: 'style', back: 'board', empty: '' })).toBe('?view=settings&settings=style&back=board')
  })
})
