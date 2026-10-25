import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { build } from 'esbuild'

// The production server shares its container user with worker agents, issue
// reviews and their tests, so any of them can signal it. A SIGUSR1 must
// neither switch the V8 inspector on nor stop the server, and every shutdown
// trigger must name itself in the log. Each case runs in a child process, so
// real signals are delivered exactly as the container would deliver them.

let compiled = ''
let helper = ''
afterAll(() => { if (compiled) rmSync(compiled, { recursive: true, force: true }) })
beforeAll(async () => {
  compiled = mkdtempSync(join(tmpdir(), 'poise-production-signals-'))
  helper = join(compiled, 'helper.mjs')
  await build({
    stdin: {
      contents: `import { url as inspectorUrl } from 'node:inspector'
import { refuseInspectorActivation, registerProductionShutdownSignals } from './server/production-signals'
import { requestUpdateRestart } from './server/service/restart'
const mode = process.argv[2]
if (mode === 'sigusr1') {
  refuseInspectorActivation()
  console.log('ready')
  setInterval(() => {}, 1000)
} else if (mode === 'inherited') {
  refuseInspectorActivation()
  console.log('inspector=' + (inspectorUrl() ?? 'closed'))
} else if (mode === 'sigterm' || mode === 'sigint') {
  registerProductionShutdownSignals(() => { console.log('shutdown-called'); process.exit(0) })
  console.log('ready')
  setInterval(() => {}, 1000)
} else if (mode === 'restart') {
  registerProductionShutdownSignals((code) => { console.log('shutdown-called exit=' + code); process.exit(0) })
  if (!requestUpdateRestart()) { console.log('restart-refused'); process.exit(2) }
} else {
  console.log('unknown mode')
  process.exit(3)
}`,
      resolveDir: process.cwd(),
      sourcefile: 'production-signals-fixture.ts',
      loader: 'ts',
    },
    outfile: helper,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    logLevel: 'silent',
  })
}, 60_000)

interface Spawned {
  child: ChildProcess
  stdout: () => string
  stderr: () => string
  closed: Promise<{ code: number | null, signal: NodeJS.Signals | null }>
}

function spawnHelper(mode: string, nodeArgs: string[] = [], env: NodeJS.ProcessEnv = {}): Spawned {
  const child = spawn(process.execPath, [...nodeArgs, helper, mode], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  const closed = new Promise<{ code: number | null, signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  return { child, stdout: () => stdout, stderr: () => stderr, closed }
}

async function waitFor(output: () => string, text: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 5000
  while (!output().includes(text)) {
    if (child.exitCode !== null) throw new Error(`child exited before printing ${JSON.stringify(text)}`)
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${JSON.stringify(text)}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

it('ignores SIGUSR1 without enabling the inspector or stopping', async () => {
  // --inspect-port=0 keeps the case off port 9229: a refused activation never
  // binds, and an accepted one would take an ephemeral port.
  const { child, stdout, stderr, closed } = spawnHelper('sigusr1', ['--inspect-port=0'])
  try {
    await waitFor(stdout, 'ready', child)
    child.kill('SIGUSR1')
    await waitFor(stderr, 'ignored SIGUSR1', child)
    // A debugger line would arrive with the activation; give it a moment to
    // prove it is not coming before asserting the child is unaffected.
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(child.exitCode).toBeNull()
    expect(stderr()).toContain('ignored SIGUSR1')
    expect(stderr()).not.toContain('Debugger listening')
  } finally {
    child.kill('SIGKILL')
    await closed
  }
}, 15_000)

it('closes an inspector inherited from the environment', async () => {
  const { stdout, stderr, closed } = spawnHelper('inherited', ['--inspect=127.0.0.1:0'])
  expect(await closed).toEqual({ code: 0, signal: null })
  expect(stdout()).toContain('inspector=closed')
  expect(stderr()).toContain('closed the inherited inspector')
}, 15_000)

it.each(['SIGTERM', 'SIGINT'] as const)('names %s in the shutdown log and exits cleanly', async (signal) => {
  const { child, stdout, closed } = spawnHelper(signal === 'SIGTERM' ? 'sigterm' : 'sigint')
  try {
    await waitFor(stdout, 'ready', child)
    child.kill(signal)
    expect(await closed).toEqual({ code: 0, signal: null })
    expect(stdout()).toContain(`[poise] received ${signal}; shutting down`)
    expect(stdout()).toContain('shutdown-called')
  } finally {
    child.kill('SIGKILL')
    await closed
  }
}, 15_000)

it('names a release switch in the shutdown log', async () => {
  const { stdout, closed } = spawnHelper('restart', [], { POISE_RELEASE: 'test-release', POISE_BASE: 'test-base' })
  expect(await closed).toEqual({ code: 0, signal: null })
  expect(stdout()).toContain('[poise] release switch requested; shutting down (exit 75)')
  expect(stdout()).toContain('shutdown-called exit=75')
}, 15_000)

it('re-exports the signal helpers from the production entry for in-process launchers', async () => {
  const production = await import('../server/production')
  expect(typeof production.refuseInspectorActivation).toBe('function')
  expect(typeof production.registerProductionShutdownSignals).toBe('function')
}, 15_000)
