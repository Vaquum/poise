#!/usr/bin/env node
// Runs a test suite on a disposable test instance and answers as if it had run here: the suite's
// output on stdout and stderr, and its exit code. hook.cjs and sitecustomize.py start this in the
// suite's place. docs/Operating.md, "Agents' test suites".
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createGzip } from 'node:zlib'

const HERE = dirname(fileURLToPath(import.meta.url))
const LEASE_MS = 10_000
const CHUNK_BYTES = 8 * 1024 * 1024
// The first bytes go at once: a proxy gives up on a download that stays silent for long.
const FIRST_CHUNK_BYTES = 64 * 1024
const FRAME = { heartbeat: 0, stdout: 1, stderr: 2, exit: 3, fail: 4, ready: 5, outOfMemory: 6 }
// How a relay marks an instance that ended without reporting, which is how running out of memory can look.
const VANISHED = 137
// What a suite cannot run without although git ignores it.
const DEPENDENCIES = new Set(['node_modules', '.venv', 'venv'])
// Nothing a suite needs: credentials by name, and what only the provider CLIs and Poise read.
const SECRET_NAME = /token|key|secret|auth|cookie|pass|credential|bearer|session|private/i
const AGENT_NAME = /^(ANTHROPIC|AWS|AZURE|CCR|CLAUDE|CLAUDECODE|CLOUD_ML|CLOUDSDK|CODEX|CURSOR|GCLOUD|GEMINI|GH|GITHUB|GIT|GOOGLE|GROK|OPENAI|SSH|XAI|AGENT_INTERFACE|POISE_NATIVE|BASH_DEFAULT_TIMEOUT|BASH_MAX_TIMEOUT)(_|$)/i
const SECRET_VALUE = /gh[pousr]_[A-Za-z0-9]|github_pat_|\bsk-[A-Za-z0-9]|:\/\/[^\s/@]+@/
const LOCAL_ONLY = new Set(['_', 'OLDPWD', 'PWD', 'SHLVL', 'GOMAXPROCS', 'RIPGREP_CONFIG_PATH'])

/** The environment a suite gets: this one, without what must not reach a test instance. */
export function testEnvironment(env, hooks = HERE) {
  const result = {}
  for (const [name, value] of Object.entries(env)) {
    if (!value || LOCAL_ONLY.has(name) || SECRET_NAME.test(name) || AGENT_NAME.test(name) || SECRET_VALUE.test(value)) continue
    result[name] = value
  }
  const pythonPath = (result.PYTHONPATH ?? '').split(':').filter((entry) => entry && entry !== hooks).join(':')
  const nodeOptions = (result.NODE_OPTIONS ?? '').replace(`--require "${join(hooks, 'hook.cjs')}"`, '').trim()
  delete result.PYTHONPATH
  delete result.NODE_OPTIONS
  if (pythonPath) result.PYTHONPATH = pythonPath
  if (nodeOptions) result.NODE_OPTIONS = nodeOptions
  return result
}

function git(cwd, ...args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'buffer', maxBuffer: 1024 ** 3 })
  return result.status === 0 ? result.stdout : null
}

function gitPaths(cwd, ...args) {
  return git(cwd, ...args)?.toString().split('\0').filter(Boolean) ?? []
}

/**
 * What a suite started in `cwd` needs, as absolute paths: the checkout's own files without what git
 * ignores, its dependencies, its .git, and the interpreter's folders `also` names when no test instance
 * has them. Throws when that would carry something that must stay here.
 */
