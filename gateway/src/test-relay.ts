import { createHash, createPublicKey, sign, randomBytes, timingSafeEqual, verify, type KeyObject } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import type { Logger } from './log.js'
import { TestDependencyCache } from './test-dependency-cache.js'

/**
 * Where agents' test suites leave a workspace (docs/Operating.md, "Agents' test suites"). This starts a disposable
 * test box for each suite, passes the checkout to it and the output back, and destroys it: a Render one-off job of the
 * workspace image, or a Render sandbox, which costs more but has Docker, for a suite that reaches for Docker. It holds
 * the Render API key, so no workspace and no box ever does.
 */
// Under /api/link/ because a proxy with a sign-in of its own already lets that through: like Poise Link, a workspace
// has no session with it, and the gateway checks the keys itself (docs/Operating.md).
export const TEST_RELAY_PATH = '/api/link/test-relay'

export interface TestRelayConfig {
  renderApiKey: string
  /** The Render workspace the boxes run in. */
  workspace: string
  /** This deployment's name: several may share a Render workspace, and each leaves the others' boxes alone. */
  deployment: string
  /** The sandboxes' plan. */
  plan: string
  /** The cron job whose image the one-off jobs run; null sends every suite to a sandbox. */
  baseService: string | null
  /** The jobs' plan. */
  jobPlan: string
  limitSeconds: number
  maxRuns: number
}

export interface TestRelayDeps {
  config: TestRelayConfig
  privateKey: KeyObject
  /** The origin a job of this workspace reaches this gateway at. */
  origin: (handle: string) => string
  log: Logger
  now: () => number
  /** Whether a handle names a workspace whose owner may use it; one removed or disabled since it got its key is refused. */
  isWorkspace: (handle: string) => boolean
  renderApi?: string
  sweepMs?: number
  renderSweepMs?: number
  leaseMs?: number
  listGraceMs?: number
  orphanGraceMs?: number
  pollMs?: number
}

interface Run {
  id: string
  handle: string
  /** `repo` names the checkout's history and `docker` asks for a sandbox. */
  spec: { argv: string[]; cwd: string; env: Record<string, string>; repo?: string; docker?: boolean;
    binding?: { call: string; nonce: string; repository: string; base: string };
    capture?: { candidate: string; spec: string } }
  /** What a job presents. */
  token: string
  created: number
  lease: number
  /** A sandbox's ID, or a job's. */
  boxId: string | null
  job: boolean
  boxCreated: number
  ready: boolean
  output: ServerResponse | null
  /** A job's request for the checkout, which the workspace's parts go down. */
  tree: ServerResponse | null
  /** The last of a job's numbered output posts that was taken: one retried after a lost answer is not taken twice. */
  received: number
  parts: number
  uploading: boolean
  assertions: Record<string, unknown> | null
}

interface Connect { uri: string; method: string; token: string }

class RelayError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

const FRAME = { heartbeat: 0, stdout: 1, stderr: 2, exit: 3, fail: 4, ready: 5, evidence: 6 }
const SWEEP_MS = 5_000
// Also the heartbeat's period: long enough for Render's list, short enough for a proxy's idle limit.
const RENDER_SWEEP_MS = 15_000
const LEASE_MS = 45_000
// How long a box may be missing from Render's list before it counts as gone: the list can lag.
const LIST_GRACE_MS = 30_000
// A box this young may be one whose run does not know its id yet.
const ORPHAN_GRACE_MS = 60_000
const POLL_MS = 250
const CANCEL_TIMEOUT_MS = 10_000
const BOOT_WAIT_MS = 60_000
const SNAPSHOT_WAIT_MS = 5 * 60_000
const SETUP_LIMIT_SECONDS = 30 * 60
const SNAPSHOT_LIFE_MS = 365 * 24 * 3_600_000
const SNAPSHOT_RENEW_MS = 7 * 24 * 3_600_000
const MAX_SPEC_BYTES = 1024 * 1024
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024
const MAX_TREE_PART_BYTES = 64 * 1024 * 1024
const MAX_DEPENDENCY_PART_BYTES = 8 * 1024 * 1024
const UPLOAD_ATTEMPTS = 3
const RUN_ID = /^[0-9a-f]{32}$/
const MAX_RETIRED_RUNS = 1024
// A job's start command names the relay it reports to, and its run.
const JOB_OWNER = / (\S+)\/instance ([0-9a-f]{32}) /
// Fetches and runs test-instance.cjs. Render splits a start command at spaces and mangles quotes, so this has
// neither, and needs no file in the image: the gateway always serves the matching script.
const INSTANCE_BOOTSTRAP = 'fetch(process.argv[1]).then(r=>r.text()).then(eval)'
// What a run that moves to a sandbox ends with; scripts/test-offload/run.mjs starts it again there.
export const USES_DOCKER = 'this suite uses Docker'
const GROUP_PREFIX = 'poise-test-boxes'
const RUNNER_FAILED = 125
const OUTPUT_TAIL_CHARS = 2_000
// What test-box.cjs says when a suite ended without a result.
const NO_RESULT = /\[poise\] no test result: (.*?)\. This says nothing/
const TREE_PATH = '/tmp/poise-tree'
const SPEC_PATH = '/tmp/poise-spec.json'
const EVIDENCE_BYTES = 48 * 1024
const EVIDENCE_DOMAIN = 'poise completed test assertions\n'
const SCRIPT_PATH = '/tmp/poise-box.cjs'
const SETUP_PATH = '/tmp/poise-setup.sh'
export const BOX_COMMAND = `node ${SCRIPT_PATH} ${SPEC_PATH} ${TREE_PATH}`
export const SETUP_COMMAND = `sh ${SETUP_PATH}`

