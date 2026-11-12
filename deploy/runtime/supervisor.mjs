// Runs Poise in a workspace and restarts it onto a newly installed release
// without stopping the container (docs/Service-architecture.md, "Updates in
// place"). The agent processes Poise starts are detached: they keep running
// through a restart, tini adopts and reaps them, and the next Poise reconciles
// them as it does after any restart.
//
// Releases live in ~/.poise/releases/<name>/ as poise/, venv/, base and
// installed; the gateway installs them there with install-release.sh from a
// newer image of the same base. `current` names the release this workspace
// runs and `next` the one a switch asked for; Poise exits with 75 to switch.

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, closeSync, constants as fsConstants, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, renameSync, rmdirSync, rmSync, statfsSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { constants } from 'node:os'
import { join } from 'node:path'
import { callerStore, resourceWitnesses } from './resource-witness.mjs'

export const UPDATE_EXIT_CODE = 75
// A release that exits this soon after starting, other than to switch, is not run again.
export const FAILED_START_MS = 60_000
const RELEASE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/

/** Pin the original namespace's procfs before its workload starts. On runsc,
 * init exit queues termination but does not wait for every member to exit.
 * The retained mount still lists those members, including nested namespaces. */
export function openNamespaceWitness({ pid, start, namespace, epoch, owner, holder }) {
  const processIdentity = (value) => value && typeof value === 'object'
    && Number.isSafeInteger(value.pid) && value.pid >= 2
    && typeof value.start === 'string' && /^[0-9]{1,32}$/.test(value.start)
    && Object.keys(value).every(key => ['pid', 'start'].includes(key))
  if (!Number.isSafeInteger(pid) || pid < 2 || typeof start !== 'string' || !/^[0-9]{1,32}$/.test(start)
      || typeof namespace !== 'string' || !/^pid:\[[1-9][0-9]{0,31}\]$/.test(namespace)
      || !epoch || typeof epoch !== 'object' || typeof epoch.boot !== 'string' || !epoch.boot || epoch.boot.length > 128
      || Object.keys(epoch).some(key => !['boot', 'init_start', 'namespace_dev', 'namespace_ino'].includes(key))
      || !['init_start', 'namespace_dev', 'namespace_ino'].every((key) => typeof epoch[key] === 'string' && /^[0-9]{1,32}$/.test(epoch[key]))
      || !processIdentity(owner) || !processIdentity(holder) || new Set([owner.pid, holder.pid, pid]).size !== 3) {
    throw new Error('Invalid native namespace identity')
  }
  const taskAt = (path, expectedPid) => {
    const text = readFileSync(path, 'utf8')
    const closing = text.lastIndexOf(')')
    const fields = text.slice(closing + 1).trim().split(/\s+/)
    if (closing <= text.indexOf('(') || text.indexOf('(') < 1
        || text.slice(0, text.indexOf(' ')) !== String(expectedPid)
        || !/^[0-9]+$/.test(fields[19] ?? '') || !/^[0-9]+$/.test(fields[1] ?? '')) {
      throw new Error('Native process start identity is unreadable')
    }
    return { start: fields[19], parent: Number(fields[1]) }
  }
  const startAt = (path, expectedPid) => taskAt(path, expectedPid).start
  if (namespace === readlinkSync('/proc/self/ns/pid')) throw new Error('Native invocation requires a private PID namespace')
  const observer = statSync('/proc/self/ns/pid', { bigint: true })
  if (epoch.boot !== readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
      || epoch.init_start !== startAt('/proc/1/stat', 1)
      || epoch.namespace_dev !== String(observer.dev) || epoch.namespace_ino !== String(observer.ino)) {
    throw new Error('Native namespace observer epoch differs')
  }
  const original = `/proc/${pid}`
  if (startAt(`${original}/stat`, pid) !== start || readlinkSync(`${original}/ns/pid`) !== namespace) {
    throw new Error('Native namespace init identity differs')
  }
  const ancestors = () => {
    const caller = taskAt(`/proc/${owner.pid}/stat`, owner.pid)
    const bootstrap = taskAt(`/proc/${holder.pid}/stat`, holder.pid)
    const init = taskAt(`${original}/stat`, pid)
    if (caller.start !== owner.start || bootstrap.start !== holder.start
        || bootstrap.parent !== owner.pid || init.start !== start || init.parent !== holder.pid) {
      throw new Error('Native namespace ancestor identity differs')
    }
  }
  ancestors()
  const fd = openSync(`${original}/root/proc`, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY)
  const view = `/proc/self/fd/${fd}`
  try {
    if (statfsSync(view, { bigint: true }).type !== 0x9fa0n || readlinkSync(`${view}/1/ns/pid`) !== namespace
        || startAt(`${view}/1/stat`, 1) !== start || startAt(`${original}/stat`, pid) !== start) {
      throw new Error('Native namespace procfs binding differs')
    }
    ancestors()
  } catch (error) {
    try { closeSync(fd) }
    catch (closeError) { throw new AggregateError([error, closeError], 'Native namespace validation and descriptor cleanup failed') }
    throw error
  }
  let closed = false
  return Object.freeze({
    binding: Object.freeze({ pid, start, namespace, epoch: Object.freeze({ ...epoch }),
      owner: Object.freeze({ ...owner }), holder: Object.freeze({ ...holder }) }),
    read() {
      if (closed) throw new Error('Native namespace witness is closed')
      // Descriptor lifetime, not a path or a device/inode pair, preserves the
      // namespace binding. gVisor procfs roots can share device/inode values.
      const pids = readdirSync(view).filter((name) => /^[0-9]+$/.test(name)).map(Number).sort((a, b) => a - b)
      return Object.freeze({ namespace, pids: Object.freeze(pids), empty: pids.length === 0 })
    },
    ownerPresent() {
      try { return startAt(`/proc/${owner.pid}/stat`, owner.pid) === owner.start }
      catch (error) { if (error.code === 'ENOENT') return false; throw error }
    },
    close() {
      if (closed) return false
      closed = true
      closeSync(fd)
      return true
    },
  })
}

