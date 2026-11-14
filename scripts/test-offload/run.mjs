#!/usr/bin/env node
// Runs a test suite on a disposable test box and answers as if it had run here: the suite's
// output on stdout and stderr, and its exit code. hook.cjs and sitecustomize.py start this in the
// suite's place. docs/Operating.md, "Agents' test suites".
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createReadStream, createWriteStream, existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { pipeline } from 'node:stream/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createGzip, gzip } from 'node:zlib'

const HERE = dirname(fileURLToPath(import.meta.url))
const LEASE_MS = 10_000
const LIMIT_MS = 9 * 60_000
const RECOVERY_MS = 30_000
const GATEWAY_RESTART = 'the gateway restarted'
// A suite that reached for Docker on a job, which has none: it starts again on a sandbox, which has.
const USES_DOCKER = 'this suite uses Docker'
const CHUNK_BYTES = 8 * 1024 * 1024
// Leave room in one upload for gzip's framing and worst-case expansion.
const DEPENDENCY_BYTES = CHUNK_BYTES - 64 * 1024
const zip = promisify(gzip)
// The first bytes go at once: a proxy gives up on a download that stays silent for long.
const FIRST_CHUNK_BYTES = 64 * 1024
const FRAME = { heartbeat: 0, stdout: 1, stderr: 2, exit: 3, fail: 4, ready: 5 }
// What a suite cannot run without although git ignores it.
const DEPENDENCIES = new Set(['node_modules', '.venv', 'venv'])
// Nothing a suite needs: credentials by name, and what only the provider CLIs and Poise read.
const SECRET_NAME = /token|key|secret|auth|cookie|pass|credential|bearer|session|private/i
const AGENT_NAME = /^(ANTHROPIC|AWS|AZURE|CCR|CLAUDE|CLAUDECODE|CLOUD_ML|CLOUDSDK|CODEX|CURSOR|GCLOUD|GEMINI|GH|GITHUB|GIT|GOOGLE|GROK|OPENAI|SSH|XAI|AGENT_INTERFACE|POISE_NATIVE|BASH_DEFAULT_TIMEOUT|BASH_MAX_TIMEOUT)(_|$)/i
const SECRET_VALUE = /gh[pousr]_[A-Za-z0-9]|github_pat_|\bsk-[A-Za-z0-9]|:\/\/[^\s/@]+@/
const LOCAL_ONLY = new Set(['_', 'OLDPWD', 'PWD', 'SHLVL', 'GOMAXPROCS', 'RIPGREP_CONFIG_PATH'])

/** The environment a suite gets: this one, without what must not reach a test box, and without these hooks. */
export function testEnvironment(env, hooks = HERE) {
  const result = {}
  for (const [name, value] of Object.entries(env)) {
    if (!value || LOCAL_ONLY.has(name) || SECRET_NAME.test(name) || AGENT_NAME.test(name) || SECRET_VALUE.test(value)) continue
    result[name] = value
  }
  // A suite runs on the box as it was typed, so nothing there asks to be moved again.
  const pythonPath = (result.PYTHONPATH ?? '').split(':').filter((entry) => entry && entry !== hooks).join(':')
  const nodeOptions = (result.NODE_OPTIONS ?? '').replace(`--require "${join(hooks, 'hook.cjs')}"`, '').trim()
  if (pythonPath) result.PYTHONPATH = pythonPath
  else delete result.PYTHONPATH
  if (nodeOptions) result.NODE_OPTIONS = nodeOptions
  else delete result.NODE_OPTIONS
  return result
}

function git(cwd, ...args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'buffer', maxBuffer: 1024 ** 3 })
  return result.status === 0 ? result.stdout : null
}

function gitPaths(cwd, ...args) {
  return git(cwd, ...args)?.toString().split('\0').filter(Boolean) ?? []
}