function frame(type: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(5)
  header[0] = type
  header.writeUInt32BE(payload.length, 1)
  return Buffer.concat([header, payload])
}

function keyMessage(handle: string): Buffer {
  return Buffer.from(`poise test relay ${handle}`)
}

/** What a workspace presents: its handle, signed. The gateway needs nothing stored to check it. */
export function workspaceKey(privateKey: KeyObject, handle: string): string {
  return `${handle}.${sign(null, keyMessage(handle), privateKey).toString('base64url')}`
}

/**
 * Where a workspace reaches the relay. Behind a proxy of the operator's own that is the address the gateway
 * is published on, since a virtual machine often cannot reach its own public address.
 */
export function workspaceRelayUrl(config: { insecureHttp: boolean; domain: string; proxyListen: string | null }, handle: string): string {
  const origin = config.proxyListen ? `http://${config.proxyListen}` : `${config.insecureHttp ? 'http' : 'https'}://${handle}.${config.domain}`
  return `${origin}${TEST_RELAY_PATH}`
}

function bearer(req: IncomingMessage): string {
  return /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? ''
}

async function readLimited(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) throw new RelayError(413, 'the request is too large')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

async function verifyDependency(body: Buffer, digest: string): Promise<void> {
  const hash = createHash('sha256')
  const gzip = createGunzip()
  let size = 0
  try {
    await pipeline([body], gzip, async (chunks: AsyncIterable<Buffer>) => {
      for await (const chunk of chunks) {
        size += chunk.length
        if (size > MAX_DEPENDENCY_PART_BYTES) throw new Error('dependency part expands past its limit')
        hash.update(chunk)
      }
    })
  } catch {
    throw new RelayError(422, 'invalid dependency part archive')
  }
  // zlib can otherwise ignore trailing padding that would mask subsequent gzip members.
  if (gzip.bytesWritten !== body.length || hash.digest('hex') !== digest) {
    throw new RelayError(422, 'dependency part digest does not match')
  }
}

/** Resolves once the reader took the chunk, or is gone. */
function write(to: Writable, chunk: Buffer): Promise<void> {
  return new Promise((resolve) => {
    if (to.destroyed || to.write(chunk)) {
      resolve()
      return
    }
    const done = (): void => {
      to.off('drain', done)
      to.off('close', done)
      resolve()
    }
    to.once('drain', done)
    to.once('close', done)
  })
}

function startStream(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store, no-transform', 'x-accel-buffering': 'no' })
  res.flushHeaders()
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Only executable names and known suite names belong in logs, never argument values or command bodies. */
function commandLabel(argv: string[]): string {
  const executable = argv[0].split('/').at(-1) ?? ''
  const args = executable === 'npm' ? argv.slice(1)
    : executable === 'node' && /^(npm|npm-cli\.js)$/.test(argv[1]?.split('/').at(-1) ?? '') ? argv.slice(2) : null
  if (args) {
    const words: string[] = []
    for (let index = 0; index < args.length && args[index] !== '--' && words.length < 2; index += 1) {
      if (/^(--prefix|-C|--workspace|-w)$/.test(args[index])) index += 1
      else if (!args[index].startsWith('-')) words.push(args[index])
    }
    const script = /^(test|t|tst)$/.test(words[0] ?? '') ? 'test'
      : /^(run|run-script|rum|urn)$/.test(words[0] ?? '') ? words[1] : undefined
    if (script && ['test', 'test:full', 'test:e2e', 'check', 'lint', 'typecheck', 'typecheck:tests', 'verify'].includes(script)) return `npm run ${script}`
  }
  return executable.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64) || 'command'
}

export class TestRelay {
  readonly runs = new Map<string, Run>()
  private readonly retired = new Map<string, { handle: string; tokenDigest: Buffer | null }>()
  private readonly cancellations = new Set<string>()
  private readonly publicKey: KeyObject
  private readonly api: string
  private readonly owner: string
  private readonly renderHeaders: Record<string, string>
  private readonly boxScript: Buffer
  private readonly setupScript: Buffer
  private readonly instanceScript: Buffer
  /** The checkouts whose suites reached for Docker, by workspace: theirs go to a sandbox at once. */
  private readonly dockerRepos = new Set<string>()
  private readonly dependencies: TestDependencyCache
  private timer: NodeJS.Timeout | null = null
  private lastRenderSweep = 0
  private base: Promise<{ group: string; snapshot: string }> | null = null
  private group: string | null = null
  private builder: string | null = null

