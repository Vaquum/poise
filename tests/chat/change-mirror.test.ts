import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureCheckoutSnapshot, compareCheckoutSnapshots, emitCheckoutChanges } from '../../server/chat/change-mirror'
import type { ChatEvent } from '../../server/chat/protocol'

let root: string
let repo: string
function git(...args: string[]) { return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }) }
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-change-mirror-'))
  repo = join(root, 'repo')
  await mkdir(repo)
  git('init', '-q', '-b', 'main')
  git('config', 'core.hooksPath', '/dev/null')
  git('config', 'commit.gpgSign', 'false')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.invalid')
  await writeFile(join(repo, 'base.txt'), 'original\n')
  git('add', 'base.txt'); git('commit', '-q', '-m', 'fixture')
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
const after = (before: Awaited<ReturnType<typeof captureCheckoutSnapshot>>) => captureCheckoutSnapshot(repo, [...before.files.keys()])
const makeNestedRepo = async (name = 'nested') => {
  const nested = join(repo, name)
  await mkdir(nested)
  const nestedGit = (...args: string[]) => execFileSync('git', args, { cwd: nested, encoding: 'utf8' })
  nestedGit('init', '-q', '-b', 'main')
  nestedGit('config', 'core.hooksPath', '/dev/null')
  nestedGit('config', 'commit.gpgSign', 'false')
  nestedGit('config', 'user.name', 'Fixture')
  nestedGit('config', 'user.email', 'fixture@example.invalid')
  await writeFile(join(nested, 'clone.txt'), 'nested work\n')
  nestedGit('add', 'clone.txt'); nestedGit('commit', '-q', '-m', 'nested fixture')
  return nested
}