/** One checkout's files, without what git ignores, and those of the repositories inside it by the same rule. */
function checkoutFiles(top) {
  const paths = []
  for (const name of gitPaths(top, 'ls-files', '-z', '--cached', '--others', '--exclude-standard')) {
    const path = join(top, name).replace(/\/$/, '')
    // git names a submodule or an embedded repository as one path, and tar would take all of it.
    if (existsSync(join(path, '.git'))) paths.push(...checkoutFiles(path).paths)
    else paths.push(path)
  }
  const dependencies = gitPaths(top, 'ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory')
    .filter((name) => DEPENDENCIES.has(basename(name))).map((name) => join(top, name).replace(/\/$/, ''))
  const gitEntry = join(top, '.git')
  paths.push(...dependencies, gitEntry)
  // A linked worktree's .git is a file naming this folder, which may be anywhere.
  const gitDir = resolve(top, git(top, 'rev-parse', '--git-common-dir')?.toString().trim() ?? '.git')
  const config = join(gitDir, 'config')
  if (existsSync(config) && /extraheader|:\/\/[^\s/@]+@/i.test(readFileSync(config, 'utf8'))) {
    throw new Error(`${config} holds a credential, which must not reach a test box`)
  }
  if (relative(top, gitDir).startsWith('..')) paths.push(gitDir)
  return { paths, dependencies, gitEntry }
}

/**
 * Every link met on the way to `path`, each where it really lives, then where `path` really is: resolved one name
 * at a time, as the system does, so a `..` after a link goes up from where the link leads. A virtualenv's
 * interpreter reaches its base through links, and a box needs them at the same paths.
 */
function wayTo(path) {
  const links = []
  let done = '/'
  const rest = path.split('/').filter(Boolean)
  while (rest.length > 0) {
    const name = rest.shift()
    if (name === '.') continue
    if (name === '..') {
      done = dirname(done)
      continue
    }
    const next = join(done, name)
    if (!lstatSync(next).isSymbolicLink()) {
      done = next
      continue
    }
    links.push(next)
    const target = readlinkSync(next)
    if (target.startsWith('/')) done = '/'
    rest.unshift(...target.split('/').filter(Boolean))
  }
  return [...links, done]
}

/**
 * What a suite started in `cwd` needs, as absolute paths: the checkout's own files without what git
 * ignores, its dependencies, its .git, and the interpreter's folders and files `also` names, with every
 * link on the way to them, when no test box has them. Throws when that would carry something that must
 * stay here.
 */
function selectedFiles(cwd, also, env, home) {
  const paths = []
  const holdsSecrets = (path) => [home, env.TMPDIR].filter(Boolean).some((place) => !relative(path, place).startsWith('..'))
  const top = git(cwd, 'rev-parse', '--show-toplevel')?.toString().trim()
  const checkout = top ? checkoutFiles(top) : null
  if (checkout) {
    paths.push(...checkout.paths)
  } else {
    if (holdsSecrets(cwd)) throw new Error(`run the suite from a checkout: ${cwd} holds what must not reach a test box`)
    paths.push(cwd)
  }
  // Every test box has its own system.
  for (const path of also) {
    if (/^\/usr(\/|$)/.test(path) || !existsSync(path)) continue
    if (holdsSecrets(path)) throw new Error(`${path} holds what must not reach a test box`)
    // Through a link a path would arrive as a folder of its own: the link goes, and where it leads.
    const steps = wayTo(path)
    if (holdsSecrets(steps.at(-1))) throw new Error(`${path} holds what must not reach a test box`)
    paths.push(...steps.filter((step) => !/^\/usr(\/|$)/.test(step)))
  }
  const present = [...new Set(paths)].filter((path) => {
    try { return Boolean(lstatSync(path)) } catch { return false }
  })
  return { ...checkout, paths: present }
}

export function filesToSend(cwd, also = [], env = process.env, home = homedir()) {
  return selectedFiles(cwd, also, env, home).paths
}