  constructor(private readonly deps: TestRelayDeps) {
    this.publicKey = createPublicKey(deps.privateKey)
    this.api = deps.renderApi ?? 'https://api.render.com/v1'
    this.owner = `ownerId=${encodeURIComponent(deps.config.workspace)}`
    this.renderHeaders = { authorization: `Bearer ${deps.config.renderApiKey}`, 'content-type': 'application/json', accept: 'application/json' }
    this.boxScript = readFileSync(new URL('./test-box.cjs', import.meta.url))
    this.setupScript = readFileSync(new URL('./test-box-setup.sh', import.meta.url))
    this.instanceScript = readFileSync(new URL('./test-instance.cjs', import.meta.url))
    this.dependencies = new TestDependencyCache((error) => {
      deps.log.warn('test_relay.dependency_cache.failed', { error: errorMessage(error) })
    })
  }

  /** Starts the sweep, which also ends what an earlier gateway left running, and gets the first box's base ready. */
  start(): void {
    this.prepared().catch((error: unknown) => {
      this.deps.log.warn('test_relay.prepare.failed', { error: errorMessage(error) })
    })
    this.timer = setInterval(() => {
      const now = this.deps.now()
      const renderSweepMs = this.deps.renderSweepMs ?? RENDER_SWEEP_MS
      const withRender = now - this.lastRenderSweep >= renderSweepMs
      if (withRender) this.lastRenderSweep = now
      this.sweep(now, withRender).catch((error: unknown) => {
        this.deps.log.warn('test_relay.sweep.failed', { error: errorMessage(error) })
      })
    }, this.deps.sweepMs ?? SWEEP_MS)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    for (const run of this.runs.values()) this.kill(run, 'the gateway restarted')
    this.dependencies.stop()
  }

