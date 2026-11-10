// Retention rules for Swarm's unreadable-records checkpoint
// (src/swarm-records.ts): what a read proves about known rows.

import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  SWARM_RECORDS_CHECKPOINT_LIMIT,
  loadRecordsCheckpoints,
  retainQuarantineIds,
  saveRecordsCheckpoints,
} from '../src/swarm-records'

describe('retained quarantine identities', () => {
  it('adds unseen rows on a partial read and never forgets', () => {
    expect(retainQuarantineIds(['a', 'b'], ['b', 'c'], false)).toEqual(['a', 'b', 'c'])
    expect(retainQuarantineIds(['a', 'b'], [], false)).toEqual(['a', 'b'])
  })

  it('forgets rows a complete read no longer carries', () => {
    expect(retainQuarantineIds(['a', 'b'], ['b', 'c'], true)).toEqual(['b', 'c'])
    expect(retainQuarantineIds(['a', 'b'], [], true)).toEqual([])
  })

  it('evicts rows absent from the current read before present ones', () => {
    const previous = Array.from({ length: SWARM_RECORDS_CHECKPOINT_LIMIT }, (_, index) => `old-${index}`)
    const fresh = ['new-1', 'new-2']
    const ids = retainQuarantineIds(previous, fresh, false)
    expect(ids).toHaveLength(SWARM_RECORDS_CHECKPOINT_LIMIT)
    expect(ids.slice(-2)).toEqual(fresh)
    // The evicted two are the oldest absent rows, never the rows on screen.
    expect(ids).not.toContain('old-0')
    expect(ids).not.toContain('old-1')
    expect(ids).toContain('old-2')
  })

  it('keeps the newest present rows when one read exceeds the cap', () => {
    const fresh = Array.from({ length: SWARM_RECORDS_CHECKPOINT_LIMIT + 10 }, (_, index) => `row-${index}`)
    const ids = retainQuarantineIds([], fresh, true)
    expect(ids).toHaveLength(SWARM_RECORDS_CHECKPOINT_LIMIT)
    expect(ids[0]).toBe('row-10')
  })
})

describe('checkpoint storage', () => {
  const store = new Map<string, string>()
  beforeEach(() => {
    store.clear()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value) },
      removeItem: (key: string) => { store.delete(key) },
    })
  })

  it('round-trips per-organization checkpoints and skips malformed entries', () => {
    saveRecordsCheckpoints({
      acme: { ids: ['a'], since: 's', due: 'd', dismissed: true, body: 'b' },
    })
    store.set('poise:swarm-quarantine:v1', JSON.stringify({
      acme: { ids: ['a'], since: 's', due: 'd', dismissed: true, body: 'b' },
      beta: { ids: 'nope' },
    }))
    expect(loadRecordsCheckpoints()).toEqual({
      acme: { ids: ['a'], since: 's', due: 'd', dismissed: true, body: 'b' },
    })
  })

  it('starts empty on missing or unreadable storage', () => {
    expect(loadRecordsCheckpoints()).toEqual({})
    store.set('poise:swarm-quarantine:v1', '{nope')
    expect(loadRecordsCheckpoints()).toEqual({})
    store.set('poise:swarm-quarantine:v1', '[]')
    expect(loadRecordsCheckpoints()).toEqual({})
  })

  it('reads hostile organization names as absent and writes them as plain data', () => {
    const loaded = loadRecordsCheckpoints()
    expect(Object.getPrototypeOf(loaded)).toBeNull()
    expect(loaded['constructor']).toBeUndefined()
    expect(loaded['__proto__']).toBeUndefined()
    const entry = { ids: ['a'], since: 's', due: 'd', dismissed: false, body: 'b' }
    const hostileJson = `{"constructor":${JSON.stringify(entry)},"__proto__":${JSON.stringify(entry)}}`
    store.set('poise:swarm-quarantine:v1', hostileJson)
    const hostile = loadRecordsCheckpoints()
    expect(hostile['constructor']).toEqual(entry)
    expect(hostile['__proto__']).toEqual(entry)
    expect(Object.hasOwn(hostile, '__proto__')).toBe(true)
    expect(({} as Record<string, unknown>)['ids']).toBeUndefined()
    saveRecordsCheckpoints(hostile)
    expect(loadRecordsCheckpoints()['__proto__']).toEqual(entry)
  })
})
