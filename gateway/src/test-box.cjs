// Runs on a disposable test box, as root: starts Docker, unpacks the checkout and runs the suite exactly as it was
// typed, as the workspace's user. test-relay.ts uploads and starts this. docs/Operating.md, "Agents' test suites".
// Its output and exit code are what the agent gets, so everything that goes wrong here says so and exits with 125.
'use strict'
const { spawn, spawnSync } = require('node:child_process')
const { chmodSync, openSync, readFileSync } = require('node:fs')
const { constants } = require('node:os')
const { setTimeout: sleep } = require('node:timers/promises')

const [specPath, treePath, root = '/'] = process.argv.slice(2)
// A real box unpacks at the root and has a system to start. Tests name a folder instead.
const onBox = root === '/'
const asUser = onBox ? { uid: 10001, gid: 10001 } : {}
const RUNNER_FAILED = 125
// What only a runtime that ran out says, not a test that talks about memory.
const OUT_OF_MEMORY = /FATAL ERROR: .*heap out of memory|Worker terminated due to reaching memory limit/
// The kernel killing for the whole box, not a memory-capped container a test started: that one says "Memory cgroup out of memory".
const BOX_OUT_OF_MEMORY = /(^|\] )Out of memory: Killed process/m
const OUTPUT_TAIL_CHARS = 64 * 1024
const QUIET_MS = 2_000
const DOCKER_WAIT_MS = 30_000
const HEAP_SHARE = 0.8

function fail(why) {
  process.stderr.write(`[poise] no test result: ${why}. This says nothing about your code. Skip local tests for this work: don't retry, and don't run parts of it. Push your change and let CI run the tests.\n`, () => process.exit(RUNNER_FAILED))
}

async function startDocker() {
  // A sandbox boots without cgroups mounted, and its root is an overlay that Docker's own overlay can't sit on.
  spawnSync('mount', ['-t', 'cgroup2', 'cgroup2', '/sys/fs/cgroup'])
  const log = openSync('/var/log/dockerd.log', 'a')
  spawn('dockerd', ['--storage-driver', 'fuse-overlayfs'], { detached: true, stdio: ['ignore', log, log] }).unref()
  const started = Date.now()
  while (Date.now() - started < DOCKER_WAIT_MS) {
    if (spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 5_000 }).status === 0) {
      // Node drops supplementary groups for the suite's user, so membership of `docker` would not reach it.
      chmodSync('/var/run/docker.sock', 0o666)
      return
    }
    await sleep(250)
  }
  // A suite that never calls it is unharmed, so this is not the end of the run.
  process.stderr.write('[poise] Docker did not start on this box, so a test that needs it will fail\n')
}

/** Node keeps its heap to about half of the memory unless told. A suite here has the box to itself. */
function nodeOptions(inherited) {
  const total = /^MemTotal:\s+(\d+) kB/m.exec(tryRead('/proc/meminfo'))?.[1]
  if (!total) return inherited
  // First, so a value the suite sets for itself wins.
  return [`--max-old-space-size=${Math.floor(Number(total) * HEAP_SHARE / 1024)}`, inherited].filter(Boolean).join(' ')
}

function tryRead(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    // No such file outside Linux.
    return ''
  }
}

function suiteEnvironment(spec) {
  const env = { ...spec.env, PATH: [spec.env.PATH, process.env.PATH].filter(Boolean).join(':') }
  // /tmp here is this suite's alone, and the agent's folder can be too long for a Unix socket made under it.
  for (const name of ['TMPDIR', 'TMP', 'TEMP']) delete env[name]
  if (onBox && !env.PLAYWRIGHT_BROWSERS_PATH) env.PLAYWRIGHT_BROWSERS_PATH = '/opt/playwright-browsers'
  const options = nodeOptions(env.NODE_OPTIONS)
  if (options) env.NODE_OPTIONS = options
  return env
}

/** Not spawnSync: Docker starts alongside, and its wait must keep running. Answers with what went wrong, or null. */
function unpack(whole) {
  return new Promise((resolve) => {
    let errors = ''
    const tar = spawn('tar', ['-xzf', whole, '-C', root, '--no-same-owner'], { stdio: ['ignore', 'ignore', 'pipe'], ...asUser })
    tar.stderr.on('data', (chunk) => { errors = (errors + chunk).slice(-300) })
    tar.once('error', (error) => resolve(error.message))
    tar.once('close', (code) => resolve(code === 0 ? null : errors.trim() || `tar exited with ${code}`))
  })
}

function runSuite(spec, env) {
  let tail = ''
  let lastOutput = Date.now()
  const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], ...asUser })
  for (const [from, to] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    from.on('data', (chunk) => {
      lastOutput = Date.now()
      tail = (tail + chunk).slice(-OUTPUT_TAIL_CHARS)
      if (!to.write(chunk)) {
        from.pause()
        to.once('drain', () => from.resume())
      }
    })
  }
  child.once('error', (error) => {
    process.stderr.write(`[poise] cannot start ${spec.argv[0]} on the test box: ${error.message}\n`, () => process.exit(127))
  })
  child.once('exit', (code, signal) => {
    void (async () => {
      // Its pipes can still hold output, and something it left behind can keep them open forever.
      let closed = false
      child.once('close', () => { closed = true })
      while (!closed && Date.now() - lastOutput < QUIET_MS) await sleep(50)
      const status = code ?? 128 + (constants.signals[signal] ?? 0)
      if (status !== 0 && (OUT_OF_MEMORY.test(tail) || (onBox && BOX_OUT_OF_MEMORY.test(spawnSync('dmesg', { encoding: 'utf8' }).stdout ?? '')))) fail('this suite is too big for its test box: it ran out of memory')
      else process.stdout.write('', () => process.stderr.write('', () => process.exit(status)))
    })()
  })
}

async function main() {
  const spec = JSON.parse(readFileSync(specPath, 'utf8'))
  const docker = onBox ? startDocker() : Promise.resolve()
  const env = suiteEnvironment(spec)
  // It arrives in parts, numbered in order.
  const whole = `${treePath}.tgz`
  spawnSync('sh', ['-c', 'cat "$0"/* > "$1" && chmod 644 "$1"', treePath, whole])
  const problem = await unpack(whole)
  if (problem !== null) {
    fail(`unpacking the checkout failed: ${problem}`)
    return
  }
  await docker
  // Folders with nothing in them travel in no tar.
  spawnSync('mkdir', ['-p', spec.cwd, ...(env.HOME ? [env.HOME] : [])], asUser)
  runSuite(spec, env)
}

main().catch((error) => fail(error.message))
