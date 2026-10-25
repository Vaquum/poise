import { mkdir, mkdtemp, writeFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The summary measurement must read wide directories incrementally: one
// readdir call would load and queue every child before either budget is
// checked again. The spy fails the test on exactly that shape.

const { readdirSizes } = vi.hoisted(() => ({ readdirSizes: [] as number[] }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  const readdir = original.readdir as (...args: any[]) => Promise<any[]>
  return {
    ...original,
    readdir: async (...args: any[]) => {
      const names = await readdir(...args)
      readdirSizes.push(names.length)
      return names
    },
  }
})

let root = ''
let maintenance: typeof import('../server/storage-maintenance')

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'poise-storage-wide-dir-')))
  vi.resetModules()
  maintenance = await import('../server/storage-maintenance')
})

afterEach(async () => {
  vi.resetModules()
  await rm(root, { recursive: true, force: true })
})

describe('wide directory reads', () => {
  it('measures a wide directory without one unbounded readdir', async () => {
    const wide = join(root, 'wide')
    await mkdir(wide, { recursive: true })
    for (let i = 0; i < 500; i++) await writeFile(join(wide, `file-${i}.bin`), 'x'.repeat(64))
    readdirSizes.length = 0
    const measured = await maintenance.measureDir(wide)
    expect(measured.status).toBe('ok')
    expect(measured.bytes).toBeGreaterThan(0)
    expect(readdirSizes).toEqual([])
  })

  it('stops a wide directory at the entry budget', async () => {
    const wide = join(root, 'wide')
    await mkdir(wide, { recursive: true })
    for (let i = 0; i < 500; i++) await writeFile(join(wide, `file-${i}.bin`), 'x'.repeat(64))
    const measured = await maintenance.measureDir(wide, { maxEntries: 100 })
    expect(measured.status).toBe('partial')
    expect(measured.entries).toBeLessThanOrEqual(100 + 64)
    expect(measured.bytes).toBeGreaterThan(0)
  })
})