  private async render<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.api}${path}`, { method, headers: this.renderHeaders, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    if (!response.ok) throw new RelayError(502, `Render answered ${method} ${path.split('?')[0]} with HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`)
    return await response.json() as T
  }

  private terminate(boxId: string): Promise<void> {
    return fetch(`${this.api}/sandboxes/${boxId}/terminate?${this.owner}`, { method: 'POST', headers: this.renderHeaders }).then(
      (response) => { this.deps.log.info('test_relay.box.terminate', { boxId, status: response.status }) },
      (error: unknown) => { this.deps.log.warn('test_relay.box.terminate.failed', { boxId, error: errorMessage(error) }) },
    )
  }

  private cancel(jobId: string): Promise<void> {
    if (this.cancellations.has(jobId)) return Promise.resolve()
    this.cancellations.add(jobId)
    return fetch(`${this.api}/services/${this.deps.config.baseService}/jobs/${jobId}/cancel`, { method: 'POST', headers: this.renderHeaders, signal: AbortSignal.timeout(CANCEL_TIMEOUT_MS) }).then(
      (response) => { this.deps.log.info('test_relay.job.cancel', { jobId, status: response.status }) },
      (error: unknown) => { this.deps.log.warn('test_relay.job.cancel.failed', { jobId, error: errorMessage(error) }) },
    ).finally(() => { this.cancellations.delete(jobId) })
  }

  private async waitUntil(what: string, waitMs: number, ready: () => Promise<boolean>): Promise<void> {
    const started = Date.now()
    while (!(await ready())) {
      if (Date.now() - started > waitMs) throw new RelayError(504, `${what} took longer than ${Math.round(waitMs / 1000)} s`)
      await new Promise((done) => { setTimeout(done, this.deps.pollMs ?? POLL_MS) })
    }
  }

  private createBox(body: Record<string, unknown>): Promise<{ id: string }> {
    return this.render<{ id: string }>('POST', '/sandboxes', { ownerId: this.deps.config.workspace, plan: this.deps.config.plan, idleTimeoutSeconds: 0, ...body })
  }

  private boxRunning(boxId: string): Promise<void> {
    return this.waitUntil('starting the test box', BOOT_WAIT_MS, async () => {
      const { status } = await this.render<{ status: string }>('GET', `/sandboxes/${boxId}?${this.owner}`)
      if (status === 'terminated' || status === 'errored') throw new RelayError(502, `the test box ${boxId} is ${status}`)
      return status === 'running'
    })
  }

  private connect(boxId: string, operation: string, query: string, body?: unknown): Promise<Connect> {
    return this.render<Connect>('POST', `/sandboxes/${boxId}/${operation}/token?${this.owner}${query}`, body)
  }

  private async uploadTo(boxId: string, path: string, data: RequestInit['body']): Promise<void> {
    const { uri, method, token } = await this.connect(boxId, 'files/upload', `&path=${encodeURIComponent(path)}`)
    const response = await fetch(uri, {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' }, body: data, duplex: 'half',
    } as RequestInit)
    if (!response.ok) throw new RelayError(502, `Render answered the upload of ${path} with HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`)
  }

  /** Runs a command on a box and answers with its exit code. Its output arrives in order, and the next piece waits for `onOutput`. */
  private async exec(boxId: string, command: string, onOutput: (stream: string, data: string) => Promise<void> | void): Promise<number> {
    const { uri, method, token } = await this.connect(boxId, 'runs/stream', '', { command })
    const response = await fetch(uri, {
      method, headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream', 'content-type': 'application/json' }, body: JSON.stringify({ command }),
    })
    if (!response.ok || !response.body) throw new RelayError(502, `Render answered the command with HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`)
    const decoder = new TextDecoder()
    let buffered = ''
    let event = ''
    let data = ''
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffered += decoder.decode(chunk, { stream: true })
      let end = buffered.indexOf('\n')
      while (end !== -1) {
        const line = buffered.slice(0, end).replace(/\r$/, '')
        buffered = buffered.slice(end + 1)
        end = buffered.indexOf('\n')
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) data += (data ? '\n' : '') + line.slice(5).replace(/^ /, '')
        else if (line === '' && event) {
          const payload = JSON.parse(data) as { data?: string; stream?: string; exit_code?: number; message?: string }
          if (event === 'output') await onOutput(payload.stream ?? 'stdout', payload.data ?? '')
          else if (event === 'exit') return payload.exit_code ?? 125
          else if (event === 'error') throw new RelayError(502, `the box answered: ${payload.message ?? data}`)
          event = ''
          data = ''
        }
      }
    }
    throw new RelayError(502, 'the stream from the box ended before the command did')
  }

  /** The group every box lives in and the snapshot it starts from, built here the first time it is missing. */
  private prepared(): Promise<{ group: string; snapshot: string }> {
    this.base ??= this.prepare().catch((error: unknown) => {
      this.base = null
      throw error
    })
    return this.base
  }

  private async prepare(): Promise<{ group: string; snapshot: string }> {
    const name = `${GROUP_PREFIX}-${createHash('sha256').update(this.deps.config.deployment).digest('hex').slice(0, 16)}`
    const groups = await this.render<{ sandboxGroup: { id: string; name: string } }[]>('GET', `/sandbox-groups?${this.owner}&limit=100`)
    const group = groups.find((item) => item.sandboxGroup.name === name)?.sandboxGroup.id
      ?? (await this.render<{ id: string }>('POST', '/sandbox-groups', { name, ownerId: this.deps.config.workspace, region: 'oregon' })).id
    this.group = group
    const snapshot = `box-${createHash('sha256').update(this.setupScript).digest('hex').slice(0, 32)}`
    const listed = await this.render<{ snapshot: { name: string; expiresAt?: string | null } }[]>('GET', `/sandbox-groups/${group}/snapshots?${this.owner}&status=available&limit=100`)
    const renewBy = this.deps.now() + SNAPSHOT_RENEW_MS
    const usable = listed.some((item) => item.snapshot.name === snapshot && (!item.snapshot.expiresAt || Date.parse(item.snapshot.expiresAt) > renewBy))
    if (!usable) await this.buildSnapshot(group, snapshot)
    return { group, snapshot }
  }

  private async buildSnapshot(group: string, name: string): Promise<void> {
    this.deps.log.info('test_relay.snapshot.building', { name })
    const box = await this.createBox({ sandboxGroupId: group, timeoutSeconds: SETUP_LIMIT_SECONDS })
    this.builder = box.id
    try {
      await this.boxRunning(box.id)
      await this.uploadTo(box.id, SETUP_PATH, new Blob([new Uint8Array(this.setupScript)]))
      let tail = ''
      const code = await this.exec(box.id, SETUP_COMMAND, (_stream, data) => { tail = (tail + data).slice(-1_000) })
      if (code !== 0) throw new RelayError(502, `setting up the test box failed with exit code ${code}: ${tail}`)
      const { id, sandboxGroupId } = await this.render<{ id: string; sandboxGroupId: string }>('POST', `/sandboxes/${box.id}/snapshots?${this.owner}`, {
        kind: 'filesystem', name, expiresAt: new Date(this.deps.now() + SNAPSHOT_LIFE_MS).toISOString(),
      })
      await this.waitUntil('capturing the test box', SNAPSHOT_WAIT_MS, async () => {
        const { status, error } = await this.render<{ status: string; error?: string }>('GET', `/sandbox-groups/${sandboxGroupId}/snapshots/${id}?${this.owner}`)
        if (status === 'failed') throw new RelayError(502, `capturing the test box failed: ${error ?? 'no reason given'}`)
        return status === 'available'
      })
      this.deps.log.info('test_relay.snapshot.built', { name })
    } finally {
      this.builder = null
      await this.terminate(box.id)
    }
  }

  /** A warning reaches Poise's diagnostics, which keep only `error` of what a gateway operation says of itself. */
  private runFailed(run: Run, why: string): void {
    this.deps.log.warn('test_relay.run.failed', {
      id: run.id, handle: run.handle, boxId: run.boxId, error: `run ${run.id}, workspace ${run.handle}, command ${commandLabel(run.spec.argv)}: ${why}`,
    })
  }

  private retire(run: Run): boolean {
    if (!this.runs.delete(run.id)) return false
    // Cleanup and late job output can arrive while asynchronous box termination is still pending.
    this.retired.set(run.id, { handle: run.handle, tokenDigest: run.job ? createHash('sha256').update(run.token).digest() : null })
    if (this.retired.size > MAX_RETIRED_RUNS) this.retired.delete(this.retired.keys().next().value!)
    return true
  }

  /** Ends a run that will report nothing more. The sweep terminates its box again if this fails. */
  private kill(run: Run, why: string, code = 125): void {
    if (!this.retire(run)) return
    // What an agent or a restart stopped, or a move to a sandbox, is no failure of the runner.
    const failure = code !== 143 && why !== 'the gateway restarted' && why !== 'the workspace went away' && why !== USES_DOCKER
    if (failure) this.runFailed(run, why)
    else this.deps.log.info('test_relay.run.killed', { id: run.id, handle: run.handle, boxId: run.boxId, command: commandLabel(run.spec.argv), error: why })
    if (run.output) {
      run.output.write(frame(FRAME.fail, Buffer.concat([Buffer.from([code]), Buffer.from(why)])))
      run.output.end()
    }
    run.tree?.destroy()
    if (run.boxId) void (run.job ? this.cancel(run.boxId) : this.terminate(run.boxId))
  }

  private async sweep(now: number, withRender: boolean): Promise<void> {
    const leaseMs = this.deps.leaseMs ?? LEASE_MS
    const { limitSeconds } = this.deps.config
    for (const run of this.runs.values()) {
      if (now - run.lease > leaseMs) this.kill(run, 'the workspace stopped answering')
      else if (now - run.created > limitSeconds * 1000) this.kill(run, `this suite is too big for its test box: it passed the ${limitSeconds} s time limit`, 124)
      else run.output?.write(frame(FRAME.heartbeat))
    }
    if (!withRender) return
    this.dependencies.sweep(now)
    const alive = new Set<string>()
    if (this.group) {
      const listed = (await this.render<{ sandbox: { id: string; createdAt: string } }[]>('GET', `/sandboxes?${this.owner}&sandboxGroupId=${this.group}&status=running&status=creating&limit=100`)).map((item) => item.sandbox)
      const owned = new Set([...this.runs.values()].map((run) => run.boxId))
      const grace = this.deps.orphanGraceMs ?? ORPHAN_GRACE_MS
      // Nothing runs unless a live run wants it: this is also what ends the boxes a restart left behind.
      for (const box of listed) {
        alive.add(box.id)
        if (!owned.has(box.id) && box.id !== this.builder && now - Date.parse(box.createdAt) > grace) void this.terminate(box.id)
      }
    }
    if (this.deps.config.baseService) {
      const listed = (await this.render<{ job: { id: string; startCommand: string } }[]>('GET', `/services/${this.deps.config.baseService}/jobs?status=pending,running&limit=100`)).map((item) => item.job)
      // A job names its run in its start command, from the moment it exists.
      for (const job of listed) {
        alive.add(job.id)
        const owner = this.jobRun(job.startCommand)
        if (owner !== null && !this.runs.has(owner)) void this.cancel(job.id)
      }
    }
    const listGrace = this.deps.listGraceMs ?? LIST_GRACE_MS
    for (const run of this.runs.values()) {
      const listedHere = run.job ? Boolean(this.deps.config.baseService) : this.group !== null
      if (run.boxId && listedHere && !alive.has(run.boxId) && now - run.boxCreated > listGrace) this.kill(run, `its box ${run.boxId} ended without reporting a result`)
    }
  }

  /** The run a job of this deployment names; null for a job of another deployment sharing the service, which is that one's to end. */
  private jobRun(startCommand: string): string | null {
    const [, relay, run] = JOB_OWNER.exec(startCommand) ?? []
    const handle = /^https?:\/\/([^./:]+)/.exec(relay ?? '')?.[1]
    return handle !== undefined && relay === `${this.deps.origin(handle)}${TEST_RELAY_PATH}` ? run : null
  }

  private async provision(run: Run): Promise<void> {
    if (run.job) await this.startJob(run)
    else await this.startBox(run)
  }

  /** The job asks for the checkout once it is up, and that makes the run ready. */
  private async startJob(run: Run): Promise<void> {
    const { baseService, jobPlan, limitSeconds } = this.deps.config
    const relay = `${this.deps.origin(run.handle)}${TEST_RELAY_PATH}`
    // Ends the job whatever the suite does, and whether or not this gateway still lives. tini as PID 1 reaps what the
    // suite kills: `timeout` there would not, and a suite checking that a killed process is gone would fail.
    const startCommand = `tini -- timeout -k 10 ${limitSeconds + 60} node -e ${INSTANCE_BOOTSTRAP} ${relay}/instance ${run.id} ${run.token}`
    const job = await this.render<{ id: string }>('POST', `/services/${baseService}/jobs`, { startCommand, planId: jobPlan })
    run.boxId = job.id
    run.boxCreated = this.deps.now()
    if (!this.runs.has(run.id)) {
      void this.cancel(job.id)
      return
    }
    this.deps.log.info('test_relay.run.created', { id: run.id, handle: run.handle, jobId: job.id, command: commandLabel(run.spec.argv) })
  }

  private async startBox(run: Run): Promise<void> {
    const { limitSeconds } = this.deps.config
    // Ends the box whatever the suite does, and whether or not this gateway still lives.
    const start = ({ group, snapshot }: { group: string; snapshot: string }): Promise<{ id: string }> => this.createBox({ sandboxGroupId: group, snapshotName: snapshot, timeoutSeconds: limitSeconds + 60 })
    const base = this.prepared()
    const box = await start(await base).catch(async (error: unknown) => {
      // The snapshot may be gone since this gateway last looked. Runs noticing it together share one new one.
      if (!(error instanceof RelayError)) throw error
      if (this.base === base) this.base = null
      return start(await this.prepared())
    })
    run.boxId = box.id
    run.boxCreated = this.deps.now()
    if (!this.runs.has(run.id)) {
      void this.terminate(box.id)
      return
    }
    await this.boxRunning(box.id)
    if (!this.runs.has(run.id)) return
    run.ready = true
    run.output?.write(frame(FRAME.ready))
    this.deps.log.info('test_relay.run.created', { id: run.id, handle: run.handle, boxId: box.id, command: commandLabel(run.spec.argv) })
  }

  private async createRun(handle: string, body: Buffer): Promise<Run> {
    const { maxRuns } = this.deps.config
    if (this.runs.size >= maxRuns) throw new RelayError(429, `${maxRuns} suites are already running`)
    const spec = JSON.parse(body.toString()) as Run['spec']
    if (!Array.isArray(spec.argv) || spec.argv.length === 0 || typeof spec.cwd !== 'string' || typeof spec.env !== 'object') {
      throw new RelayError(400, 'a run names argv, cwd and env')
    }
    if (spec.capture) {
      const { capture, docker: _docker, ...captured } = spec
      if (!spec.binding || !/^[0-9a-f]{32}$/.test(spec.binding.call) || !/^[0-9a-f]{64}$/.test(spec.binding.nonce)
        || !/^[0-9a-f]{40}$/.test(spec.binding.base) || !/^[0-9a-f]{64}$/.test(capture.candidate)
        || JSON.stringify(JSON.parse(capture.spec)) !== JSON.stringify(captured)) throw new RelayError(400, 'invalid assertion capture binding')
    }
    const now = this.deps.now()
    // A job costs less, and moves its suite to a sandbox once it reaches for Docker; a checkout known to do so goes there at once.
    const job = this.deps.config.baseService !== null && spec.docker !== true && !this.dockerRepos.has(`${handle} ${spec.repo}`)
    const run: Run = {
      id: randomBytes(16).toString('hex'), handle, spec, token: randomBytes(32).toString('hex'), created: now, lease: now, boxId: null, job, boxCreated: 0, ready: false, output: null, tree: null, received: 0, parts: 0, uploading: false, assertions: null,
    }
    this.runs.set(run.id, run)
    return run
  }

  private presentedHandle(req: IncomingMessage): string | null {
    const presented = bearer(req)
    const dot = presented.indexOf('.')
    if (dot < 1) return null
    const handle = presented.slice(0, dot)
    const signature = Buffer.from(presented.slice(dot + 1), 'base64url')
    return verify(null, keyMessage(handle), this.publicKey, signature) && this.deps.isWorkspace(handle) ? handle : null
  }

  /** Answers what comes in under TEST_RELAY_PATH. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    try {
      await this.route(req, res, url)
    } catch (error) {
      const status = error instanceof RelayError ? error.status : 500
      const message = errorMessage(error)
      this.deps.log.warn('test_relay.request.failed', { method: req.method, path: url.pathname, status, error: message })
      if (res.headersSent) res.destroy()
      else res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }).end(message)
    }
  }

  private isJob(req: IncomingMessage, run: Run): boolean {
    const digest = (value: string): Buffer => createHash('sha256').update(value).digest()
    return run.job && timingSafeEqual(digest(bearer(req)), digest(run.token))
  }

  private runnerSpec(run: Run): Run['spec'] {
    // Held for #1619: no report credential leaves the gateway, so candidate code reading spec.json cannot POST fabricated assertions.
    return { ...run.spec }
  }

  /** Only an authenticated runner result followed by its genuine completed
   * failure can produce this receipt. Stream text and canceled runs cannot.
   * Held for #1619: POST assertions never stores, so run.assertions stays null and this never emits.
   */
  private retainAssertions(run: Run, code: number, noResult: unknown): void {
    if (code !== 1 || noResult || !run.assertions) return
    const payload = JSON.stringify({ ...run.assertions, handle: run.handle, run: run.id })
    const signature = sign(null, Buffer.from(EVIDENCE_DOMAIN + payload), this.deps.privateKey).toString('base64url')
    const receipt = Buffer.from(JSON.stringify({ payload, signature }))
    if (receipt.length <= EVIDENCE_BYTES) run.output?.write(frame(FRAME.evidence, receipt))
  }

  private async route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const [resource, id, part] = url.pathname.slice(TEST_RELAY_PATH.length + 1).split('/')
    if (req.method === 'GET' && resource === 'instance' && this.deps.config.baseService) {
      if (!id) res.writeHead(200, { 'content-type': 'text/javascript' }).end(this.instanceScript)
      else if (id === 'box') res.writeHead(200, { 'content-type': 'text/javascript' }).end(this.boxScript)
      else throw new RelayError(404, 'There is nothing at this address.')
      return
    }
    if (resource === 'evidence' && id === 'verify' && req.method === 'POST') {
      const handle = this.presentedHandle(req)
      if (!handle) throw new RelayError(401, 'this key is not a workspace\'s')
      const receipt = JSON.parse((await readLimited(req, EVIDENCE_BYTES)).toString()) as { payload: string; signature: string }
      if (typeof receipt.payload !== 'string' || typeof receipt.signature !== 'string'
        || !verify(null, Buffer.from(EVIDENCE_DOMAIN + receipt.payload), this.publicKey, Buffer.from(receipt.signature, 'base64url'))) {
        throw new RelayError(422, 'assertion evidence is not gateway-authenticated')
      }
      const proof = JSON.parse(receipt.payload) as { handle: string }
      if (proof.handle !== handle) throw new RelayError(403, 'assertion evidence belongs to another workspace')
      res.writeHead(200, { 'content-type': 'application/json' }).end(receipt.payload)
      return
    }
    if (resource !== 'runs') throw new RelayError(404, 'There is nothing at this address.')
    if (req.method === 'POST' && part === 'assertions') {
      const run = this.runs.get(id ?? '')
      const digest = (value: string): Buffer => createHash('sha256').update(value).digest()
      if (!run || !timingSafeEqual(digest(bearer(req)), digest(run.token))) throw new RelayError(410, 'this run is over')
      // Held for #1619: the suite UID can present this token, so no inventory is accepted even when authenticated.
      throw new RelayError(409, 'assertion result is not expected')
    }
    const fromJob = (req.method === 'GET' && (part === 'spec' || part === 'tree')) || (req.method === 'POST' && (part === 'output' || part === 'docker'))
    if (fromJob) {
      const run = RUN_ID.test(id ?? '') ? this.runs.get(id) : undefined
      // Unknown and ended look alike to a job, which stops at this answer.
      if (!run || !this.isJob(req, run)) {
        const tokenDigest = !run ? this.retired.get(id)?.tokenDigest : null
        if (req.method === 'POST' && url.pathname === `${TEST_RELAY_PATH}/runs/${id}/output` && tokenDigest
          && timingSafeEqual(createHash('sha256').update(bearer(req)).digest(), tokenDigest)) {
          res.writeHead(410, { 'content-type': 'text/plain; charset=utf-8' }).end('this run is over')
          return
        }
        throw new RelayError(410, 'this run is over')
      }
      await this.fromJob(req, res, url, run, part)
      return
    }
    const handle = this.presentedHandle(req)
    if (handle === null) throw new RelayError(401, 'this key is not a workspace\'s')

    if (req.method === 'GET' && url.pathname === `${TEST_RELAY_PATH}/runs/probe/output`) {
      res.writeHead(410, { 'content-type': 'text/plain; charset=utf-8' }).end('this run is over')
      return
    }

    if (req.method === 'POST' && !id) {
      const run = await this.createRun(handle, await readLimited(req, MAX_SPEC_BYTES))
      res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ id: run.id, dependencyCache: true }))
      return
    }

    const run = RUN_ID.test(id ?? '') ? this.runs.get(id) : undefined
    if (!run) {
      if (req.method === 'DELETE' && url.pathname === `${TEST_RELAY_PATH}/runs/${id}` && this.retired.get(id)?.handle === handle) {
        res.writeHead(204).end()
        return
      }
      throw new RelayError(410, 'this run is over')
    }
    if (handle !== run.handle) throw new RelayError(403, 'this run is another workspace\'s')

    if (req.method === 'GET' && part === 'output') {
      startStream(res)
      const first = run.output === null
      run.output = res
      res.once('close', () => { if (this.runs.has(run.id)) this.kill(run, 'the workspace went away') })
      // Started only now, so that whatever goes wrong has someone to tell.
      if (first) this.provision(run).catch((error: unknown) => { this.kill(run, `no test box could start: ${errorMessage(error)}`) })
      else if (run.ready) res.write(frame(FRAME.ready))
    } else if (req.method === 'POST' && part === 'lease') {
      run.lease = this.deps.now()
      res.writeHead(204).end()
    } else if (req.method === 'POST' && (part === 'tree' || part === 'dependency')) {
      if (run.uploading) throw new RelayError(409, 'a checkout part is already arriving')
      run.uploading = true
      try {
        const received = part === 'dependency' ? await this.receiveDependency(req, url, run) : await this.receiveTree(req, url, run)
        res.writeHead(received === false ? 404 : 204).end()
      } finally {
        run.uploading = false
      }
    } else if (req.method === 'DELETE' && !part) {
      this.kill(run, 'the suite was stopped', 143)
      res.writeHead(204).end()
    } else {
      throw new RelayError(404, 'There is nothing at this address.')
    }
  }

  private async fromJob(req: IncomingMessage, res: ServerResponse, url: URL, run: Run, part: string): Promise<void> {
    if (part === 'spec') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(this.runnerSpec(run)))
    } else if (part === 'tree') {
      startStream(res)
      run.tree = res
      run.ready = true
      run.output?.write(frame(FRAME.ready))
    } else if (part === 'docker') {
      if (run.spec.repo) this.dockerRepos.add(`${run.handle} ${run.spec.repo}`)
      res.writeHead(204).end()
      this.kill(run, USES_DOCKER)
    } else {
      const body = await readLimited(req, MAX_OUTPUT_BYTES)
      const seq = Number(url.searchParams.get('seq'))
      if (!(seq > run.received)) {
        res.writeHead(204).end()
        return
      }
      run.received = seq
      const isEnd = url.searchParams.get('end') === '1'
      if (isEnd && this.runs.has(run.id)) {
        // The final body carries the exit frame; retain evidence first so the
        // hook receives the receipt before it stops on exit (sandboxes already do).
        this.retainAssertions(run, Number(url.searchParams.get('exit')), url.searchParams.get('why'))
      }
      // A run that was ended has ended its response too, and writing to that would bring down the gateway.
      if (this.runs.has(run.id) && run.output && body.length) await write(run.output, body)
      if (isEnd && this.retire(run)) {
        const code = Number(url.searchParams.get('exit'))
        const noResult = url.searchParams.get('why')
        if (noResult) this.runFailed(run, noResult)
        this.deps.log.info('test_relay.run.finished', {
          id: run.id, handle: run.handle, jobId: run.boxId, command: commandLabel(run.spec.argv), exit: code, seconds: Math.round((this.deps.now() - run.created) / 1000),
        })
        run.output?.end()
      }
      res.writeHead(204).end()
    }
  }

  private async receiveDependency(req: IncomingMessage, url: URL, run: Run): Promise<boolean> {
    if (!run.ready) throw new RelayError(409, 'the test box is not ready')
    const digest = url.searchParams.get('sha256') ?? ''
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new RelayError(400, 'invalid dependency part digest')
    const body = await readLimited(req, MAX_DEPENDENCY_PART_BYTES)
    const now = this.deps.now()
    const cacheError = (error: unknown): void => {
      this.deps.log.warn('test_relay.dependency_cache.failed', { handle: run.handle, error: errorMessage(error) })
    }
    let part: Buffer | null
    if (body.length) {
      await verifyDependency(body, digest)
      if (!this.runs.has(run.id)) throw new RelayError(410, 'this run is over')
      await this.dependencies.put(run.handle, digest, body, now).catch(cacheError)
      part = body
    } else {
      part = await this.dependencies.get(run.handle, digest, now).catch((error: unknown) => {
        cacheError(error)
        return null
      })
    }
    if (!this.runs.has(run.id)) throw new RelayError(410, 'this run is over')
    if (!part) return false
    if (run.tree) await write(run.tree, part)
    else await this.uploadTreePart(run, part)
    return true
  }

  private async receiveTree(req: IncomingMessage, url: URL, run: Run): Promise<void> {
    if (run.job) {
      const tree = run.tree
      if (!tree) throw new RelayError(409, 'the test box is not ready')
      for await (const chunk of req) await write(tree, chunk as Buffer)
      if (url.searchParams.get('end') === '1') tree.end()
      return
    }
    if (!run.ready || !run.boxId) throw new RelayError(409, 'the test box is not ready')
    const part = await readLimited(req, MAX_TREE_PART_BYTES)
    if (part.length) await this.uploadTreePart(run, part)
    if (url.searchParams.get('end') === '1' && this.runs.has(run.id)) void this.execute(run)
  }

  /** One upload per part: Render's upload token does not outlive a slow connection, and a blip costs one part. */
  private async uploadTreePart(run: Run, part: Buffer): Promise<void> {
    if (!run.ready || !run.boxId) throw new RelayError(409, 'the test box is not ready')
    const path = `${TREE_PATH}/${String(run.parts).padStart(6, '0')}`
    run.parts += 1
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.uploadTo(run.boxId, path, new Blob([new Uint8Array(part)]))
        return
      } catch (error) {
        if (attempt >= UPLOAD_ATTEMPTS) {
          this.kill(run, `sending the checkout to the box failed: ${errorMessage(error)}`)
          return
        }
        await new Promise((done) => { setTimeout(done, (this.deps.pollMs ?? POLL_MS) * attempt) })
      }
    }
  }

  private async execute(run: Run): Promise<void> {
    const boxId = run.boxId as string
    let tail = ''
    try {
      await this.uploadTo(boxId, SPEC_PATH, JSON.stringify(this.runnerSpec(run)))
      await this.uploadTo(boxId, SCRIPT_PATH, new Blob([new Uint8Array(this.boxScript)]))
      const code = await this.exec(boxId, BOX_COMMAND, (stream, data) => {
        // A run that was ended has ended its response too, and writing to that would bring down the gateway.
        if (!this.runs.has(run.id) || !run.output) return undefined
        if (stream === 'stderr') tail = (tail + data).slice(-OUTPUT_TAIL_CHARS)
        return write(run.output, frame(stream === 'stderr' ? FRAME.stderr : FRAME.stdout, Buffer.from(data)))
      })
      if (!this.retire(run)) return
      const noResult = code === RUNNER_FAILED ? NO_RESULT.exec(tail)?.[1] : undefined
      this.retainAssertions(run, code, noResult)
      if (noResult) this.runFailed(run, noResult)
      this.deps.log.info('test_relay.run.finished', {
        id: run.id, handle: run.handle, boxId, command: commandLabel(run.spec.argv), exit: code, seconds: Math.round((this.deps.now() - run.created) / 1000),
      })
      run.output?.write(frame(FRAME.exit, Buffer.from(String(code))))
      run.output?.end()
      void this.terminate(boxId)
    } catch (error) {
      this.kill(run, `the connection to the box broke: ${errorMessage(error)}`)
    }
  }
}
