// Runs on a disposable test box, as root: starts Docker, unpacks the checkout and runs the suite exactly as it was
// typed, as the workspace's user. test-relay.ts uploads and starts this on a sandbox. On a job, test-instance.cjs starts
// it as the workspace's user, and Docker is not there to start. docs/Operating.md, "Agents' test suites".
// Its output and exit code are what the agent gets, so everything that goes wrong here says so and exits with 125.
'use strict'
const { spawn, spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { accessSync, chmodSync, chownSync, constants: { W_OK }, createReadStream, existsSync, lstatSync, mkdtempSync, openSync, readFileSync, readlinkSync, statSync, writeFileSync } = require('node:fs')
const { basename, dirname, join, relative } = require('node:path')
const { constants } = require('node:os')
const { pipeline } = require('node:stream/promises')
const { setTimeout: sleep } = require('node:timers/promises')
const { pathToFileURL } = require('node:url')
const { createGunzip } = require('node:zlib')

const [specPath, treePath, root = '/'] = process.argv.slice(2)
// A real box unpacks at the root and has a system to start. Tests name a folder instead.
const onBox = root === '/'
const asJob = Boolean(process.env.POISE_TEST_JOB)
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
// A job is the workspace image already, whose files and folders its user may not replace, and needs not. GNU tar's
// --skip-old-files leaves them, folders' modes included, and refuses --no-overwrite-dir beside it.
const JOB_UNPACK = ['--skip-old-files']

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
  // A job's container shows the host's memory, and its own only in its cgroup.
  const kB = Number(tryRead('/sys/fs/cgroup/memory.max')) / 1024 || Number(/^MemTotal:\s+(\d+) kB/m.exec(tryRead('/proc/meminfo'))?.[1])
  if (!kB) return inherited
  // First, so a value the suite sets for itself wins.
  return [`--max-old-space-size=${Math.floor(kB * HEAP_SHARE / 1024)}`, inherited].filter(Boolean).join(' ')
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

function writable(dir) {
  while (!existsSync(dir)) dir = dirname(dir)
  try {
    accessSync(dir, W_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Whether a job's unpacking went through the whole archive and missed only files for folders of the image that the
 * job's user may not write. The image is the workspace's, so the suite runs with what those folders hold, as with the
 * image's files. A tar that stopped any other way, a signal included, ends the run without a result.
 */
function onlyImageFolders(code, errors, into = root) {
  const end = 'tar: Exiting with failure status due to previous errors'
  const lines = errors.trim().split('\n')
  if (code !== 2 || lines.at(-1) !== end) return false
  return lines.length > 1 && lines.slice(0, -1).every((line) => {
    // As `Cannot mkdir`, `Cannot open` or `Cannot create symlink to 'x'`, for one folder's new files and what is in them.
    const name = /^tar: (.+?): Cannot [^:]*: (?:Permission denied|No such file or directory)$/.exec(line)?.[1]
    return name !== undefined && !writable(dirname(join(into, name)))
  })
}

/** Not spawnSync: Docker starts alongside, and its wait must keep running. Answers with what went wrong, or null. */
function unpack(whole) {
  return new Promise((resolve) => {
    let errors = ''
    const keep = asJob && onBox ? JOB_UNPACK : []
    const tar = spawn('tar', ['-xzf', whole, '-C', root, '--no-same-owner', ...keep], { stdio: ['ignore', 'ignore', 'pipe'], ...asUser })
    tar.stderr.on('data', (chunk) => { errors += chunk })
    tar.once('error', (error) => resolve(error.message))
    tar.once('close', (code) => {
      if (code === 0 || (asJob && onBox && onlyImageFolders(code, errors))) resolve(null)
      else resolve(errors.trim().slice(-300) || `tar exited with ${code}`)
    })
  })
}

/** Keep only counters or record fingerprints, bounded by spawnSync's output limit, never kernel log text. */
function memoryKills() {
  if (asJob) {
    const count = /^oom_kill (\d+)$/m.exec(tryRead('/sys/fs/cgroup/memory.events'))?.[1]
    return count === undefined ? null : BigInt(count)
  }
  const log = spawnSync('dmesg', { encoding: 'utf8' })
  if (log.status !== 0 || log.error || typeof log.stdout !== 'string') return null
  return new Set(log.stdout.split('\n').filter((line) => BOX_OUT_OF_MEMORY.test(line))
    .map((line) => createHash('sha256').update(line).digest('hex')))
}

function ranOutOfMemory(before, after) {
  if (before === null || after === null) return false
  return asJob ? after > before : [...after].some((record) => !before.has(record))
}

function git(cwd, ...args) {
  // Unpacking runs as the suite user, so this must too when root; otherwise run as self (tests, jobs).
  const identity = process.getuid?.() === 0 ? asUser : {}
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...identity })
  if (result.status !== 0) throw new Error('test capture git identity is unavailable')
  return result.stdout
}

/** Read the captured files, without trusting the uploaded index's dirty flags. */
function sourceCapture(cwd) {
  const top = git(cwd, 'rev-parse', '--show-toplevel').trim()
  const base = git(top, 'rev-parse', 'HEAD').trim()
  const origin = git(top, 'remote', 'get-url', 'origin').trim()
  const repository = /^(?:https:\/\/github.com\/|git@github.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(origin)?.[1]
  if (!repository) throw new Error('test capture repository is unavailable')
  const expected = git(top, 'ls-tree', '-rz', 'HEAD').split('\0').filter(Boolean).sort()
  const actual = [...new Set(git(top, 'ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter(Boolean))].map(path => {
    const file = join(top, path)
    if (!existsSync(file) && !lstatSafe(file)) return `missing\t${path}`
    const stat = lstatSync(file)
    if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error('test capture contains an unsupported source entry')
    const data = stat.isSymbolicLink() ? Buffer.from(readlinkSync(file)) : readFileSync(file)
    const mode = stat.isSymbolicLink() ? '120000' : stat.mode & 0o111 ? '100755' : '100644'
    const blob = createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex')
    return `${mode} blob ${blob}\t${path}`
  }).sort()
  return { top, base, repository, source: createHash('sha256').update(JSON.stringify(actual)).digest('hex'),
    clean: JSON.stringify(actual) === JSON.stringify(expected) }
}

function lstatSafe(path) {
  try { return lstatSync(path) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

/** Only a directly invoked Vitest run has a fully accounted assertion result.
 * Wrappers and other runners keep their existing hold rather than guessing
 * whether another command, setup error or missing report also failed.
 */
function assertionReporter(spec) {
  // Held for #1619: the suite UID owns these files, so candidate code can
  // replace them before signing. Preserve the hold until the runner establishes
  // the inventory independently. No reporter is injected; suites run as before.
  return null
  if (!spec.capture || !spec.binding || !spec.reportTo) return null
  const cli = /^(vitest|vitest\.mjs)$/.test(basename(spec.argv[0])) ? spec.argv[0]
    : /^(?:node|nodejs)$/.test(basename(spec.argv[0])) && /^(vitest|vitest\.mjs)$/.test(basename(spec.argv[1] ?? '')) ? spec.argv[1] : null
  if (!cli || spec.argv.some(word => /^(?:--watch|--ui|--coverage|--reporter|--outputFile)(?:=|$)/.test(word))) return null
  const directory = mkdtempSync('/tmp/poise-assertions-')
  if (onBox) chownSync(directory, 10001, 10001)
  const report = join(directory, 'result.json'), completion = join(directory, 'complete.json')
  const reporter = join(directory, 'reporter.mjs')
  const reporters = pathToFileURL(require.resolve('vitest/reporters', { paths: [dirname(cli)] })).href
  writeFileSync(reporter, `import { JsonReporter } from ${JSON.stringify(reporters)};
import { writeFileSync } from 'node:fs';
export default class extends JsonReporter {
  constructor() { super({ outputFile: ${JSON.stringify(report)} }); }
  async onTestRunEnd(modules, errors, reason) {
    await super.onTestRunEnd(modules);
    const setupFailed = task => task.type === 'suite' && (task.result?.errors?.length || task.tasks?.some(setupFailed));
    writeFileSync(${JSON.stringify(completion)}, JSON.stringify({ errors: errors.length, reason,
      setupFailed: modules.some(module => setupFailed(module.task)) }));
  }
}`)
  spec.argv.push('--reporter=default', `--reporter=${reporter}`)
  return { report, completion }
}

function assertionResult(reporter, capture) {
  // Held for #1619 alongside assertionReporter: even a directly supplied
  // reporter path is candidate-controlled, so no inventory is trusted.
  return null
  if (!reporter || !existsSync(reporter.report) || !existsSync(reporter.completion)
    || statSync(reporter.report).size > 16 * 1024 * 1024) return null
  const complete = JSON.parse(readFileSync(reporter.completion, 'utf8'))
  const report = JSON.parse(readFileSync(reporter.report, 'utf8'))
  if (complete.errors !== 0 || complete.reason !== 'failed' || complete.setupFailed !== false
    || report.success !== false || report.snapshot?.failure || report.numPendingTestSuites > 0) return null
  const failures = [], counts = new Map()
  let total = 0
  for (const file of report.testResults) {
    if (!['passed', 'failed'].includes(file.status) || file.message) return null
    let failed = 0
    const path = relative(capture.top, file.name)
    if (!path || path.startsWith('..')) return null
    for (const test of file.assertionResults) {
      if (!['passed', 'failed', 'pending', 'todo', 'skipped'].includes(test.status)
        || !Array.isArray(test.failureMessages) || test.failureMessages.some(message => typeof message !== 'string')) return null
      const key = JSON.stringify([path, test.fullName])
      counts.set(key, (counts.get(key) ?? 0) + 1)
      total++
      if (test.status !== 'failed') continue
      const cause = test.failureMessages.join('\n').replaceAll(capture.top, '$CHECKOUT')
      if (!cause.trim()) return null
      failures.push({ file: path, test: test.fullName, cause, causeDigest: createHash('sha256').update(cause).digest('hex') })
      failed++
    }
    if ((file.status === 'failed') !== (failed > 0)) return null
  }
  if (!failures.length || failures.length > 100 || report.numFailedTests !== failures.length || report.numTotalTests !== total) return null
  const keys = new Set(failures.map(item => JSON.stringify([item.file, item.test])))
  const totals = [...counts].filter(([key]) => keys.has(key)).map(([key, total]) => {
    const [file, test] = JSON.parse(key)
    return { file, test, total }
  })
  return { failures, totals }
}

function runSuite(spec, env, capture, reporter) {
  let tail = ''
  let lastOutput = Date.now()
  const memoryBefore = onBox ? memoryKills() : null
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
    const memoryAfter = onBox ? memoryKills() : null
    void (async () => {
      // Its pipes can still hold output, and something it left behind can keep them open forever.
      let closed = false
      child.once('close', () => { closed = true })
      while (!closed && Date.now() - lastOutput < QUIET_MS) await sleep(50)
      const status = code ?? 128 + (constants.signals[signal] ?? 0)
      if (status !== 0 && (OUT_OF_MEMORY.test(tail) || ranOutOfMemory(memoryBefore, memoryAfter))) fail('this suite is too big for its test box: it ran out of memory')
      else {
        if (status === 1 && closed && capture && reporter) {
          try {
            const assertions = assertionResult(reporter, capture)
            if (assertions) {
              const { top, ...identity } = capture
              const body = JSON.stringify({ ...identity, ...assertions, exit: status })
              if (Buffer.byteLength(body) <= 40 * 1024) await fetch(spec.reportTo.url, { method: 'POST',
                headers: { authorization: `Bearer ${spec.reportTo.token}` }, body, signal: AbortSignal.timeout(5_000) })
            }
          } catch (error) {
            // Evidence is optional; a missing or unreadable complete result
            // cannot authorize recovery and never changes the suite's exit.
            process.stderr.write(`[poise] assertion recovery evidence could not be retained: ${error.message}\n`)
          }
        }
        process.stdout.write('', () => process.stderr.write('', () => process.exit(status)))
      }
    })()
  })
}

async function main() {
  const spec = JSON.parse(readFileSync(specPath, 'utf8'))
  const docker = onBox && !asJob ? startDocker() : Promise.resolve()
  const env = suiteEnvironment(spec)
  // It arrives in parts, numbered in order.
  const whole = `${treePath}.tgz`
  spawnSync('sh', ['-c', 'cat "$0"/* > "$1" && chmod 644 "$1"', treePath, whole])
  let candidate = null
  if (spec.capture) {
    const hash = createHash('sha256').update(spec.capture.spec)
    await pipeline(createReadStream(whole), createGunzip(), async chunks => { for await (const chunk of chunks) hash.update(chunk) })
    candidate = hash.digest('hex')
  }
  const problem = await unpack(whole)
  if (problem !== null) {
    fail(`unpacking the checkout failed: ${problem}`)
    return
  }
  await docker
  // Folders with nothing in them travel in no tar.
  spawnSync('mkdir', ['-p', spec.cwd, ...(env.HOME ? [env.HOME] : [])], asUser)
  let capture = null, reporter = null
  if (candidate === spec.capture?.candidate) {
    try {
      capture = { ...sourceCapture(spec.cwd), candidate, binding: spec.binding,
        command: JSON.parse(spec.capture.spec).argv.map(word => word.replaceAll(spec.cwd, '$CHECKOUT')) }
      reporter = assertionReporter(spec)
    } catch (error) {
      process.stderr.write(`[poise] assertion recovery evidence unavailable: ${error.message}\n`)
    }
  }
  runSuite(spec, env, capture, reporter)
}

// Started as a script on a box; tests require it for what it unpacks with.
if (require.main === module) main().catch((error) => fail(error.message))
module.exports = { JOB_UNPACK, onlyImageFolders, sourceCapture, assertionResult }
