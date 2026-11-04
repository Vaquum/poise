// Runs on a disposable test instance: unpacks the checkout, runs the suite and sends its output to the
// relay. Render destroys the instance when this process ends, so everything that goes wrong here ends it.
// test-relay.ts serves this file and starts it under `timeout`. docs/Operating.md, "Agents' test suites".
'use strict'
const { spawn } = require('node:child_process')
const { mkdirSync, readFileSync } = require('node:fs')
const { constants } = require('node:os')
const { Readable } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const { setTimeout: sleep } = require('node:timers/promises')

// As `node -e CODE ARG...` gives them, which is how test-relay.ts starts this.
const [script, id, token, root = '/'] = process.argv.slice(1)
const relay = script.replace(/\/instance$/, '')
const headers = { authorization: `Bearer ${token}` }
const FRAME = { stdout: 1, stderr: 2, exit: 3, outOfMemory: 6 }
const OUT_OF_MEMORY = /heap out of memory|reaching memory limit|cannot allocate memory/i
const OUTPUT_TAIL_CHARS = 64 * 1024
const SEND_MS = 250
// A heartbeat tells the relay this instance lives, and tells this instance whether the run still does.
const HEARTBEAT_MS = 10_000
const BATCH_BYTES = 512 * 1024
const MAX_QUEUED_BYTES = 8 * 1024 * 1024
const QUIET_MS = 2_000
const ATTEMPTS = 3

function frame(type, payload) {
  const header = Buffer.alloc(5)
  header[0] = type
  header.writeUInt32BE(payload.length, 1)
  return Buffer.concat([header, payload])
}

let queue = []
let queued = 0
let child = null
let exitCode = null
let lastOutput = 0
let outputTail = ''

function enqueue(type, payload) {
  lastOutput = Date.now()
  outputTail = (outputTail + payload).slice(-OUTPUT_TAIL_CHARS)
  queue.push(frame(type, Buffer.from(payload)))
  queued += payload.length
  if (queued > MAX_QUEUED_BYTES) {
    child?.stdout.pause()
    child?.stderr.pause()
  }
}

function takeBatch() {
  let size = 0
  let count = 0
  while (count < queue.length && size < BATCH_BYTES) size += queue[count++].length
  const batch = Buffer.concat(queue.slice(0, count))
  queue = queue.slice(count)
  queued = Math.max(0, queued - size)
  if (queued <= MAX_QUEUED_BYTES) {
    child?.stdout.resume()
    child?.stderr.resume()
  }
  return batch
}

/** One POST of output, retried over a passing hiccup. A relay that stays away or disowns the run ends this instance. */
async function post(body, end) {
  for (let attempt = 1; ; attempt += 1) {
    let problem
    try {
      const response = await fetch(`${relay}/runs/${id}/output${end ? '?end=1' : ''}`, { method: 'POST', headers, body })
      if (response.ok) return
      problem = `HTTP ${response.status}`
      if (response.status < 500) attempt = ATTEMPTS
    } catch (error) {
      problem = String(error.cause ?? error)
    }
    // The attempts bound how long a lost relay keeps this instance alive. This line reaches Render's logs alone.
    if (attempt >= ATTEMPTS) {
      console.error(`[poise] ending this instance: the relay answered output with ${problem}`)
      process.exit(1)
    }
    await sleep(2_000)
  }
}

/** The only sender, so output keeps its order and the exit status comes last. */
async function sender() {
  let lastSent = Date.now()
  for (;;) {
    if (queue.length) {
      await post(takeBatch(), false)
      lastSent = Date.now()
    } else if (exitCode !== null) {
      await post(frame(FRAME.exit, Buffer.from(String(exitCode))), true)
      process.exit(0)
    } else if (Date.now() - lastSent >= HEARTBEAT_MS) {
      await post(Buffer.alloc(0), false)
      lastSent = Date.now()
    } else {
      await sleep(SEND_MS)
    }
  }
}

/** Whether the suite failed for want of memory: the kernel killed something here, or a runtime said so. */
function ranOutOfMemory() {
  try {
    if (/^oom_kill [1-9]/m.test(readFileSync('/sys/fs/cgroup/memory.events', 'utf8'))) return true
  } catch {
    // No such file outside a test instance.
  }
  return OUT_OF_MEMORY.test(outputTail)
}

/** The suite ended. Its pipes can still hold output, and something it left behind can keep them open forever. */
async function finish(code) {
  const ended = child
  let closed = false
  ended?.once('close', () => { closed = true })
  while (ended && !closed && (queue.length || Date.now() - lastOutput < QUIET_MS)) await sleep(50)
  if (ranOutOfMemory()) queue.push(frame(FRAME.outOfMemory, Buffer.alloc(0)))
  exitCode = code
}

async function main() {
  void sender()
  const spec = await (await fetch(`${relay}/runs/${id}/spec`, { headers })).json()

  const tar = spawn('tar', ['-xzf', '-', '-C', root, '--no-same-owner'], { stdio: ['pipe', 'ignore', 'pipe'] })
  tar.stderr.on('data', (chunk) => enqueue(FRAME.stderr, chunk))
  const unpacked = new Promise((done) => { tar.on('close', done) })
  const tree = await fetch(`${relay}/runs/${id}/tree`, { headers })
  if (!tree.ok || !tree.body) throw new Error(`the relay answered GET tree with HTTP ${tree.status}`)
  await pipeline(Readable.fromWeb(tree.body), tar.stdin)
  const unpackCode = await unpacked
  if (unpackCode !== 0) throw new Error(`unpacking the checkout failed: tar exited with ${unpackCode}`)

  const env = { ...spec.env, PATH: [spec.env.PATH, process.env.PATH].filter(Boolean).join(':') }
  if (!env.PLAYWRIGHT_BROWSERS_PATH && process.env.PLAYWRIGHT_BROWSERS_PATH) env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH
  for (const name of ['TMPDIR', 'TMP', 'TEMP']) if (env[name]) mkdirSync(env[name], { recursive: true })

  child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', (chunk) => enqueue(FRAME.stdout, chunk))
  child.stderr.on('data', (chunk) => enqueue(FRAME.stderr, chunk))
  child.once('error', (error) => {
    enqueue(FRAME.stderr, `[poise] cannot start ${spec.argv[0]}: ${error.message}\n`)
    child = null
    void finish(127)
  })
  child.once('exit', (code, signal) => { void finish(code ?? 128 + (constants.signals[signal] ?? 0)) })
}

main().catch((error) => {
  enqueue(FRAME.stderr, `[poise] the test instance failed: ${error.message}\n`)
  child = null
  void finish(125)
})