// Only cache the contiguous ignored dependency entries immediately before this checkout's .git.
// GNU tar reports the start of each entry, including any long-name records. Offsets let us keep
// one tar stream, with its original ordering and even hard links between dependencies and source.
function dependencyBoundaries({ paths, dependencies, gitEntry }) {
  if (!dependencies?.length || process.env.TAR_OPTIONS) return null
  const end = paths.indexOf(gitEntry)
  const start = end - dependencies.length
  if (start < 0 || !dependencies.every((path, index) => path === paths[start + index])) return null
  const names = [paths[start], gitEntry].map((path) => path.slice(1))
  // Only recognize names whose representation in the escaped listing is unambiguous.
  if (!names.every((name) => /^[\w./-]+$/.test(name))) return null
  if (!spawnSync('tar', ['--version'], { encoding: 'utf8' }).stdout?.startsWith('tar (GNU tar)')) return null
  return names
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

/** Exits once what is written has gone out: writes to a pipe are asynchronous, and exit would drop them. */
function finish(code) {
  process.stdout.write('', () => process.stderr.write('', () => process.exit(code)))
}

/** There is no result to give: everything that ends a run early comes through here, in words an agent can't mistake for one. */
function die(message, code = 125) {
  say(`no test result: ${message}. This says nothing about your code. Skip local tests for this work: don't retry, and don't run parts of it. Push your change and let CI run the tests.`)
  finish(code)
}

async function main(args) {
  const also = []
  while (args[0] === '--also') also.push(args.splice(0, 2)[1])
  const command = args.slice(1)
  const [relay, key] = readFileSync(join(HERE, 'relay'), 'utf8').split('\n')
  const headers = { authorization: `Bearer ${key}` }
  const cwd = process.cwd()
  // Names the checkout's history, so a repository whose suites use Docker goes to a sandbox at once.
  const repo = git(cwd, 'rev-list', '--max-parents=0', 'HEAD')?.toString().split('\n')[0] || undefined
  const request = { argv: command, cwd, env: testEnvironment(process.env), repo }
  const spec = JSON.stringify(request)
  let docker = false
  // One clock includes capture, provisioning, upload, recovery and the complete rerun.
  const shellLimit = Number(process.env.BASH_DEFAULT_TIMEOUT_MS)
  const limit = shellLimit > 0 ? Math.min(LIMIT_MS, shellLimit) : LIMIT_MS
  const lifetime = new AbortController()
  let current = null
  let ending = false
  const call = async (method, path, body, signal = lifetime.signal) => {
    const response = await fetch(`${relay}${path}`, { method, headers, body, signal })
    if (!response.ok) throw Object.assign(new Error(`the test relay answered ${method} ${path} with HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`), { status: response.status })
    return response
  }
  const stop = (code, message) => {
    if (ending) return
    ending = true
    lifetime.abort()
    const exit = () => message ? die(message, code) : finish(code)
    if (current) call('DELETE', `/runs/${current}`, undefined, AbortSignal.timeout(1_000)).then(exit, exit)
    else exit()
  }
  const deadline = setTimeout(() => stop(124, 'the test offload exhausted its total time budget'), limit)
  for (const [signal, number] of [['SIGTERM', 15], ['SIGINT', 2], ['SIGHUP', 1]]) {
    process.once(signal, () => stop(128 + number))
  }
  let selection
  try {
    selection = selectedFiles(cwd, also, process.env, homedir())
  } catch (error) {
    // The agent can do something about this one.
    say(error.message)
    finish(125)
    return
  }

  const directory = mkdtempSync(join(tmpdir(), 'poise-test-input-'))
  const boundaries = dependencyBoundaries(selection)
  const archive = join(directory, boundaries ? 'tree.tar' : 'tree.tgz')
  const specification = join(directory, 'spec.json')
  writeFileSync(specification, spec, { mode: 0o600 })
  let dependencyRange
  process.once('exit', () => rmSync(directory, { recursive: true, force: true }))
  const capture = async () => {
    const indexPath = join(directory, 'tar.index')
    const index = boundaries ? ['--block-number', '-v', '--quoting-style=escape', `--index-file=${indexPath}`] : []
    const tar = spawn('tar', [...index, '-C', '/', '--null', '-T', '-', '-cf', '-'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: boundaries ? { ...process.env, LC_ALL: 'C' } : process.env,
    })
    const closed = new Promise((done, reject) => { tar.on('close', done); tar.on('error', reject) })
    let errors = ''
    tar.stderr.on('data', (chunk) => { errors = (errors + chunk).slice(-2000) })
    tar.stdin.end(selection.paths.map((path) => path.replace(/^\//, '')).join('\0'))
    const streams = boundaries ? [tar.stdout] : [tar.stdout, createGzip({ level: 1 })]
    const hash = createHash('sha256').update(spec)
    streams.at(-1).on('data', (chunk) => hash.update(chunk))
    try {
      const [, code] = await Promise.all([pipeline(...streams, createWriteStream(archive), { signal: lifetime.signal }), closed])
      // tar's exit 1 says a file changed as it was read. Both attempts still use these exact bytes.
      if (code !== 0 && code !== 1) throw new Error(`tar exited with ${code}: ${errors}`)
      if (boundaries) {
        const offsets = new Map()
        for await (const line of createInterface({ input: createReadStream(indexPath, { signal: lifetime.signal }) })) {
          const match = /^block (\d+): (.+?)\/?$/.exec(line)
          if (!match || !boundaries.includes(match[2])) continue
          offsets.set(match[2], offsets.has(match[2]) ? NaN : Number(match[1]) * 512)
        }
        const [start, end] = boundaries.map((name) => offsets.get(name))
        if (start >= 0 && end > start && end < statSync(archive).size) dependencyRange = { start, end }
      }
      return hash.digest('hex')
    } finally {
      if (tar.exitCode === null) tar.kill()
    }
  }

  const sendTree = async (id, signal, dependencyCache) => {
    let parts = []
    let size = 0
    let total = 0
    let limit = FIRST_CHUNK_BYTES
    const started = Date.now()
    const flush = async (end = false) => {
      if (size || end) await call('POST', `/runs/${id}/tree${end ? '?end=1' : ''}`, Buffer.concat(parts), signal)
      parts = []
      size = 0
      limit = CHUNK_BYTES
    }
    const send = async (chunks) => {
      for await (const chunk of chunks) {
        parts.push(chunk)
        size += chunk.length
        total += chunk.length
        if (size >= limit) await flush()
      }
    }
    const read = (range) => createReadStream(archive, { highWaterMark: FIRST_CHUNK_BYTES, signal, ...range })
    const sendRaw = (range) => pipeline(read(range), createGzip({ level: 1 }), send, { signal })
    if (dependencyRange && dependencyCache) {
      const { start, end } = dependencyRange
      if (start > 0) await sendRaw({ end: start - 1 })
      await flush()
      for await (const chunk of read({ start, end: end - 1, highWaterMark: DEPENDENCY_BYTES })) {
        const digest = createHash('sha256').update(chunk).digest('hex')
        const path = `/runs/${id}/dependency?sha256=${digest}`
        try {
          await call('POST', path, undefined, signal)
        } catch (error) {
          if (error.status !== 404) throw error
          const compressed = await zip(chunk, { level: 1 })
          await call('POST', path, compressed, signal)
          total += compressed.length
        }
      }
      await sendRaw({ start: end })
    } else if (boundaries) await sendRaw()
    else await send(read())
    await flush(true)
    say(`checkout sent, ${Math.round(total / 1024 / 1024)} MB in ${Math.round((Date.now() - started) / 1000)} s. The box is unpacking it, then runs the suite.`)
  }

  const createRun = async (signal = lifetime.signal) => {
    const created = await call('POST', '/runs', docker ? JSON.stringify({ ...request, docker }) : spec, signal)
    const { id, dependencyCache } = await created.json()
    if (!/^[0-9a-f]{32}$/.test(id)) throw new Error('the test relay did not name the new run')
    return { id, dependencyCache: dependencyCache === true }
  }
  const recover = async () => {
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(RECOVERY_MS)])
    let lastError
    // Wait with a handshake that creates nothing, then admit exactly one run. Any admission POST
    // may have created a run whose response was lost (surfaced as a dropped connection or as
    // HTTP 502/503/504), so a second POST would orphan it and occupy the maxRuns:1 slot.
    while (!signal.aborted) {
      try {
        await sleep(1_000, undefined, { signal })
      } catch (error) {
        if (lifetime.signal.aborted) throw error
        break
      }
      try {
        await call('GET', `/runs/probe/output`, undefined, signal)
        throw Object.assign(new Error('the test relay answered the recovery handshake'), { status: 500 })
      } catch (error) {
        if (lifetime.signal.aborted) throw error
        if (signal.aborted) break
        if (error.status !== 410) {
          // Only a gateway that is still coming up may be waited on. Authentication and admission refusals are final.
          if (error.status && ![502, 503, 504].includes(error.status)) throw error
          lastError = error
          continue
        }
      }
      try {
        return await createRun(signal)
      } catch (error) {
        if (lifetime.signal.aborted) throw error
        if (signal.aborted) break
        // Never send a second admission: a lost response (including one surfaced as
        // 502/503/504) may already have created a run.
        throw error
      }
    }
    if (lifetime.signal.aborted) lifetime.signal.throwIfAborted()
    throw new Error(`the test relay did not recover within ${RECOVERY_MS / 1000} s${lastError ? `: ${lastError.message}` : ''}`)
  }

  try {
    say('this suite runs on a disposable test box; files it changes stay there. Capturing the checkout.')
    const candidate = await capture()
    const suite = command.slice(0, 5).map((word) => basename(word)).join(' ').slice(0, 200)
    say(`candidate ${candidate}, suite ${suite}, cwd ${cwd}`)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { id, dependencyCache } = attempt === 0 ? await createRun() : await recover()
      current = id
      lifetime.signal.throwIfAborted()
      if (attempt === 1) say(`relay recovered; rerunning candidate ${candidate} as run ${id}`)
      else say(`candidate ${candidate}, suite ${suite}, run ${id}`)
      const controller = new AbortController()
      const signal = AbortSignal.any([lifetime.signal, controller.signal])
      const lease = setInterval(() => { call('POST', `/runs/${id}/lease`, undefined, signal).catch(() => {}) }, LEASE_MS)
      let exitCode = null
      let failure = null
      let upload = null
      let uploadError = null
      const read = frameReader((type, payload) => {
        if (type === FRAME.stdout) process.stdout.write(payload)
        else if (type === FRAME.stderr) process.stderr.write(payload)
        else if (type === FRAME.exit) exitCode = Number(payload.toString())
        else if (type === FRAME.fail) failure = { code: payload[0], message: payload.subarray(1).toString() }
        else if (type === FRAME.ready && !upload) {
          say('the box is up. Sending the captured checkout.')
          upload = sendTree(id, signal, dependencyCache).catch((error) => {
            uploadError = error
            // A 410 means the run is over: the restart frame (if any) is still on the
            // output stream, so keep reading it instead of cancelling it.
            if (error?.status !== 410) controller.abort()
          })
        }
      })
      try {
        const output = await call('GET', `/runs/${id}/output`, undefined, signal)
        for await (const chunk of output.body) {
          read(Buffer.from(chunk))
          for (const stream of [process.stdout, process.stderr]) if (stream.writableNeedDrain) await once(stream, 'drain')
          if (failure || exitCode !== null) break
        }
      } catch (error) {
        if (!failure && exitCode === null) throw new Error(uploadError ? `sending the checkout failed: ${uploadError.message}` : `the connection to the test relay broke: ${error.cause?.message ?? error.message}`)
      } finally {
        clearInterval(lease)
        controller.abort()
        await upload
      }
      current = null
      if (failure?.code === 143) { finish(143); return }
      if (failure?.code === 125 && failure.message === USES_DOCKER && !docker) {
        say('the suite reached for Docker, which this box has not: running it again on a box with Docker.')
        docker = true
        // Not a restart, so the one rerun a restart may have is still there.
        attempt -= 1
        continue
      }
      if (failure?.code === 125 && failure.message === GATEWAY_RESTART) {
        say(`interrupted validation: candidate ${candidate}, suite ${suite}, run ${id}: no test result: ${failure.message}`)
        if (attempt === 0) {
          say('waiting up to 30 s for the authenticated relay handshake, then retrying this captured suite once within the remaining time budget')
          continue
        }
      }
      if (failure) die(failure.message, failure.code)
      else if (exitCode === null) die('the connection to the test relay ended before the suite did')
      else {
        // The suite has its result; its budget must not replace it during source capture.
        clearTimeout(deadline)
        if (exitCode > 0 && process.env.AGENT_INTERFACE_FAILED_SOURCE_CALL) {
          // Read the archive that was actually sent, while it still exists. A later
          // edit under the same HEAD must never replace this validation's source.
          const retained = spawn('agent-interface', ['--capture-failed-source', archive, specification, candidate, id, String(exitCode)],
            { stdio: 'ignore', signal: lifetime.signal })
          const saved = await new Promise((done) => {
            retained.once('error', () => done(false))
            retained.once('close', (code) => done(code === 0))
          })
          if (!saved) say('failed source capture unavailable; remediation requires a fresh reproduction')
        }
        finish(exitCode)
      }
      return
    }
  } catch (error) {
    if (!ending) stop(125, error.message)
  } finally {
    clearTimeout(deadline)
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => die(error.message))
}
