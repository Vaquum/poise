import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { registered, term } from '../src/ui/registry'

const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name)
  return statSync(path).isDirectory() ? walk(path) : [path]
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

  it('puts the registry’s words on screen', () => {
    expect(term('state.needs-you')).toBe('Needs you')
    expect(term('no.such.key')).toBe('no.such.key')
  })
})
