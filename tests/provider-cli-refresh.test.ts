import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { spawn, type ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, delimiter } from 'node:path'

type RefreshReport = { changed?: boolean, added?: string[], error?: string, cli_updates: Record<string, { status: string, before?: string, after?: string }> }
type RefreshResult = { code: number | null, report: RefreshReport | null, error: string }
type RefreshCase = {
  root: string
  start: (signal: AbortSignal) => { child: ChildProcess, closed: Promise<{ code: number | null, error?: Error }> }
  refresh: (signal: AbortSignal) => Promise<RefreshResult>
  cleanup: () => Promise<void>
}

let activeCase: RefreshCase
beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'poise-refresh-process-'))
  await mkdir(join(root, 'bin'))
  // Caller's CLI lives off PATH: the script must take it from CALLER_BIN_ROOT.
  await mkdir(join(root, 'caller-bin'))
  const provider = `#!${process.execPath}
import fs from 'node:fs'; import p from 'node:path';
const name = p.basename(process.argv[1]);
const state = p.join(process.env.HOME, name + '.version');
const updating = process.argv[2] !== '--version' || process.env.MUSE_SYNC_UPDATE === '1';
if (updating) { fs.writeFileSync(state, '1.1.0'); fs.appendFileSync(p.join(process.env.HOME, 'order'), name + ':updated\\n'); }
console.log(fs.existsSync(state) ? fs.readFileSync(state, 'utf8') : '1.0.0');
`
  for (const name of ['claude', 'codex', 'grok', 'agy', 'muse']) await writeFile(join(root, 'bin', name), provider, { mode: 0o700 })
  const discovery = `#!${process.execPath}
import fs from 'node:fs'; import p from 'node:path';
const order = fs.readFileSync(p.join(process.env.HOME, 'order'), 'utf8');
if (!['claude','codex','grok','agy','muse'].every(name => order.includes(name + ':updated'))) process.exit(42);
fs.appendFileSync(p.join(process.env.HOME, 'order'), 'discovery\\n');
console.log(JSON.stringify({ checked_at: new Date().toISOString(), changed: true, families: { claude: {status: 'ok'}, codex: {status: 'ok'}, grok: {status: 'ok'}, antigravity: {status: 'ok'}, muse: {status: 'ok'} }, added: ['opus-5.5-high'], removed: ['opus-5-high'] }));
`
  await writeFile(join(root, 'caller-bin', 'agent-interface'), discovery, { mode: 0o700 })
  const children = new Map<ChildProcess, Promise<{ code: number | null, error?: Error }>>()
  let disposed = false
  const start = (signal: AbortSignal) => {
    if (disposed) throw new Error('The refresh case has already been cleaned up')
    signal.throwIfAborted()
    const child = spawn(process.execPath, [resolve('scripts/refresh-models.mjs'), '--json'], {
      env: { HOME: root, PATH: [join(root, 'bin'), dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter), AGENT_INTERFACE_ROOT: root, CALLER_BIN_ROOT: join(root, 'caller-bin'), POISE_MODEL_CATALOG_REPORT: join(root, 'report.json') },
      signal, killSignal: 'SIGTERM', stdio: ['ignore', 'pipe', 'pipe'],
    })
    const closed = new Promise<{ code: number | null, error?: Error }>(resolveClosed => {
      let error: Error | undefined
      child.once('error', failure => { error = failure })
      child.once('close', code => { children.delete(child); resolveClosed({ code, error }) })
    })
    children.set(child, closed)
    return { child, closed }
  }
  activeCase = {
    root, start,
    async refresh(signal) {
      const { child, closed } = start(signal)
      let stdout = '', stderr = ''
      child.stdout?.on('data', chunk => { stdout += chunk }); child.stderr?.on('data', chunk => { stderr += chunk })
      const exit = await closed
      if (exit.error) throw exit.error
      return { code: exit.code, report: stdout ? JSON.parse(stdout) : null, error: stderr }
    },
    async cleanup() {
      disposed = true
      for (const child of children.keys()) if (!child.killed) child.kill('SIGTERM')
      await Promise.all(children.values())
      await rm(root, { recursive: true, force: true })
    },
  }
})
afterEach(async () => { await activeCase.cleanup() })

