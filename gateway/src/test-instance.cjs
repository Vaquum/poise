// Runs on a disposable test job, a Render one-off job of the workspace image: fetches the suite, the checkout and
// test-box.cjs from the relay, runs them there and sends the output back. A job has no Docker, so the suite finds a
// `docker` and a Docker socket here that only tell the relay to move it to a sandbox, which has. Render destroys the
// job when this process ends, so everything that goes wrong here ends it. test-relay.ts serves this file and starts it
// under `timeout`. docs/Operating.md, "Agents' test suites".
'use strict'
const { spawn } = require('node:child_process')
const { chmodSync, createWriteStream, mkdirSync, mkdtempSync, writeFileSync } = require('node:fs')
const { createServer } = require('node:net')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { Readable } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const { setTimeout: sleep } = require('node:timers/promises')

// As `node -e CODE ARG...` gives them, which is how test-relay.ts starts this. Tests name a folder to unpack into.
const [script, id, token, root = '/'] = process.argv.slice(1)
const relay = script.replace(/\/instance$/, '')
const headers = { authorization: `Bearer ${token}` }
const FRAME = { stdout: 1, stderr: 2, exit: 3 }
const RUNNER_FAILED = 125
// What test-box.cjs says when a suite ended without a result.
const NO_RESULT = /\[poise\] no test result: (.*?)\. This says nothing/
const OUTPUT_TAIL_CHARS = 64 * 1024
const SEND_MS = 250
// A heartbeat tells the relay this job lives, and tells this job whether the run still does.
const HEARTBEAT_MS = 10_000
const BATCH_BYTES = 512 * 1024
const MAX_QUEUED_BYTES = 8 * 1024 * 1024
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
let stderrTail = ''
let wantsDocker = false
let posted = 0

function enqueue(type, payload) {
  if (wantsDocker) return
  if (type === FRAME.stderr) stderrTail = (stderrTail + payload).slice(-OUTPUT_TAIL_CHARS)
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

/** One POST, retried over a passing hiccup. A relay that stays away or disowns the run ends this job. */
async function post(path, body) {
  // Output is numbered once, so a post the relay took before its answer was lost is not taken twice.
  const target = path.startsWith('output') ? `${path}${path.includes('?') ? '&' : '?'}seq=${(posted += 1)}` : path
  for (let attempt = 1; ; attempt += 1) {
    let problem
    try {
      const response = await fetch(`${relay}/runs/${id}/${target}`, { method: 'POST', headers, body })
      if (response.ok) return
      problem = `HTTP ${response.status}`
      if (response.status < 500) attempt = ATTEMPTS
    } catch (error) {
      problem = String(error.cause ?? error)
    }
    // The attempts bound how long a lost relay keeps this job alive. This line reaches Render's logs alone.
    if (attempt >= ATTEMPTS) {
      console.error(`[poise] ending this job: the relay answered ${path.split('?')[0]} with ${problem}`)
      process.exit(1)
    }
    await sleep(2_000)
  }
}

/** The only sender, so output keeps its order and the exit status comes last. */
async function sender() {
  let lastSent = Date.now()
  for (;;) {
    if (wantsDocker) {
      // What the suite started goes too: on Render the job's end takes it, and elsewhere nothing would.
      try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
      await post('docker', Buffer.alloc(0))
      process.exit(0)
    } else if (queue.length) {
      await post('output', takeBatch())
      lastSent = Date.now()
    } else if (exitCode !== null) {
      const why = exitCode === RUNNER_FAILED ? NO_RESULT.exec(stderrTail)?.[1] : undefined
      await post(`output?end=1&exit=${exitCode}${why ? `&why=${encodeURIComponent(why)}` : ''}`, frame(FRAME.exit, Buffer.from(String(exitCode))))
      process.exit(0)
    } else if (Date.now() - lastSent >= HEARTBEAT_MS) {
      await post('output', Buffer.alloc(0))
      lastSent = Date.now()
    } else {
      await sleep(SEND_MS)
    }
  }
}

/** Whatever reaches for Docker here, by its command or its socket, asks for a sandbox. */
async function dockerTrap(work) {
  const socket = join(work, 'docker.sock')
  const server = createServer((connection) => {
    connection.destroy()
    wantsDocker = true
  })
  await new Promise((done, reject) => { server.once('error', reject).listen(socket, done) })
  server.unref()
  // The suite runs as another user on a test box of tests' own.
  chmodSync(socket, 0o666)
  const bin = join(work, 'bin')
  mkdirSync(bin)
  for (const name of ['docker', 'docker-compose']) {
    writeFileSync(join(bin, name), `#!/bin/sh\n'${process.execPath}' -e "require('net').connect(process.argv[1])" '${socket}'\nsleep 60\nexit 1\n`, { mode: 0o755 })
  }
  return { socket, bin }
}

async function fetchFrom(path, init = {}) {
  const response = await fetch(`${relay}/${path}`, init)
  if (!response.ok || !response.body) throw new Error(`the relay answered GET ${path.split('/').at(-1)} with HTTP ${response.status}`)
  return response
}

async function main() {
  void sender()
  const work = mkdtempSync(join(tmpdir(), 'poise-job-'))
  const trap = await dockerTrap(work)
  const boxScript = join(work, 'box.cjs')
  writeFileSync(boxScript, Buffer.from(await (await fetchFrom('instance/box')).arrayBuffer()))
  const spec = await (await fetchFrom(`runs/${id}/spec`, { headers })).json()
  spec.env = { ...spec.env, PATH: [trap.bin, spec.env.PATH].filter(Boolean).join(':') }
  // No socket here is Docker's, so one the agent's environment named is the trap too. A remote engine may still be reached.
  if (!/^(tcp|ssh|https?):/.test(spec.env.DOCKER_HOST ?? '')) spec.env.DOCKER_HOST = `unix://${trap.socket}`
  const specPath = join(work, 'spec.json')
  writeFileSync(specPath, JSON.stringify(spec))
  const tree = join(work, 'tree')
  mkdirSync(tree)
  await pipeline(Readable.fromWeb((await fetchFrom(`runs/${id}/tree`, { headers })).body), createWriteStream(join(tree, '000000')))

  // test-box.cjs unpacks and runs the suite as it does on a sandbox, without starting a Docker of its own.
  child = spawn(process.execPath, [boxScript, specPath, tree, root], { env: { ...process.env, POISE_TEST_JOB: '1' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', (chunk) => enqueue(FRAME.stdout, chunk))
  child.stderr.on('data', (chunk) => enqueue(FRAME.stderr, chunk))
  child.once('error', (error) => {
    enqueue(FRAME.stderr, `[poise] no test result: the test box could not start its script: ${error.message}. This says nothing about your code. Skip local tests for this work: don't retry, and don't run parts of it. Push your change and let CI run the tests.\n`)
    exitCode = RUNNER_FAILED
  })
  child.once('close', (code) => { exitCode = code ?? RUNNER_FAILED })
}

main().catch((error) => {
  enqueue(FRAME.stderr, `[poise] no test result: the test box failed: ${error.message}. This says nothing about your code. Skip local tests for this work: don't retry, and don't run parts of it. Push your change and let CI run the tests.\n`)
  exitCode = RUNNER_FAILED
})