/** Kernel descriptors live in the existing workspace supervisor, outside
 * replaceable Poise and Caller processes. This service records no work and
 * starts no process; the canonical journal remains execution authority. */
export async function namespaceControl({ open = openNamespaceWitness, limit = 4096, dataDirectory } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 4096) throw new Error('Invalid native namespace capacity')
  const directory = mkdtempSync('/tmp/poise-native-')
  const path = join(directory, 'control.sock')
  const instance = randomBytes(16).toString('hex')
  let store = null
  let storeError = null
  try { store = dataDirectory === undefined ? null : callerStore(dataDirectory) }
  catch (error) { storeError = `Original Caller metadata handles are unavailable: ${error.message}` }
  const scopes = new Map()
  const connections = new Set()
  let closed = false
  const identity = (request) => {
    if (typeof request.callId !== 'string' || !/^[a-f0-9]{32}$/.test(request.callId)
        || typeof request.correlation !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(request.correlation)
        || typeof request.token !== 'string' || !/^[a-f0-9]{32}$/.test(request.token)) throw new Error('Invalid native scope identity')
  }
  const bindingKey = (value) => JSON.stringify([value.pid, value.start, value.namespace, value.epoch?.boot,
    value.epoch?.init_start, value.epoch?.namespace_dev, value.epoch?.namespace_ino,
    value.owner?.pid, value.owner?.start, value.holder?.pid, value.holder?.start])
  const dispatch = (request) => {
    if (!request || typeof request !== 'object' || Array.isArray(request) || request.version !== 1
        || request.instance !== instance || closed) throw new Error('Native namespace controller identity differs')
    if (request.operation === 'hello') {
      // Setup checks create no Call. Keep at most one, and reclaim only an
      // abandoned probe whose original retained kernel view is positively
      // empty. Ordinary Call witnesses require their durable acknowledgement.
      for (const [id, scope] of scopes) {
        if (scope.probe && scope.witness.read().empty && !scope.witness.ownerPresent()) {
          scope.resources.close()
          scope.witness.close()
          scopes.delete(id)
        }
      }
      return { available: true, resourceProtocol: 2, persistentCleanup: 1, ...(store ? { store: store.read() } : {}), ...(storeError ? { storeError } : {}), witnesses: scopes.size, probeAvailable: ![...scopes.values()].some(scope => scope.probe) }
    }
    identity(request)
    let scope = scopes.get(request.callId)
    if (scope && (scope.token !== request.token || scope.correlation !== request.correlation)) {
      throw new Error('Native scope belongs to another invocation')
    }
    if (request.operation === 'register') {
      if (request.probe !== undefined && typeof request.probe !== 'boolean') throw new Error('Invalid native setup probe')
      if (!request.identity || typeof request.identity !== 'object') throw new Error('Native scope lacks its kernel binding')
      if (scope) {
        if (scope.identity !== bindingKey(request.identity) || scope.probe !== (request.probe === true)) throw new Error('Native scope kernel binding differs')
      } else {
        if (request.probe && [...scopes.values()].some(scope => scope.probe)) throw new Error('Original native setup probe is still unsettled')
        if (scopes.size >= limit) throw new Error('Native namespace witnesses are at capacity')
        const witness = open(request.identity)
        scope = { witness, resources: resourceWitnesses(request.callId, store?.reference), identity: bindingKey(request.identity), token: request.token, correlation: request.correlation, probe: request.probe === true }
        scopes.set(request.callId, scope)
      }
    } else if (!['read', 'release', 'retire', 'allocate-root', 'read-root', 'repair-root', 'finish-root'].includes(request.operation)) throw new Error('Unknown native namespace operation')
    // Retirement follows an already-durable positive Call release. Absence
    // reports only housekeeping state, never kernel or disk settlement.
    if (!scope && request.operation === 'retire') return { retired: false, present: false }
    if (!scope) throw new Error('Original native namespace witness is unavailable')
    const state = scope.witness.read()
    if (['allocate-root', 'read-root', 'repair-root', 'finish-root'].includes(request.operation)) {
      if (scope.probe) throw new Error('Native setup probes cannot allocate resources')
      if (request.operation === 'allocate-root' && !store) throw new Error('Native resource allocation lacks its original Caller metadata handles')
      if (request.operation === 'allocate-root' && state.empty) throw new Error('Ended native scopes cannot allocate resources')
      if (['repair-root', 'finish-root'].includes(request.operation) && state.pids.some(pid => pid > 2)) throw new Error('Native resource still owns child processes')
      const method = { 'allocate-root': 'allocate', 'read-root': 'read', 'repair-root': 'repair', 'finish-root': 'finish' }[request.operation]
      return { callId: request.callId, correlation: scope.correlation, resource: scope.resources[method](request.root) }
    }
    if (request.operation === 'release' || request.operation === 'retire') {
      if (!state.empty) throw new Error('Native namespace still owns processes')
      if (!scope.resources.released()) throw new Error('Native namespace still owns resource handles')
      scope.resources.close()
      scope.witness.close()
      scopes.delete(request.callId)
      return request.operation === 'retire' ? { retired: true, present: false } : { released: true }
    }
    return { callId: request.callId, correlation: scope.correlation, binding: scope.witness.binding, ...state }
  }
  const server = createServer((socket) => {
    connections.add(socket)
    socket.on('close', () => connections.delete(socket))
    socket.on('error', () => socket.destroy())
    socket.setTimeout(5000, () => socket.destroy(new Error('Native namespace request expired')))
    let pending = Buffer.alloc(0)
    let answered = false
    socket.on('data', (data) => {
      if (answered) return
      pending = Buffer.concat([pending, data])
      if (pending.length > 16 * 1024) { answered = true; socket.end(`${JSON.stringify({ version: 1, instance, error: 'Native namespace request exceeds its limit' })}\n`); return }
      const end = pending.indexOf(10)
      if (end < 0) return
      answered = true
      try {
        if (pending.subarray(end + 1).length) throw new Error('Native namespace requests are single operations')
        const result = dispatch(JSON.parse(pending.subarray(0, end).toString('utf8')))
        socket.end(`${JSON.stringify({ version: 1, instance, ...result })}\n`)
      } catch (error) {
        socket.end(`${JSON.stringify({ version: 1, instance, error: error.message })}\n`)
      }
    })
  })
  server.maxConnections = 32
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(path, () => { server.removeListener('error', reject); resolve() })
    })
    chmodSync(path, 0o600)
  } catch (error) {
    const failures = [error]
    for (const socket of connections) socket.destroy()
    try { if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
    catch (failure) { failures.push(failure) }
    try { rmdirSync(directory) }
    catch (failure) { failures.push(failure) }
    try { store?.close() }
    catch (failure) { failures.push(failure) }
    throw failures.length === 1 ? error : new AggregateError(failures, 'Native namespace controller startup failed')
  }
  return {
    address: Object.freeze({ version: 1, path, instance, ...(store ? { store: store.reference } : {}) }),
    async close() {
      if (closed) return
      closed = true
      for (const socket of connections) socket.destroy()
      const failures = []
      try { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
      catch (error) { failures.push(error) }
      for (const scope of scopes.values()) {
        try { scope.resources.close() }
        catch (error) { failures.push(error) }
        try { scope.witness.close() }
        catch (error) { failures.push(error) }
      }
      scopes.clear()
      try { store?.close() }
      catch (error) { failures.push(error) }
      try { rmdirSync(directory) }
      catch (error) { failures.push(error) }
      if (failures.length) throw new AggregateError(failures, 'Native namespace witness shutdown failed')
    },
  }
}

function read(path) {
  try {
    return readFileSync(path, 'utf8').trim() || null
  } catch {
    return null
  }
}

function replace(path, text) {
  writeFileSync(`${path}.tmp`, `${text}\n`)
  renameSync(`${path}.tmp`, path)
}

export function supervisor({
  home = process.env.HOME,
  image = { name: read('/opt/poise/RELEASE'), poise: '/opt/poise', venv: '/opt/caller/venv' },
  base = read('/opt/poise-runtime/BASE'),
  env = process.env,
  nativeControlFactory = process.platform === 'linux' ? namespaceControl : null,
  start = (release, childEnv) => spawn(process.execPath, [join(release.poise, 'dist', 'server.js')], {
    cwd: release.poise, env: childEnv, stdio: 'inherit',
  }),
  now = Date.now,
  diagnostic = null,
  log = (line) => console.log(`poise-runtime: ${line}`),
} = {}) {
  const releases = join(home, '.poise', 'releases')
  let stopping = false
  let child = null
  const record = (input) => {
    if (!diagnostic) return
    try { diagnostic({ source: 'poise', component: 'workspace-supervisor', ...input }) }
    catch (error) { console.error(`poise-runtime: diagnostic reporting unavailable: ${error instanceof Error ? error.name : 'capture failure'}`) }
  }

  const installed = (name) => ({ name, poise: join(releases, name, 'poise'), venv: join(releases, name, 'venv') })

  const usable = (name) => {
    if (!name || !RELEASE_NAME.test(name) || !base) return false
    const dir = join(releases, name)
    return existsSync(join(dir, 'installed')) && !existsSync(join(dir, 'failed')) && read(join(dir, 'base')) === base
  }

  /**
   * Dates a release it switches away from to that moment: install-release.sh keeps a release for three
   * hours after it was last current, so the agents it launched keep their files.
   */
  const retire = (name, successor) => {
    if (!name || name === successor || !RELEASE_NAME.test(name)) return
    const seconds = now() / 1000
    try {
      utimesSync(join(releases, name), seconds, seconds)
    } catch {
      // Gone already, or never installed here: nothing to keep.
    }
  }

  /** The release a switch asked for, else the current one, else this image's own. */
  const choose = () => {
    const next = read(join(releases, 'next'))
    if (next !== null) {
      rmSync(join(releases, 'next'), { force: true })
      if (usable(next)) {
        retire(read(join(releases, 'current')), next)
        replace(join(releases, 'current'), next)
        return installed(next)
      }
      record({ level: 'warning', operation: 'workspace.release_unavailable', phase: 'release_selection', target: next,
        message: 'Requested workspace release is not installed for this base', context: { requestedRelease: next, base, fallbackRelease: image.name } })
      log(`release ${next} is not installed for this base; staying on the current one`)
    }
    const current = read(join(releases, 'current'))
    if (current !== null && current !== image.name && usable(current)) return installed(current)
    return image
  }

  let nativeControl = null
  const childEnv = (release) => {
    const local = join(home, '.local', 'bin')
    const rest = (env.PATH ?? '').split(':').filter((entry) => entry && entry !== local && !entry.startsWith('/opt/caller/venv'))
    return {
      ...env,
      PATH: [local, join(release.venv, 'bin'), ...rest].join(':'),
      CALLER_BIN_ROOT: join(release.venv, 'bin'),
      AGENT_INTERFACE_ROOT: join(release.poise, 'caller', 'agent_interface'),
      POISE_RELEASE: release.name ?? '',
      POISE_BASE: base ?? '',
      POISE_NATIVE_CONTROL: nativeControl ? JSON.stringify(nativeControl.address) : undefined,
    }
  }

  const runOnce = (release) => new Promise((resolve) => {
    const began = now()
    const spawnFailure = (error) => record({ level: 'error', operation: 'workspace.spawn', phase: 'application_spawn', release: release.name,
      message: error.message, stack: error.stack, errno: error.errno ?? error.code ?? null,
      context: { executable: process.execPath, cwd: release.poise, elapsedMs: now() - began, processErrorCode: error.code ?? null } })
    try { child = start(release, childEnv(release)) }
    catch (error) { spawnFailure(error); throw error }
    child.once('error', (error) => {
      spawnFailure(error)
      log(`Poise could not start: ${error.message}`)
      child = null
      resolve(1)
    })
    child.once('exit', (code, signal) => {
      if (!stopping && code !== UPDATE_EXIT_CODE && (code !== 0 || signal)) record({ level: 'error', operation: 'workspace.exit', phase: 'application_exit',
        release: release.name, message: `Workspace application exited (code ${code}, signal ${signal})`, exitCode: code, signal,
        context: { executable: process.execPath, cwd: release.poise, elapsedMs: now() - began, stderrEvidence: 'Application diagnostics use the inherited stream and separate durable store' } })
      child = null
      resolve(code ?? 128 + (constants.signals[signal] ?? 0))
    })
  })

  return {
    /** Forwards a signal to Poise; the container is stopping, so Poise is not started again. */
    stop(signal) {
      stopping = true
      child?.kill(signal)
    },
    /** Runs Poise until the container stops, and resolves with the exit code to stop with. */
    async run() {
      nativeControl = nativeControlFactory ? await nativeControlFactory({ dataDirectory: env.AGENT_INTERFACE_DATA_DIR || join(home, '.poise', 'agent-interface') }) : null
      try {
        for (;;) {
          const release = choose()
          const startedAt = now()
          log(`starting Poise, release ${release.name ?? 'unnamed'}`)
          const code = await runOnce(release)
          if (stopping) return code
          if (code === UPDATE_EXIT_CODE || existsSync(join(releases, 'next'))) continue
          if (release !== image && now() - startedAt < FAILED_START_MS) {
            writeFileSync(join(releases, release.name, 'failed'), `exited with ${code} within a minute of starting\n`)
            rmSync(join(releases, 'current'), { force: true })
            record({ level: 'warning', operation: 'workspace.release_fallback', phase: 'failed_release_start', release: release.name,
              message: 'Workspace release exited within the startup window; returning to the image release', exitCode: code,
              context: { elapsedMs: now() - startedAt, startupWindowMs: FAILED_START_MS, fallbackRelease: image.name } })
            log(`release ${release.name} exited with ${code} soon after starting; going back to this image's release`)
            continue
          }
          return code
        }
      } finally { if (nativeControl) await nativeControl.close() }
    },
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  let diagnostic = null
  try { ({ recordRuntimeDiagnostic: diagnostic } = await import('/opt/poise/dist/runtime-diagnostic.js')) }
  catch { process.stderr.write('poise-runtime: diagnostic helper unavailable.\n') }
  const instance = supervisor({ diagnostic })
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => instance.stop(signal))
  process.exitCode = await instance.run()
}