it('the actual scheduled/manual script updates all CLIs before model discovery and persists the report', async ({ signal }) => {
  const fixture = activeCase, { root } = fixture
  const result = await fixture.refresh(signal)
  expect(result, result.error).toMatchObject({ code: 0, report: { changed: true, added: ['opus-5.5-high'] } })
  if (!result.report) throw new Error('The refresh did not return a report')
  expect(Object.keys(result.report.cli_updates)).toHaveLength(5)
  for (const item of Object.values(result.report.cli_updates)) expect(item).toMatchObject({ status: 'updated', before: '1.0.0', after: '1.1.0' })
  expect(JSON.parse(await readFile(join(root, 'report.json'), 'utf8'))).toEqual(result.report)
  expect((await readFile(join(root, 'order'), 'utf8')).trim().split('\n').at(-1)).toBe('discovery')
})
it('overlapping manual and scheduled processes share one complete discovery run', async ({ signal }) => {
  const fixture = activeCase, { root } = fixture
  const results = await Promise.all([fixture.refresh(signal), fixture.refresh(signal)])
  expect(results.map(result => result.code)).toEqual([0, 0])
  expect((await readFile(join(root, 'order'), 'utf8')).match(/discovery/g)).toHaveLength(1)
})

it('a failed discovery replaces the old green receipt and can be retried', async ({ signal, task }) => {
  const fixture = activeCase, { root } = fixture
  expect(task.timeout).toBe(30_000)
  const good = await fixture.refresh(signal)
  expect(good.code).toBe(0)
  const discoveryPath = join(root, 'caller-bin', 'agent-interface')
  const discovery = await readFile(discoveryPath, 'utf8')
  await writeFile(discoveryPath, `#!${process.execPath}\nconsole.log('not a discovery report')\n`, { mode: 0o700 })
  const bad = await fixture.refresh(signal)
  expect(bad.code).toBe(1); expect(bad.report?.error).toBeTruthy()
  expect(JSON.parse(await readFile(join(root, 'report.json'), 'utf8'))).toEqual(bad.report)
  await writeFile(discoveryPath, discovery, { mode: 0o700 })
  expect((await fixture.refresh(signal)).code).toBe(0)
}, 30_000)

it('stopping the refresh runner also stops its in-flight native updater group', async ({ signal }) => {
  const fixture = activeCase, { root } = fixture
  const { existsSync } = await import('node:fs')
  const marker = join(root, 'updater.pid')
  await writeFile(join(root, 'bin', 'claude'), `#!${process.execPath}\nimport fs from 'node:fs';\nif(process.argv[2]==='--version') console.log('1.0.0');\nelse { fs.writeFileSync(${JSON.stringify(marker)},String(process.pid)); setInterval(()=>{},1000); }\n`, { mode: 0o700 })
  const { child, closed } = fixture.start(signal)
  try {
    await expect.poll(() => existsSync(marker), { timeout: 5000 }).toBe(true)
    const pid = Number(await readFile(marker, 'utf8'))
    child.kill('SIGTERM'); await closed
    await expect.poll(() => { try { process.kill(pid, 0); return true } catch { return false } }).toBe(false)
  } finally { child.kill('SIGTERM'); await closed }
})

it('a case abort stops its held updater and closes the runner before removing the case root', async () => {
  const { existsSync } = await import('node:fs')
  const fixture = activeCase, { root } = fixture
  const marker = join(root, 'aborted-updater.pid')
  await writeFile(join(root, 'bin', 'claude'), `#!${process.execPath}\nimport fs from 'node:fs';\nif(process.argv[2]==='--version') console.log('1.0.0');\nelse { fs.writeFileSync(${JSON.stringify(marker)},String(process.pid)); setInterval(()=>{},1000); }\n`, { mode: 0o700 })
  const controller = new AbortController()
  const run = fixture.start(controller.signal)
  let runnerClosed = false
  void run.closed.then(() => { runnerClosed = true })
  let pid: number | undefined
  const alive = (target: number) => {
    try { process.kill(target, 0); return true }
    catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false; throw error }
  }
  try {
    await expect.poll(() => existsSync(marker), { timeout: 5000 }).toBe(true)
    pid = Number(await readFile(marker, 'utf8'))
    controller.abort()
    await fixture.cleanup()
    expect(runnerClosed).toBe(true)
    expect((await run.closed).error?.name).toBe('AbortError')
    expect(run.child.exitCode !== null || run.child.signalCode !== null).toBe(true)
    await expect.poll(() => alive(pid!)).toBe(false)
    expect(existsSync(root)).toBe(false)
    expect(() => fixture.start(new AbortController().signal)).toThrow('already been cleaned up')
  } finally {
    controller.abort()
    await run.closed
    if (pid !== undefined && alive(pid)) process.kill(pid, 'SIGKILL')
  }
})
