import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Profiler } from 'node:inspector'
import { build } from 'esbuild'
import { afterAll, beforeAll, expect, it } from 'vitest'

let root = '', helper = ''
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'poise-cpu-process-'))
  helper = join(root, 'helper.mjs')
  await build({ stdin: { resolveDir: process.cwd(), loader: 'ts', sourcefile: 'cpu-profile-owned-fixture.ts', contents: `
import { Session, url } from 'node:inspector'
import { createCpuCapture, installProductionCpuCapture, abandonProductionCpuCapture } from './server/production-cpu-profile'
import { refuseInspectorActivation, registerProductionShutdownSignals } from './server/production-signals'
import { requestUpdateRestart } from './server/service/restart'
const mode = process.argv[2]
refuseInspectorActivation()
const keepAlive = setInterval(() => {}, 1000)
if (mode.startsWith('retention')) {
  let weak
  const capture = createCpuCapture({ durationMs: 150, sessionFactory: () => {
    const session = new Session()
    return { connect: () => session.connect(), disconnect: () => session.disconnect(), post: (method, callback) => {
      if (mode === 'retention-control' && method === 'Runtime.discardConsoleEntries') { callback(null, {}); return }
      session.post(method, callback)
    } }
  } })
  capture.request()
  await new Promise(resolve => setImmediate(resolve))
  { let value = { canary: 'console-object-canary' }; weak = new WeakRef(value); console.log(value); value = null }
  await capture.settled()
  for (let i = 0; i < 10; i++) { await new Promise(resolve => setImmediate(resolve)); global.gc() }
  console.log('retained=' + Boolean(weak.deref()) + ' inspector=' + (url() ?? 'closed'))
  clearInterval(keepAlive)
} else {
  if (mode === 'programmatic-report') process.report.reportOnSignal = true
  installProductionCpuCapture()
  installProductionCpuCapture()
  registerProductionShutdownSignals((code = 0) => { abandonProductionCpuCapture(); process.exit(code) })
  process.on('message', message => {
    if (message === 'abandon') { abandonProductionCpuCapture(); console.log('abandoned-ready') }
    if (message === 'restart') requestUpdateRestart()
    if (message === 'status') console.log('status inspector=' + (url() ?? 'closed') + ' handlers=' + process.listenerCount('SIGUSR2'))
  })
  console.log('ready inspector=' + (url() ?? 'closed') + ' handlers=' + process.listenerCount('SIGUSR2'))
}
` }, outfile: helper, bundle: true, platform: 'node', format: 'esm', packages: 'external',
    define: { __POISE_BUILD_SHA__: JSON.stringify('a'.repeat(40)) }, logLevel: 'silent' })
}, 60_000)
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }) })

