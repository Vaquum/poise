import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'

// current-view.ts grabs DOM nodes at init, so the pure helper is pulled out
// of a bundled copy rather than importing the view into a node environment.
const SRC = new URL('../src/views/current-view.ts', import.meta.url).pathname

type Helpers = {
  relativeTime: (iso: string) => string
}

async function loadHelpers(): Promise<Helpers> {
  const source = await readFile(SRC, 'utf8')
  const patched = source + `
export const __test = { relativeTime }
`
  const out = await build({
    stdin: { contents: patched, resolveDir: new URL('../src/views', import.meta.url).pathname, loader: 'ts' },
    bundle: true, platform: 'neutral', format: 'esm', write: false, external: ['*.css'],
  })
  // The bundle pulls in src/config.ts, which registers a window listener at
  // module load, and current-view reads localStorage for its persisted filters.
  const store = new Map<string, string>()
  ;(globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
  }
  ;(globalThis as any).window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
    setTimeout: (globalThis as any).setTimeout,
  }
  const encoded = 'data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64')
  return (await import(encoded)).__test
}

const h = await loadHelpers()

// The optimistic issue path coerces missing timestamps with String(), so a
// record without one arrives as the literal "undefined" — which used to
// render as "NaNy" on the card instead of the dash Archive and Swarm show.
describe('relative times stay readable when a timestamp is missing', () => {
  it('renders a dash rather than NaNy for an unparseable timestamp', () => {
    expect(h.relativeTime('undefined')).toBe('—')
    expect(h.relativeTime('')).toBe('—')
    expect(h.relativeTime('not a date')).toBe('—')
  })

  it('leaves valid inputs unchanged', () => {
    expect(h.relativeTime(new Date(Date.now() - 30_000).toISOString())).toBe('30s')
    expect(h.relativeTime(new Date(Date.now() - 90_000).toISOString())).toBe('1m')
    expect(h.relativeTime(new Date(Date.now() - 3 * 3600_000).toISOString())).toBe('3h')
    expect(h.relativeTime(new Date(Date.now() - 3 * 86400_000).toISOString())).toBe('3d')
    expect(h.relativeTime(new Date(Date.now() - 90 * 86400_000).toISOString())).toBe('3mo')
  })
})
