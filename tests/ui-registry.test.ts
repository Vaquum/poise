import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { register, registered, term, type Registry } from '../src/ui/registry'

const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name)
  return statSync(path).isDirectory() ? walk(path) : [path]
})

// A place's words load with the place. Here every registry module is loaded:
// those beside the shared one in src/ui/registry/, and any registry.ts under
// src/ui/places/. A module registers its entries itself or exports them.
const isRegistry = (value: unknown): value is Registry => !!value && typeof value === 'object' && !Array.isArray(value)
  && Object.values(value).length > 0 && Object.values(value).every((d) => !!d && typeof d === 'object' && typeof (d as { name?: unknown }).name === 'string')

beforeAll(async () => {
  const modules = walk('src/ui').filter((f) => f.endsWith('.ts') && (
    (dirname(f) === join('src', 'ui', 'registry') && !['index.ts', 'types.ts', 'shared.ts'].includes(basename(f)))
    || (f.startsWith(join('src', 'ui', 'places') + sep) && basename(f) === 'registry.ts')))
  for (const file of modules) {
    const module = await import(resolve(file)) as Record<string, unknown>
    for (const value of Object.values(module)) if (isRegistry(value)) register(value)
  }
})

describe('the new interface has one vocabulary', () => {
  it('names and explains every entry', () => {
    const missing = Object.entries(registered()).filter(([, d]) => !d.name || !(d.what || d.does)).map(([key]) => key)
    expect(missing).toEqual([])
  })

  it('explains every element the interface marks for the reference', () => {
    const keys = new Set<string>()
    for (const file of walk('src/ui').filter((f) => f.endsWith('.ts'))) {
      for (const [, key] of readFileSync(file, 'utf8').matchAll(/data-ref="([\w.-]+)"/g)) keys.add(key)
    }
    expect([...keys].filter((key) => !registered()[key])).toEqual([])
  })

  // A row is a key, perhaps a ref, then its group, on one line or several; its reference is the ref or set.<key>.
  it('explains every Settings row, keyed by its ref or by set.<its key>', () => {
    const keys = new Set<string>()
    for (const file of walk(join('src', 'ui', 'places', 'settings')).filter((f) => f.endsWith('.ts'))) {
      for (const [, key, ref] of readFileSync(file, 'utf8').matchAll(/\{\s*key: '([\w.-]+)',(?:\s*ref: '([\w.-]+)',)?\s*group:/g)) keys.add(ref || `set.${key}`)
    }
    expect(keys.size).toBeGreaterThan(20)
    expect(keys).toContain('set.models.slots')
    expect([...keys].filter((key) => !registered()[key])).toEqual([])
  })

  it('puts the registry’s words on screen', () => {
    expect(term('state.needs-you')).toBe('Needs you')
    expect(term('no.such.key')).toBe('no.such.key')
  })
})
