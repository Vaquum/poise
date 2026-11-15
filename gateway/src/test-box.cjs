// Runs on a disposable test box, as root: starts Docker, unpacks the checkout and runs the suite exactly as it was
// typed, as the workspace's user. test-relay.ts uploads and starts this on a sandbox. On a job, test-instance.cjs starts
// it as the workspace's user, and Docker is not there to start. docs/Operating.md, "Agents' test suites".
// Its output and exit code are what the agent gets, so everything that goes wrong here says so and exits with 125.
'use strict'
const { spawn, spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { accessSync, chmodSync, chownSync, constants: { W_OK }, createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync, symlinkSync, unlinkSync, writeFileSync } = require('node:fs')
const { dirname, join } = require('node:path')
const { constants } = require('node:os')
const { pipeline } = require('node:stream/promises')
const { setTimeout: sleep } = require('node:timers/promises')
const { createGunzip } = require('node:zlib')

const [specPath, treePath, root = '/'] = process.argv.slice(2)
// A real box unpacks at the root and has a system to start. Tests name a folder instead.
const onBox = root === '/'
const asJob = Boolean(process.env.POISE_TEST_JOB)
const asUser = onBox ? { uid: 10001, gid: 10001 } : {}
const captureUser = require.main === module ? asUser : {}
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
const ASSERTION_VITEST = '/opt/poise-assertions/node_modules/vitest/vitest.mjs'
const SYSTEM_PATH = '/usr/local/bin:/usr/bin:/bin'
const MAX_SOURCE_ENTRIES = 10_000

function assertionTarget(argv) {
  const [node, runner, command, file] = argv
  return argv.length === 4 && node === '/usr/local/bin/node' && runner === ASSERTION_VITEST && command === 'run'
    && typeof file === 'string' && /^tests\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.test\.mjs$/.test(file) ? file : null
}

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

function gitBytes(cwd, ...args) {
  // Unpacking runs as the suite user, so this must too when root; otherwise run as self (tests, jobs).
  const identity = process.getuid?.() === 0 ? captureUser : {}
  const result = spawnSync('git', ['--no-replace-objects', '-c', 'core.fsmonitor=false', '-C', cwd, ...args], {
    env: { PATH: SYSTEM_PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '' },
    timeout: 5_000, maxBuffer: 16 * 1024 * 1024, ...identity })
  if (result.status !== 0) throw new Error('test capture git identity is unavailable')
  return result.stdout
}

const git = (...args) => gitBytes(...args).toString('utf8')
const gitHash = (type, data) => createHash('sha1').update(type + ' ' + data.length + '\0').update(data).digest('hex')
const safePath = path => path.split('/').every(part => part && !['.', '..', '.git'].includes(part) && !/[\x00-\x1f\ufffd]/.test(part))

function gitObject(top, type, id) {
  if (!/^[a-f0-9]{40}$/.test(id)) throw new Error('invalid git object identity')
  const data = gitBytes(top, 'cat-file', type, id)
  if (gitHash(type, data) !== id) throw new Error('git object does not match the prepared base')
  return data
}

// Git can read an uploaded loose object without rehashing it. Authenticate the
// commit and each tree used for the clean comparison, including nested paths.
function baseTree(top, base) {
  const commit = gitObject(top, 'commit', base).toString('utf8')
  const tree = /^tree ([a-f0-9]{40})\n/.exec(commit)?.[1]
  if (!tree) throw new Error('prepared base has no authenticated tree')
  const expected = new Map()
  let visited = 0
  function read(oid, prefix, depth) {
    if (depth > 32 || ++visited > 512) throw new Error('prepared tree exceeds capture bound')
    const bytes = gitObject(top, 'tree', oid)
    for (let start = 0; start < bytes.length;) {
      const end = bytes.indexOf(0, start)
      const match = end >= 0 && /^(40000|100644|100755|120000) (.+)$/.exec(bytes.subarray(start, end).toString('utf8'))
      const name = match && match[2]
      if (!name || !safePath(name) || name.includes('/') || end + 21 > bytes.length || expected.size >= MAX_SOURCE_ENTRIES) {
        throw new Error('prepared tree contains an unsupported source entry')
      }
      const id = bytes.subarray(end + 1, end + 21).toString('hex')
      const path = prefix + name
      if (match[1] === '40000') read(id, path + '/', depth + 1)
      else expected.set(path, match[1] + ' blob ' + id + '\t' + path)
      start = end + 21
    }
  }
  read(tree, '', 0)
  return expected
}

// These dependency directories travel with offload but the standalone
// collector never uses them. Tracked entries still enter through the base tree.
const DEPENDENCIES = new Set(['node_modules', '.venv', 'venv'])

/** Compare physical captured source independently of uploaded index and ignore rules. */
function sourceCapture(cwd) {
  const top = git(cwd, 'rev-parse', '--show-toplevel').trim()
  if (top !== cwd || realpathSync(top) !== top) throw new Error('assertion capture requires the checkout root')
  const base = git(top, 'rev-parse', 'HEAD').trim()
  const origin = git(top, 'remote', 'get-url', 'origin').trim()
  const repository = /^(?:https:\/\/github.com\/|git@github.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(origin)?.[1]
  if (!repository) throw new Error('test capture repository is unavailable')
  const expected = baseTree(top, base)
  const paths = new Set(expected.keys())
  let visited = 0
  function collect(prefix, depth) {
    if (depth > 32) throw new Error('test capture exceeds source depth bound')
    for (const entry of readdirSync(join(top, prefix), { withFileTypes: true })) {
      if (++visited > MAX_SOURCE_ENTRIES) throw new Error('test capture exceeds source entry bound')
      if (entry.name === '.git' || DEPENDENCIES.has(entry.name)) continue
      const path = prefix + entry.name
      if (!safePath(path)) throw new Error('test capture contains an unsupported source path')
      if (entry.isDirectory()) collect(path + '/', depth + 1)
      else paths.add(path)
    }
  }
  collect('', 0)
  const actual = new Map([...paths].map(path => {
    const file = join(top, path)
    const stat = lstatSafe(file)
    if (!stat) return [path, 'missing\t' + path]
    if (realpathSync(dirname(file)) !== dirname(file)) throw new Error('test capture contains a linked source directory')
    if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error('test capture contains an unsupported source entry')
    if (stat.size > 32 * 1024 * 1024 || captureUser.uid !== undefined && stat.uid !== captureUser.uid) {
      throw new Error('test capture contains an oversized or foreign source entry')
    }
    const data = stat.isSymbolicLink() ? Buffer.from(readlinkSync(file)) : readFileSync(file)
    const mode = stat.isSymbolicLink() ? '120000' : stat.mode & 0o111 ? '100755' : '100644'
    return [path, mode + ' blob ' + gitHash('blob', data) + '\t' + path]
  }))
  return { top, base, repository, paths, source: createHash('sha256').update(JSON.stringify([...actual.values()].sort())).digest('hex'),
    clean: actual.size === expected.size && [...actual].every(([path, entry]) => expected.get(path) === entry) }
}

function lstatSafe(path) {
  try { return lstatSync(path) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

// The supported case compares one repository text file with a literal. Treat
// the entire checkout as data, including the test file. Never import its
// configuration, dependencies or executable code into the collector.
const TEXT_ASSERTION = /^import \{ expect, test \} from 'vitest'\r?\nimport \{ readFileSync \} from 'node:fs'\r?\ntest\("([a-zA-Z0-9][a-zA-Z0-9 _.-]{0,119})", \(\) => expect\(readFileSync\("([a-zA-Z0-9_./-]+)", "utf8"\)\)\.toBe\(("(?:[^"\\\r\n]|\\["\\/bfnrt]|\\u[a-fA-F0-9]{4})*")\)\)\r?\n?$/

function assertionInput(capture, path, limit) {
  if (!safePath(path) || !capture.paths.has(path)) throw new Error('assertion input is outside captured source')
  const file = join(capture.top, path)
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.uid !== asUser.uid || stat.size > limit || realpathSync(file) !== file) {
    throw new Error('assertion input is not a bounded regular source file')
  }
  return readFileSync(file, 'utf8')
}

function assertionSuite(spec, capture, file) {
  const input = TEXT_ASSERTION.exec(assertionInput(capture, file, 8192))
  if (!input) return null
  const [, test, path, literal] = input
  const expected = JSON.parse(literal)
  const actual = assertionInput(capture, path, 8192)
  const cwd = mkdtempSync('/tmp/poise-assertions-')
  chmodSync(cwd, 0o755)
  const scratch = join(cwd, 'scratch')
  mkdirSync(scratch, { mode: 0o700 })
  chownSync(scratch, asUser.uid, asUser.gid)
  mkdirSync(join(cwd, 'node_modules'))
  symlinkSync(dirname(ASSERTION_VITEST), join(cwd, 'node_modules/vitest'))
  mkdirSync(dirname(join(cwd, file)), { recursive: true })
  writeFileSync(join(cwd, file), 'import { expect, test } from "vitest"\ntest('
    + JSON.stringify(test) + ', () => expect(' + JSON.stringify(actual) + ').toBe(' + JSON.stringify(expected) + '))\n')
  const config = join(cwd, 'vitest.config.mjs'), report = join(scratch, 'result.json')
  writeFileSync(config, 'export default ' + JSON.stringify({ cacheDir: join(scratch, 'vite'), test: { include: [file], maxWorkers: 1 } }))
  return { cwd, file, test, report, env: { PATH: SYSTEM_PATH, HOME: scratch, TMPDIR: scratch, CI: '1', NO_COLOR: '1' },
    argv: [...spec.argv, '--config', config, '--configLoader', 'native', '--reporter=default', '--reporter=json', '--outputFile.json=' + report],
    causeDigest: createHash('sha256').update(JSON.stringify([actual, expected])).digest('hex') }
}

function assertionResult(suite) {
  if (statSync(suite.report).size > 40 * 1024) return null
  const report = JSON.parse(readFileSync(suite.report, 'utf8'))
  const result = report.testResults?.[0]
  const test = result?.assertionResults?.[0]
  if (report.success !== false || report.numTotalTests !== 1 || report.numFailedTests !== 1
    || report.testResults.length !== 1 || result.name !== join(suite.cwd, suite.file) || result.status !== 'failed' || result.message
    || result.assertionResults.length !== 1 || test.fullName !== suite.test || test.status !== 'failed'
    || test.failureMessages?.length !== 1 || !test.failureMessages[0].startsWith('AssertionError: ')) return null
  const cause = test.failureMessages[0].replaceAll(suite.cwd, '$CHECKOUT')
  return { failures: [{ file: suite.file, test: suite.test, cause, causeDigest: suite.causeDigest }],
    totals: [{ file: suite.file, test: suite.test, total: 1 }] }
}

function runSuite(spec, env, evidence) {
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
        if (status === 1 && closed && evidence) {
          try {
            const { suite, capture, reportTo } = evidence
            const assertions = assertionResult(suite)
            if (assertions) {
              const body = JSON.stringify({ ...capture, ...assertions, exit: status })
              if (Buffer.byteLength(body) <= 40 * 1024) {
                const response = await fetch(reportTo.url, { method: 'POST', headers: { authorization: 'Bearer ' + reportTo.token },
                  body, signal: AbortSignal.timeout(5_000) })
                if (!response.ok) throw new Error('collector was refused with HTTP ' + response.status)
              }
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
  const { reportTo, ...spec } = JSON.parse(readFileSync(specPath, 'utf8'))
  const file = onBox && !asJob && process.platform === 'linux' && process.getuid() === 0 ? assertionTarget(spec.argv) : null
  // The collector credential never reaches a process or filesystem shared
  // with the suite. The standalone mode never starts Docker.
  if (reportTo) unlinkSync(specPath)
  const docker = onBox && !asJob && !file ? startDocker() : Promise.resolve()
  const env = suiteEnvironment(spec)
  // It arrives in parts, numbered in order.
  const whole = `${treePath}.tgz`
  spawnSync('sh', ['-c', 'cat "$0"/* > "$1" && chmod 644 "$1"', treePath, whole])
  let candidate = null
  if (file && spec.capture && reportTo) {
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
  if (file && candidate && candidate === spec.capture?.candidate && reportTo) {
    try {
      const { top, paths, ...identity } = sourceCapture(spec.cwd)
      if (identity.repository === spec.binding.repository && identity.base === spec.binding.base) {
        const suite = assertionSuite(spec, { top, paths }, file)
        if (suite) {
          runSuite(suite, suite.env, { suite, reportTo, capture: { ...identity, candidate, binding: spec.binding, command: spec.argv } })
          return
        }
      }
    } catch (error) {
      process.stderr.write(`[poise] assertion recovery evidence unavailable: ${error.message}\n`)
    }
  }
  if (file) {
    fail('this command requires a captured standalone text assertion')
    return
  }
  runSuite(spec, env, null)
}

// Started as a script on a box; tests require it for what it unpacks with.
if (require.main === module) main().catch((error) => fail(error.message))
module.exports = { JOB_UNPACK, onlyImageFolders, sourceCapture, assertionTarget }