describe('turn-level checkout change mirror', () => {
  it('records actual pre-turn content rather than HEAD, including untracked edits, additions and deletions', async () => {
    await writeFile(join(repo, 'base.txt'), 'preexisting user work\n')
    await writeFile(join(repo, 'untracked.txt'), 'keep this\n')
    const before = await captureCheckoutSnapshot(repo)
    await writeFile(join(repo, 'base.txt'), 'agent edit\n')
    await rm(join(repo, 'untracked.txt'))
    await writeFile(join(repo, 'new.txt'), 'new file\n')
    const result = compareCheckoutSnapshots(before, await after(before))
    expect(result.warnings).toEqual([])
    expect(result.changes).toEqual([
      { path: 'base.txt', oldText: 'preexisting user work\n', newText: 'agent edit\n', oldExists: true, newExists: true },
      { path: 'new.txt', oldText: '', newText: 'new file\n', oldExists: false, newExists: true },
      { path: 'untracked.txt', oldText: 'keep this\n', newText: '', oldExists: true, newExists: false },
    ])
  })

  it('distinguishes empty existing files from absent files', async () => {
    await writeFile(join(repo, 'empty.txt'), '')
    const before = await captureCheckoutSnapshot(repo)
    await rm(join(repo, 'empty.txt'))
    await writeFile(join(repo, 'created-empty.txt'), '')
    const { changes } = compareCheckoutSnapshots(before, await after(before))
    expect(changes).toContainEqual({ path: 'empty.txt', oldText: '', newText: '', oldExists: true, newExists: false })
    expect(changes).toContainEqual({ path: 'created-empty.txt', oldText: '', newText: '', oldExists: false, newExists: true })
  })

  it('does not invent a nonexistent pre-image when an ignored old file becomes visible', async () => {
    await writeFile(join(repo, '.gitignore'), 'hidden.txt\n')
    await writeFile(join(repo, 'hidden.txt'), 'existing ignored work\n')
    const before = await captureCheckoutSnapshot(repo)
    await writeFile(join(repo, '.gitignore'), '')
    await writeFile(join(repo, 'hidden.txt'), 'changed\n')
    const { changes, warnings } = compareCheckoutSnapshots(before, await after(before))
    expect(changes.some(change => change.path === 'hidden.txt')).toBe(false)
    expect(warnings.join(' ')).toContain('previously ignored file')
  })

  it('includes an explicitly named ignored Editor stage without copying ignored attachments', async () => {
    await writeFile(join(repo, '.gitignore'), '.poise-chat/\n')
    await mkdir(join(repo, '.poise-chat'), { recursive: true })
    await writeFile(join(repo, '.poise-chat', 'document.md'), 'before\n')
    await writeFile(join(repo, '.poise-chat', 'attachment.txt'), 'private upload\n')
    const before = await captureCheckoutSnapshot(repo, ['.poise-chat/document.md'])
    expect(before.files.has('.poise-chat/attachment.txt')).toBe(false)
    await writeFile(join(repo, '.poise-chat', 'document.md'), 'after\n')
    const { changes } = compareCheckoutSnapshots(before, await after(before))
    expect(changes).toContainEqual({ path: '.poise-chat/document.md', oldText: 'before\n', newText: 'after\n', oldExists: true, newExists: true })
  })

  it('refuses to follow symlinks and does not turn an unsafe path into a revertible new file', async () => {
    await writeFile(join(root, 'outside.txt'), 'outside contents')
    await symlink(join(root, 'outside.txt'), join(repo, 'link.txt'))
    const before = await captureCheckoutSnapshot(repo)
    expect(before.files.get('link.txt')?.text).toBeUndefined()
    await rm(join(repo, 'link.txt'))
    await writeFile(join(repo, 'link.txt'), 'now a regular file')
    const { changes, warnings } = compareCheckoutSnapshots(before, await after(before))
    expect(changes.some(change => change.path === 'link.txt')).toBe(false)
    expect(warnings.join(' ')).toContain('not a regular')
  })

  it('reports changed binary and over-limit files instead of exposing a destructive Revert', async () => {
    await writeFile(join(repo, 'binary.dat'), Buffer.from([0, 1, 2]))
    await writeFile(join(repo, 'large.txt'), 'a'.repeat(200))
    const before = await captureCheckoutSnapshot(repo, [], { maxFileBytes: 100 })
    await writeFile(join(repo, 'binary.dat'), Buffer.from([0, 3, 4]))
    await writeFile(join(repo, 'large.txt'), 'b'.repeat(201))
    const next = await captureCheckoutSnapshot(repo, [...before.files.keys()], { maxFileBytes: 100 })
    const { changes, warnings } = compareCheckoutSnapshots(before, next)
    expect(changes).toEqual([])
    expect(warnings.join(' ')).toContain('binary or non-UTF-8')
    expect(warnings.join(' ')).toContain('exceeds 100 bytes')
  })

  it('fails closed on an incomplete file inventory', async () => {
    const before = await captureCheckoutSnapshot(repo, [], { maxFiles: 0 })
    await writeFile(join(repo, 'new.txt'), 'new\n')
    const { changes, warnings } = compareCheckoutSnapshots(before, await captureCheckoutSnapshot(repo))
    expect(changes).toEqual([])
    expect(warnings.join(' ')).toContain('incomplete checkout inventory')
  })

  it('does not report a nested repository created during the turn as an unrevertable change', async () => {
    const before = await captureCheckoutSnapshot(repo)
    const nested = join(repo, 'nested')
    await mkdir(nested)
    const nestedGit = (...args: string[]) => execFileSync('git', args, { cwd: nested, encoding: 'utf8' })
    nestedGit('init', '-q', '-b', 'main')
    nestedGit('config', 'core.hooksPath', '/dev/null')
    nestedGit('config', 'commit.gpgSign', 'false')
    nestedGit('config', 'user.name', 'Fixture')
    nestedGit('config', 'user.email', 'fixture@example.invalid')
    await writeFile(join(nested, 'clone.txt'), 'nested work\n')
    nestedGit('add', 'clone.txt'); nestedGit('commit', '-q', '-m', 'nested fixture')
    const { changes, warnings } = compareCheckoutSnapshots(before, await after(before))
    expect(warnings).toEqual([])
    expect(changes).toEqual([])
    const events: ChatEvent[] = []
    await emitCheckoutChanges(repo, 'turn-id', before, event => events.push(event))
    expect(events).toEqual([])
  })

  it('still reports a change that genuinely cannot be reverted alongside a nested repository', async () => {
    await symlink(join(root, 'outside.txt'), join(repo, 'link.txt'))
    const before = await captureCheckoutSnapshot(repo)
    const nested = join(repo, 'nested')
    await mkdir(nested)
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: nested })
    await rm(join(repo, 'link.txt'))
    await writeFile(join(repo, 'link.txt'), 'now a regular file')
    const events: ChatEvent[] = []
    await emitCheckoutChanges(repo, 'turn-id', before, event => events.push(event))
    expect(events.map(event => event.type)).toEqual(['error'])
    expect(events[0]).toMatchObject({ type: 'error' })
    if (events[0].type !== 'error') throw new Error('expected an error event')
    expect(events[0].message).toContain('link.txt')
    expect(events[0].message).not.toContain('nested/')
  })

  it('stays quiet when a pre-existing nested repository changes internally during the turn', async () => {
    const nested = await makeNestedRepo()
    const before = await captureCheckoutSnapshot(repo)
    await writeFile(join(nested, 'clone.txt'), 'nested work changed\n')
    await writeFile(join(nested, 'another.txt'), 'more nested work\n')
    const { changes, warnings } = compareCheckoutSnapshots(before, await after(before))
    expect(warnings).toEqual([])
    expect(changes).toEqual([])
    const events: ChatEvent[] = []
    await emitCheckoutChanges(repo, 'turn-id', before, event => events.push(event))
    expect(events).toEqual([])
  })

  it('reports a nested repository deleted during the turn as unrevertable', async () => {
    const nested = await makeNestedRepo()
    const before = await captureCheckoutSnapshot(repo)
    await rm(nested, { recursive: true })
    const events: ChatEvent[] = []
    await emitCheckoutChanges(repo, 'turn-id', before, event => events.push(event))
    expect(events.map(event => event.type)).toEqual(['error'])
    if (events[0].type !== 'error') throw new Error('expected an error event')
    expect(events[0].message).toContain('nested/: directory was removed')
  })

  it('reports a nested repository replaced by a file while still recording the new file', async () => {
    const nested = await makeNestedRepo()
    const before = await captureCheckoutSnapshot(repo)
    await rm(nested, { recursive: true })
    await writeFile(join(repo, 'nested'), 'now a regular file\n')
    const { changes, warnings } = compareCheckoutSnapshots(before, await after(before))
    expect(warnings).toEqual(['nested/: directory was removed'])
    expect(changes).toEqual([{ path: 'nested', oldText: '', newText: 'now a regular file\n', oldExists: false, newExists: true }])
  })

  it('does not report a symlink created during the turn as an unrevertable change', async () => {
    const before = await captureCheckoutSnapshot(repo)
    await symlink(join(repo, 'base.txt'), join(repo, 'link'))
    const { changes, warnings } = compareCheckoutSnapshots(before, await after(before))
    expect(warnings).toEqual([])
    expect(changes).toEqual([])
    const events: ChatEvent[] = []
    await emitCheckoutChanges(repo, 'turn-id', before, event => events.push(event))
    expect(events).toEqual([])
  })

  it('reports a symlink removed during the turn as unrevertable', async () => {
    await symlink(join(repo, 'base.txt'), join(repo, 'link'))
    const before = await captureCheckoutSnapshot(repo)
    await rm(join(repo, 'link'))
    const events: ChatEvent[] = []
    await emitCheckoutChanges(repo, 'turn-id', before, event => events.push(event))
    expect(events.map(event => event.type)).toEqual(['error'])
    if (events[0].type !== 'error') throw new Error('expected an error event')
    expect(events[0].message).toContain('link: symlink was removed')
  })

  it('reports a symlink retargeted during the turn as unrevertable', async () => {
    await symlink(join(repo, 'base.txt'), join(repo, 'link'))
    await writeFile(join(repo, 'other.txt'), 'other\n')
    const before = await captureCheckoutSnapshot(repo)
    await rm(join(repo, 'link'))
    await symlink(join(repo, 'other.txt'), join(repo, 'link'))
    const events: ChatEvent[] = []
    await emitCheckoutChanges(repo, 'turn-id', before, event => events.push(event))
    expect(events.map(event => event.type)).toEqual(['error'])
    if (events[0].type !== 'error') throw new Error('expected an error event')
    expect(events[0].message).toContain('link: symlink target changed')
  })

  it('stays quiet when a turn adds untouched binary files, while still recording added text files', async () => {
    const before = await captureCheckoutSnapshot(repo)
    await mkdir(join(repo, 'plain-tree', 'sub'), { recursive: true })
    await writeFile(join(repo, 'plain-tree', 'image.png'), Buffer.from([137, 80, 78, 71, 0, 1, 2]))
    await writeFile(join(repo, 'plain-tree', 'sub', 'data.bin'), Buffer.from([0, 1, 2, 3]))
    await writeFile(join(repo, 'plain-tree', 'notes.txt'), 'new notes\n')
    const { changes, warnings } = compareCheckoutSnapshots(before, await after(before))
    expect(warnings).toEqual([])
    expect(changes).toEqual([{ path: 'plain-tree/notes.txt', oldText: '', newText: 'new notes\n', oldExists: false, newExists: true }])
    const events: ChatEvent[] = []
    await emitCheckoutChanges(repo, 'turn-id', before, event => events.push(event))
    expect(events.some(event => event.type === 'error')).toBe(false)
  })

  it('never reports generated Python caches, even when a tracked cache changes during the turn', async () => {
    await writeFile(join(repo, 'cached.pyc'), Buffer.from([0, 1, 2, 3]))
    git('add', 'cached.pyc'); git('commit', '-q', '-m', 'tracked cache')
    const before = await captureCheckoutSnapshot(repo)
    expect(before.files.has('cached.pyc')).toBe(false)
    await writeFile(join(repo, 'cached.pyc'), Buffer.from([0, 9, 9, 9]))
    await mkdir(join(repo, 'pkg', '__pycache__'), { recursive: true })
    await writeFile(join(repo, 'pkg', '__pycache__', 'new.pyc'), Buffer.from([0, 4, 5]))
    await writeFile(join(repo, 'fresh.pyc'), Buffer.from([0, 6, 7]))
    const { changes, warnings } = compareCheckoutSnapshots(before, await after(before))
    expect(warnings).toEqual([])
    expect(changes).toEqual([])
  })

  it('still warns when a binary file replaces a pre-existing directory', async () => {
    await mkdir(join(repo, 'docs'))
    await writeFile(join(repo, 'docs', 'notes.md'), 'existing notes\n')
    const before = await captureCheckoutSnapshot(repo)
    await rm(join(repo, 'docs'), { recursive: true })
    await writeFile(join(repo, 'docs'), Buffer.from([0, 1, 2]))
    const { changes, warnings } = compareCheckoutSnapshots(before, await after(before))
    expect(warnings).toEqual(['docs: binary or non-UTF-8 file'])
    expect(changes).toEqual([{ path: 'docs/notes.md', oldText: 'existing notes\n', newText: '', oldExists: true, newExists: false }])
    const events: ChatEvent[] = []
    await emitCheckoutChanges(repo, 'turn-id', before, event => events.push(event))
    expect(events.filter(event => event.type === 'error')).toEqual([
      expect.objectContaining({ recoverable: true, message: expect.stringContaining('docs: binary or non-UTF-8 file') }),
    ])
  })

  it('still reports a binary file changed or removed during the turn, once each', async () => {
    await writeFile(join(repo, 'binary.dat'), Buffer.from([0, 1, 2]))
    await writeFile(join(repo, 'gone.dat'), Buffer.from([0, 7, 8]))
    const before = await captureCheckoutSnapshot(repo)
    await writeFile(join(repo, 'binary.dat'), Buffer.from([0, 3, 4]))
    await rm(join(repo, 'gone.dat'))
    const { changes, warnings } = compareCheckoutSnapshots(before, await after(before))
    expect(changes).toEqual([])
    expect(warnings).toEqual(['binary.dat: binary or non-UTF-8 file', 'gone.dat: binary or non-UTF-8 file'])
  })

  it('reports nothing for a turn that leaves a nested clone containing binary files untouched', async () => {
    const nested = await makeNestedRepo()
    await writeFile(join(nested, 'asset.png'), Buffer.from([137, 80, 78, 71, 0]))
    const before = await captureCheckoutSnapshot(repo)
    const { changes, warnings } = compareCheckoutSnapshots(before, await after(before))
    expect(warnings).toEqual([])
    expect(changes).toEqual([])
    const events: ChatEvent[] = []
    await emitCheckoutChanges(repo, 'turn-id', before, event => events.push(event))
    expect(events).toEqual([])
  })

  it('emits a labelled whole-turn card rather than pretending shell changes came from a native edit tool', async () => {
    const before = await captureCheckoutSnapshot(repo)
    execFileSync('sh', ['-c', 'printf "shell edit\n" > base.txt'], { cwd: repo })
    const events: ChatEvent[] = []
    await emitCheckoutChanges(repo, 'turn-id', before, event => events.push(event))
    expect(events.map(event => event.type)).toEqual(['tool.started', 'diff', 'tool.finished'])
    expect(events[0]).toMatchObject({ title: 'Checkout changes during this turn', input: { source: 'poise', scope: 'whole turn' } })
    expect(events[1]).toMatchObject({ path: 'base.txt', oldText: 'original\n', newText: 'shell edit\n' })
  })
})