export function filesToSend(cwd, also = [], env = process.env, home = homedir()) {
  const paths = []
  const top = git(cwd, 'rev-parse', '--show-toplevel')?.toString().trim()
  if (top) {
    for (const name of gitPaths(top, 'ls-files', '-z', '--cached', '--others', '--exclude-standard')) paths.push(join(top, name))
    for (const name of gitPaths(top, 'ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory')) {
      if (DEPENDENCIES.has(basename(name))) paths.push(join(top, name).replace(/\/$/, ''))
    }
    paths.push(join(top, '.git'))
    // A linked worktree's .git is a file naming this folder, which may be anywhere.
    const gitDir = resolve(top, git(top, 'rev-parse', '--git-common-dir')?.toString().trim() ?? '.git')
    const config = join(gitDir, 'config')
    if (existsSync(config) && /extraheader|:\/\/[^\s/@]+@/i.test(readFileSync(config, 'utf8'))) {
      throw new Error(`${config} holds a credential, which must not reach a test instance`)
    }
    if (relative(top, gitDir).startsWith('..')) paths.push(gitDir)
  } else {
    const holdsSecrets = [home, env.TMPDIR].filter(Boolean).some((place) => !relative(cwd, place).startsWith('..'))
    if (holdsSecrets) throw new Error(`run the suite from a checkout: ${cwd} holds what must not reach a test instance`)
    paths.push(cwd)
  }
  // Every test instance has what the image ships.
  for (const path of also) if (!/^\/(opt|usr)\//.test(path) && existsSync(path)) paths.push(path, realpathSync(path))
  return [...new Set(paths)].filter((path) => {
    try { return Boolean(lstatSync(path)) } catch { return false }
  })
}

/** Reads a stream of [type, 4-byte length, payload] frames, whatever pieces they arrive in. */
export function frameReader(onFrame) {
  let buffered = Buffer.alloc(0)
  return (chunk) => {
    buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk
    while (buffered.length >= 5) {
      const end = 5 + buffered.readUInt32BE(1)
      if (buffered.length < end) break
      onFrame(buffered[0], buffered.subarray(5, end))
      buffered = buffered.subarray(end)
    }
  }
}

function say(message) {
  process.stderr.write(`[poise] ${message}\n`)
}

/**
 * Where to remember that this repository's suites need the larger plan. Running out of memory takes minutes
 * each time, longer than an agent's shell may wait, so it should happen once per repository.
 */
function largerMarker(cwd) {
  const origin = git(cwd, 'remote', 'get-url', 'origin')?.toString().trim() ?? cwd
  return join(HERE, `larger-${createHash('sha256').update(origin).digest('hex').slice(0, 16)}`)
}

/** Exits once what is written has gone out: writes to a pipe are asynchronous, and exit would drop them. */
function finish(code) {
  process.stdout.write('', () => process.stderr.write('', () => process.exit(code)))
}

function die(message, code = 125) {
  say(message)
  finish(code)
}

async function main(args) {
  const also = []
  while (args[0] === '--also') also.push(args.splice(0, 2)[1])
  const command = args.slice(1)
  const [relay, key] = readFileSync(join(HERE, 'relay'), 'utf8').split('\n')
  const headers = { authorization: `Bearer ${key}` }
  const cwd = process.cwd()
  const paths = filesToSend(cwd, also)

  const call = async (method, path, body) => {
    const response = await fetch(`${relay}${path}`, { method, headers, body })
    if (!response.ok) throw new Error(`the test relay answered ${method} ${path} with HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`)
    return response
  }

  let current = null
  for (const [signal, number] of [['SIGTERM', 15], ['SIGINT', 2], ['SIGHUP', 1]]) {
    process.once(signal, () => {
      const exit = () => finish(128 + number)
      if (!current) exit()
      call('DELETE', `/runs/${current}`).then(exit, exit)
      setTimeout(exit, 3_000)
    })
  }

  const sendTree = async () => {
    const id = current
    const tar = spawn('tar', ['-C', '/', '--null', '-T', '-', '-cf', '-'], { stdio: ['pipe', 'pipe', 'pipe'] })
    const closed = new Promise((done) => { tar.on('close', done) })
    let errors = ''
    tar.stderr.on('data', (chunk) => { errors = (errors + chunk).slice(-2000) })
    tar.stdin.end(paths.map((path) => path.replace(/^\//, '')).join('\0'))
    const gzip = createGzip({ level: 1 })
    tar.stdout.pipe(gzip)
    let parts = []
    let size = 0
    let total = 0
    let limit = FIRST_CHUNK_BYTES
    const started = Date.now()
    for await (const chunk of gzip) {
      parts.push(chunk)
      size += chunk.length
      total += chunk.length
      if (size >= limit) {
        await call('POST', `/runs/${id}/tree`, Buffer.concat(parts))
        parts = []
        size = 0
        limit = CHUNK_BYTES
      }
    }
    // tar's exit 1 says a file changed as it was read, which a live checkout does.
    const code = await closed
    if (code !== 0 && code !== 1) throw new Error(`tar exited with ${code}: ${errors}`)
    await call('POST', `/runs/${id}/tree?end=1`, Buffer.concat(parts))
    say(`checkout sent, ${Math.round(total / 1024 / 1024)} MB in ${Math.round((Date.now() - started) / 1000)} s. The instance is unpacking it, then runs the suite.`)
  }

  /** Runs the suite once, and answers with its exit code and whether it ran out of memory. */
  const runOnce = async (larger) => {
    const created = await call('POST', '/runs', JSON.stringify({ argv: command, cwd, env: testEnvironment(process.env), larger }))
    current = (await created.json()).id
    const lease = setInterval(() => { call('POST', `/runs/${current}/lease`).catch(() => {}) }, LEASE_MS)
    const result = { exitCode: null, outOfMemory: false }
    const output = await call('GET', `/runs/${current}/output`)
    const read = frameReader((type, payload) => {
      if (type === FRAME.stdout) process.stdout.write(payload)
      else if (type === FRAME.stderr) process.stderr.write(payload)
      else if (type === FRAME.exit) result.exitCode = Number(payload.toString())
      else if (type === FRAME.outOfMemory) result.outOfMemory = true
      else if (type === FRAME.fail) {
        if (payload[0] === VANISHED && !larger) result.outOfMemory = true
        else die(payload.subarray(1).toString(), payload[0] === VANISHED ? 125 : payload[0])
      } else if (type === FRAME.ready) {
        say('the instance is up. Sending the checkout.')
        sendTree().catch((error) => die(`sending the checkout failed: ${error.message}`))
      }
    })
    try {
      for await (const chunk of output.body) {
        read(Buffer.from(chunk))
        for (const stream of [process.stdout, process.stderr]) if (stream.writableNeedDrain) await once(stream, 'drain')
      }
    } catch (error) {
      die(`the connection to the test relay broke: ${error.cause?.message ?? error.message}`)
    }
    clearInterval(lease)
    return result
  }

  say('this suite runs on a disposable test instance; files it changes stay there. Starting one.')
  const marker = largerMarker(cwd)
  const larger = existsSync(marker)
  let result = await runOnce(larger)
  if (result.outOfMemory && !larger) {
    writeFileSync(marker, '')
    say('it ran out of memory on the smallest instance. Running it again on a larger one.')
    result = await runOnce(true)
  }
  if (result.exitCode === null) die('the connection to the test relay ended before the suite did')
  else finish(result.exitCode)
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => die(error.message))
}