function owned(mode = 'normal', args: string[] = [], extraEnv: NodeJS.ProcessEnv = {}, prior = false) {
  const home = mkdtempSync(join(root, 'home-'))
  const directory = join(home, '.poise', 'diagnostics')
  if (prior) { mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, 'cpu-profile.json'), 'preserved') }
  const child = spawn(process.execPath, [...args, helper, mode], {
    env: { ...process.env, HOME: home, POISE_MODE: 'service', POISE_RELEASE: 'test-release', POISE_BASE: 'test-base', NODE_OPTIONS: '', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  let stdout = '', stderr = ''
  child.stdout?.on('data', (data: Buffer) => { stdout += data.toString() })
  child.stderr?.on('data', (data: Buffer) => { stderr += data.toString() })
  const closed = new Promise<{ code: number | null, signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }))
  })
  return { child, home, directory, stdout: () => stdout, stderr: () => stderr, closed }
}
async function waitFor(output: () => string, text: string, child: ChildProcess, budget = 5000) {
  const deadline = Date.now() + budget
  while (!output().includes(text)) {
    if (child.exitCode !== null || child.signalCode) throw new Error(`owned child exited waiting for ${text}: ${output()}`)
    if (Date.now() > deadline) throw new Error(`owned child did not print ${text}: ${output()}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
async function dispose(run: ReturnType<typeof owned>) { run.child.kill('SIGKILL'); await run.closed }

it('captures once through real SIGUSR2, leaves no listener, and keeps the refusal handler after completion', async () => {
  const run = owned()
  try {
    await waitFor(run.stdout, 'ready inspector=closed handlers=1', run.child)
    expect(run.stderr()).toContain('"available":true')
    run.child.kill('SIGUSR2')
    await waitFor(run.stderr, 'CPU capture started=', run.child)
    run.child.kill('SIGUSR2')
    await waitFor(run.stderr, 'request refused', run.child)
    run.child.send('status')
    await waitFor(run.stdout, 'status inspector=closed handlers=1', run.child)
    await waitFor(run.stderr, 'recorded; published=', run.child, 25_000)
    const file = join(run.directory, 'cpu-profile.json')
    const contents = readFileSync(file, 'utf8')
    const envelope = JSON.parse(contents) as { metadata: { requestedDurationMs: number, identity: { buildSha: string }, sampleCount: number }, profile: Profiler.Profile }
    expect(envelope.metadata.requestedDurationMs).toBe(15_000)
    expect(envelope.metadata.identity.buildSha).toBe('a'.repeat(40))
    expect(envelope.metadata.sampleCount).toBeGreaterThan(0)
    expect(envelope.profile.endTime).toBeGreaterThan(envelope.profile.startTime)
    const ids = new Set(envelope.profile.nodes.map(node => node.id))
    expect(envelope.profile.samples?.every(id => ids.has(id))).toBe(true)
    expect(envelope.profile.timeDeltas).toHaveLength(envelope.profile.samples?.length ?? 0)
    run.child.kill('SIGUSR2'); run.child.kill('SIGUSR1')
    await waitFor(run.stderr, 'ignored SIGUSR1', run.child)
    expect(readFileSync(file, 'utf8')).toBe(contents)
    expect(readdirSync(run.directory)).toEqual(['cpu-profile.json'])
    expect(run.stderr().match(/request refused/g)).toHaveLength(1)
    expect(run.stderr()).not.toContain('Debugger listening')
    expect(run.child.exitCode).toBeNull()
  } finally { await dispose(run) }
}, 35_000)

it('keeps the permanent handler after a refused existing output and after abandonment', async () => {
  const run = owned('normal', [], {}, true)
  try {
    await waitFor(run.stdout, 'ready', run.child)
    run.child.kill('SIGUSR2')
    await waitFor(run.stderr, 'output already exists', run.child)
    run.child.send('abandon')
    await waitFor(run.stdout, 'abandoned-ready', run.child)
    run.child.kill('SIGUSR2')
    await waitFor(run.stderr, 'request refused', run.child)
    expect(readFileSync(join(run.directory, 'cpu-profile.json'), 'utf8')).toBe('preserved')
    expect(run.child.exitCode).toBeNull()
  } finally { await dispose(run) }
})

it('keeps the handler after abandoning a live capture and never publishes later', async () => {
  const run = owned()
  try {
    await waitFor(run.stdout, 'ready', run.child)
    run.child.kill('SIGUSR2')
    await waitFor(run.stderr, 'CPU capture started=', run.child)
    run.child.send('abandon')
    await waitFor(run.stdout, 'abandoned-ready', run.child)
    run.child.kill('SIGUSR2')
    await waitFor(run.stderr, 'request refused', run.child)
    run.child.send('status')
    await waitFor(run.stdout, 'status inspector=closed handlers=1', run.child)
    expect(existsSync(join(run.directory, 'cpu-profile.json'))).toBe(false)
    expect(run.child.exitCode).toBeNull()
  } finally { await dispose(run) }
})

it.each(['SIGTERM', 'SIGINT', 'restart'] as const)('abandons a live capture and preserves %s exit semantics', async (trigger) => {
  const run = owned()
  try {
    await waitFor(run.stdout, 'ready', run.child)
    run.child.kill('SIGUSR2')
    await waitFor(run.stderr, 'CPU capture started=', run.child)
    if (trigger === 'restart') run.child.send('restart')
    else run.child.kill(trigger)
    expect(await run.closed).toEqual({ code: trigger === 'restart' ? 75 : 0, signal: null })
    expect(run.stderr()).toContain('abandoned: shutdown')
    expect(existsSync(join(run.directory, 'cpu-profile.json'))).toBe(false)
  } finally { await dispose(run) }
})

it.each([
  ['argv-report', ['--report-on-signal'], {}],
  ['argv-heap', ['--heapsnapshot-signal=SIGUSR2'], {}],
  ['inherited', [], { NODE_OPTIONS: '--report-on-signal' }],
  ['programmatic-report', [], {}],
] as const)('operator preflight refuses %s before any real signal', async (mode, args, env) => {
  const run = owned(mode, [...args], env)
  try {
    await waitFor(run.stdout, 'ready', run.child)
    expect(run.stderr()).toContain('"available":false')
    expect(run.stderr()).toContain('native signal')
    // Delivering SIGUSR2 here could invoke Node's independent report/heap
    // handler despite JS refusal. The operator must stop before that action.
    expect(existsSync(run.directory)).toBe(false)
    expect(readdirSync(run.home)).toEqual([])
  } finally { await dispose(run) }
})

it.each([['retention', false], ['retention-control', true]] as const)('releases console references with fixed cleanup (%s)', async (mode, retained) => {
  const run = owned(mode, ['--expose-gc'])
  try {
    expect(await run.closed).toEqual({ code: 0, signal: null })
    expect(run.stdout()).toContain(`retained=${retained} inspector=closed`)
    const contents = readFileSync(join(run.directory, 'cpu-profile.json'), 'utf8')
    expect(contents).not.toContain('console-object-canary')
  } finally { await dispose(run) }
})