describe('snapshot budget', () => {
  const idle = () => ({ signal: new AbortController().signal, turnSignal: new AbortController().signal })

  it('degrades to a partial snapshot past its own deadline', async () => {
    await writeFile(join(repo, 'extra.txt'), 'extra\n')
    const snapshot = await captureCheckoutSnapshot(repo, [], {}, { ...idle(), deadlineMs: 0 })
    expect(snapshot.inventoryComplete).toBe(false)
    expect(snapshot.warnings).toEqual(['checkout snapshot time budget exceeded'])
    expect(snapshot.files.size).toBe(0)
    // The uncaptured content still compares conservatively.
    await writeFile(join(repo, 'after.txt'), 'after\n')
    const result = compareCheckoutSnapshots(snapshot, await captureCheckoutSnapshot(repo, [...snapshot.files.keys()]))
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  it('throws on Stop instead of degrading', async () => {
    const turn = new AbortController()
    turn.abort()
    await expect(captureCheckoutSnapshot(repo, [], {}, { ...idle(), turnSignal: turn.signal, deadlineMs: 60_000 }))
      .rejects.toMatchObject({ name: 'AbortError' })
  })

  it('degrades instead of throwing when the preparation budget expires', async () => {
    const prep = new AbortController()
    prep.abort()
    const snapshot = await captureCheckoutSnapshot(repo, [], {}, { ...idle(), signal: prep.signal, deadlineMs: 60_000 })
    expect(snapshot.inventoryComplete).toBe(false)
    expect(snapshot.warnings).toEqual(['checkout snapshot stopped: preparation budget exceeded'])
  })
})
