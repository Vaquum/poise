import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const io = vi.hoisted(() => ({ bytes: 0, opens: 0, active: 0, peak: 0 }))
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args)
    io.opens++; io.active++; io.peak = Math.max(io.peak, io.active)
    const read = vi.spyOn(handle, 'read')
    const close = handle.close.bind(handle)
    vi.spyOn(handle, 'close').mockImplementation(async () => {
      for (const result of read.mock.results) {
        if (result.type === 'return') io.bytes += (await result.value).bytesRead
      }
      io.active--
      await close()
    })
    return handle
  } }
})

let root: string
let editor: typeof import('../server/editor')
const previous = process.env.POISE_EDITOR_DIR
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-discovery-'))
  process.env.POISE_EDITOR_DIR = root
  editor = await import('../server/editor')
})
afterAll(async () => {
  if (previous === undefined) delete process.env.POISE_EDITOR_DIR
  else process.env.POISE_EDITOR_DIR = previous
  await rm(root, { recursive: true, force: true })
})

describe('editor discovery I/O', () => {
  it('reads title prefixes concurrently, reuses summaries, and detects external edits/deletions', async () => {
    const count = 24
    const size = 512 * 1024
    await Promise.all(Array.from({ length: count }, async (_, index) => {
      const path = join(root, `note-${String(index).padStart(2, '0')}.md`)
      await writeFile(path, `# Note ${index}\n${'x'.repeat(size)}`)
      await utimes(path, 1_700_000_000 + index, 1_700_000_000 + index)
    }))
    io.bytes = 0; io.opens = 0; io.peak = 0
    const start = performance.now()
    const first = await editor.listDocs()
    const coldMs = performance.now() - start
    const coldBytes = io.bytes
    for (const doc of first) {
      expect(doc.updated_at).toBe((await stat(join(root, `${doc.slug}.md`))).mtime.toISOString())
    }
    expect(first.map(doc => doc.title)).toEqual(Array.from({ length: count }, (_, index) => `Note ${count - index - 1}`))
    expect(coldBytes).toBeLessThanOrEqual(count * 4096)
    expect(io.peak).toBeGreaterThan(1)
    expect(io.peak).toBeLessThanOrEqual(8)
    const warmStart = performance.now()
    expect(await editor.listDocs()).toEqual(first)
    const warmMs = performance.now() - warmStart
    expect(io.bytes).toBe(coldBytes)
    expect(io.opens).toBe(count)
    // A caller cannot mutate the cached summary.
    first[0].title = 'Corrupted caller data'
    expect((await editor.listDocs())[0].title).toBe('Note 23')
    // Same size and restored mtime: ctime must still invalidate the summary.
    await writeFile(join(root, 'note-00.md'), `# Edit 0\n${'x'.repeat(size)}`)
    await utimes(join(root, 'note-00.md'), 1_700_000_000, 1_700_000_000)
    await unlink(join(root, 'note-01.md'))
    const changed = await editor.listDocs()
    expect(changed.find(doc => doc.slug === 'note-00')?.title).toBe('Edit 0')
    expect(changed.some(doc => doc.slug === 'note-01')).toBe(false)
    console.log(`EDITOR_DISCOVERY ${JSON.stringify({ documents: count, legacyBytes: first.reduce((sum, doc) => sum + doc.size, 0), coldBytes, warmBytes: 0, coldMs, warmMs, peakOpenFiles: io.peak })}`)
  })

  it('preserves title derivation across UTF-8 boundaries, blank prefixes and long first lines', async () => {
    const cases = [
      ['utf8', `${' '.repeat(4094)}€title\nbody`, '€title'],
      ['blank', `${' \n'.repeat(5000)}# **Title** and \`code\`\nbody`, 'Title and code'],
      ['long', `# ${'a'.repeat(9000)}\nbody`, 'a'.repeat(200)],
      ['empty', '', 'Untitled'],
      ['whitespace', ' \n\t\n ', 'Untitled'],
      ['unterminated', '\n# Last line', 'Last line'],
    ] as const
    await Promise.all(cases.map(([slug, content]) => writeFile(join(root, `${slug}.md`), content)))
    const docs = await editor.listDocs()
    for (const [slug, , title] of cases) expect(docs.find(doc => doc.slug === slug)?.title).toBe(title)
  })
})
