import { createHash, createPublicKey, randomBytes, sign, timingSafeEqual, verify, type KeyObject } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Logger } from './log.js'

/**
 * The meeting point of agents' test suites (docs/Operating.md, "Agents' test suites"). A workspace and a
 * Render one-off job can only dial out, so both dial here: this starts the job, passes the checkout and
 * the output between the two, and destroys the job. It holds the Render API key, so no workspace and no
 * test instance ever does.
 */
// Under /api/link/ because a proxy with a sign-in of its own already lets that through: like Poise Link,
// an instance has no session with it, and the gateway checks the keys itself (docs/Operating.md).
export const TEST_RELAY_PATH = '/api/link/test-relay'

export interface TestRelayConfig {
  renderApiKey: string
  /** The service the jobs run on, whose image is theirs. It runs nothing itself. */
  baseService: string
  plan: string
  limitSeconds: number
  maxRuns: number
}

export interface TestRelayDeps {
  config: TestRelayConfig
  privateKey: KeyObject
  /** The origin an instance of this workspace reaches this gateway at. */
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
}

interface Run {
  id: string
  handle: string
  token: string
  spec: { argv: string[]; cwd: string; env: Record<string, string> }
  created: number
  lease: number
  jobId: string | null
  output: ServerResponse | null
  tree: ServerResponse | null
}

class RelayError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

const FRAME = { heartbeat: 0, fail: 4, ready: 5 }
const SWEEP_MS = 5_000
// Also the heartbeat's period: long enough for Render's list, short enough for a proxy's idle limit.
const RENDER_SWEEP_MS = 15_000
const LEASE_MS = 45_000
// How long a job may be missing from Render's list before it counts as gone: the list can lag.
const LIST_GRACE_MS = 30_000
const MAX_SPEC_BYTES = 1024 * 1024
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024
const RUN_ID = /^[0-9a-f]{32}$/
const JOB_OWNER = /\/instance ([0-9a-f]{32}) /
// Fetches and runs the instance script. Render splits a start command at spaces and mangles quotes,
// so this has neither, and needs no file in the image: the gateway always serves the matching script.
const INSTANCE_BOOTSTRAP = 'fetch(process.argv[1]).then(r=>r.text()).then(eval)'

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

/** Resolves once the reader took the chunk, or is gone. */
function write(res: ServerResponse, chunk: Buffer): Promise<void> {
  return new Promise((resolve) => {
    if (res.destroyed || res.write(chunk)) {
      resolve()
      return
    }
    const done = (): void => {
      res.off('drain', done)
      res.off('close', done)
      resolve()
    }
    res.once('drain', done)
    res.once('close', done)
  })
}

function startStream(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store, no-transform', 'x-accel-buffering': 'no' })
  res.flushHeaders()
}

export class TestRelay {
  readonly runs = new Map<string, Run>()
  private readonly publicKey: KeyObject
  private readonly jobs: string
  private readonly renderHeaders: Record<string, string>
  private readonly instanceScript: Buffer
  private timer: NodeJS.Timeout | null = null
  private lastRenderSweep = 0

  constructor(private readonly deps: TestRelayDeps) {
    this.publicKey = createPublicKey(deps.privateKey)
    this.jobs = `${deps.renderApi ?? 'https://api.render.com/v1'}/services/${deps.config.baseService}/jobs`
    this.renderHeaders = { authorization: `Bearer ${deps.config.renderApiKey}`, 'content-type': 'application/json', accept: 'application/json' }
    this.instanceScript = readFileSync(new URL('./test-instance.cjs', import.meta.url))
  }

  /** Starts the sweep, which also ends what an earlier gateway left running. */
  start(): void {
    this.timer = setInterval(() => {
      const now = this.deps.now()
      const renderSweepMs = this.deps.renderSweepMs ?? RENDER_SWEEP_MS
      const withRender = now - this.lastRenderSweep >= renderSweepMs
      if (withRender) this.lastRenderSweep = now
      this.sweep(now, withRender).catch((error: unknown) => {
        this.deps.log.warn('test_relay.sweep.failed', { error: error instanceof Error ? error.message : String(error) })
      })
    }, this.deps.sweepMs ?? SWEEP_MS)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    for (const run of this.runs.values()) this.kill(run, 'the gateway restarted')
  }

  private cancel(jobId: string): Promise<void> {
    return fetch(`${this.jobs}/${jobId}/cancel`, { method: 'POST', headers: this.renderHeaders }).then(
      (response) => { this.deps.log.info('test_relay.job.cancel', { jobId, status: response.status }) },
      (error: unknown) => { this.deps.log.warn('test_relay.job.cancel.failed', { jobId, error: error instanceof Error ? error.message : String(error) }) },
    )
  }

  /** Ends a run that will report nothing more. The sweep cancels its job again if this cancel fails. */
  private kill(run: Run, why: string, code = 125): void {
    if (!this.runs.delete(run.id)) return
    this.deps.log.info('test_relay.run.killed', { id: run.id, handle: run.handle, jobId: run.jobId, why })
    if (run.output) {
      run.output.write(frame(FRAME.fail, Buffer.concat([Buffer.from([code]), Buffer.from(why)])))
      run.output.end()
    }
    run.tree?.destroy()
    if (run.jobId) void this.cancel(run.jobId)
  }

  private async sweep(now: number, withRender: boolean): Promise<void> {
    const leaseMs = this.deps.leaseMs ?? LEASE_MS
    const { limitSeconds } = this.deps.config
    for (const run of this.runs.values()) {
      if (now - run.lease > leaseMs) this.kill(run, 'the workspace stopped answering')
      else if (now - run.created > limitSeconds * 1000) this.kill(run, `the suite passed the ${limitSeconds} s time limit`, 124)
      else run.output?.write(frame(FRAME.heartbeat))
    }
    if (!withRender) return
    const response = await fetch(`${this.jobs}?status=pending,running&limit=100`, { headers: this.renderHeaders })
    if (!response.ok) throw new Error(`Render answered the job list with HTTP ${response.status}`)
    const listed = (await response.json() as { job: { id: string; startCommand: string } }[]).map((item) => item.job)
    // Nothing runs unless a live run wants it: this is also what ends the jobs a restart left behind.
    for (const job of listed) {
      const owner = JOB_OWNER.exec(job.startCommand)?.[1]
      if (!owner || !this.runs.has(owner)) void this.cancel(job.id)
    }
    const running = new Set(listed.map((job) => job.id))
    const grace = this.deps.listGraceMs ?? LIST_GRACE_MS
    for (const run of this.runs.values()) {
      if (run.jobId && !running.has(run.jobId) && now - run.created > grace) {
        this.kill(run, `the test instance ended without reporting a result, as one that runs out of memory does: this is too big to run there. CI is the gate before merge. Render's logs for ${run.jobId} say more`)
      }
    }
  }

  private async createRun(handle: string, body: Buffer): Promise<Run> {
    const { maxRuns, limitSeconds, plan } = this.deps.config
    if (this.runs.size >= maxRuns) throw new RelayError(429, `${maxRuns} suites are already running`)
    const spec = JSON.parse(body.toString()) as Run['spec']
    if (!Array.isArray(spec.argv) || spec.argv.length === 0 || typeof spec.cwd !== 'string' || typeof spec.env !== 'object') {
      throw new RelayError(400, 'a run names argv, cwd and env')
    }
    const now = this.deps.now()
    const run: Run = {
      id: randomBytes(16).toString('hex'), handle, token: randomBytes(32).toString('hex'), spec, created: now, lease: now, jobId: null, output: null, tree: null,
    }
    const relay = `${this.deps.origin(handle)}${TEST_RELAY_PATH}`
    // Ends the instance whatever the suite does, and whether or not this gateway still lives. tini as PID 1 reaps
    // what the suite kills: `timeout` there would not, and a suite checking that a killed process is gone would fail.
    const startCommand = `tini -- timeout -k 10 ${limitSeconds + 60} node -e ${INSTANCE_BOOTSTRAP} ${relay}/instance ${run.id} ${run.token}`
    // Listed first, so the sweep sees an owner for the job from the moment it exists.
    this.runs.set(run.id, run)
    const response = await fetch(this.jobs, { method: 'POST', headers: this.renderHeaders, body: JSON.stringify({ startCommand, planId: plan }) })
    if (!response.ok) {
      this.runs.delete(run.id)
      throw new RelayError(502, `Render refused the test instance: HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`)
    }
    run.jobId = (await response.json() as { id: string }).id
    this.deps.log.info('test_relay.run.created', { id: run.id, handle, jobId: run.jobId })
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

  private isInstance(req: IncomingMessage, run: Run): boolean {
    const digest = (value: string): Buffer => createHash('sha256').update(value).digest()
    return timingSafeEqual(digest(bearer(req)), digest(run.token))
  }

  /** Answers what comes in under TEST_RELAY_PATH. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    try {
      await this.route(req, res, url)
    } catch (error) {
      const status = error instanceof RelayError ? error.status : 500
      const message = error instanceof Error ? error.message : String(error)
      this.deps.log.warn('test_relay.request.failed', { method: req.method, path: url.pathname, status, error: message })
      if (res.headersSent) res.destroy()
      else res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }).end(message)
    }
  }

  private async route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const [resource, id, part] = url.pathname.slice(TEST_RELAY_PATH.length + 1).split('/')
    if (req.method === 'GET' && resource === 'instance' && !id) {
      res.writeHead(200, { 'content-type': 'text/javascript' }).end(this.instanceScript)
      return
    }
    if (resource !== 'runs') throw new RelayError(404, 'There is nothing at this address.')

    if (req.method === 'POST' && !id) {
      const handle = this.presentedHandle(req)
      if (!handle) throw new RelayError(401, 'this key is not a workspace\'s')
      const run = await this.createRun(handle, await readLimited(req, MAX_SPEC_BYTES))
      res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ id: run.id }))
      return
    }

    const run = RUN_ID.test(id ?? '') ? this.runs.get(id) : undefined
    const fromInstance = (req.method === 'GET' && (part === 'spec' || part === 'tree')) || (req.method === 'POST' && part === 'output')
    if (fromInstance) {
      // Unknown and ended look alike to an instance, which stops at this answer.
      if (!run || !this.isInstance(req, run)) throw new RelayError(410, 'this run is over')
      await this.fromInstance(req, res, url, run, part)
      return
    }
    if (this.presentedHandle(req) === null) throw new RelayError(401, 'this key is not a workspace\'s')
    if (!run) throw new RelayError(410, 'this run is over')
    if (this.presentedHandle(req) !== run.handle) throw new RelayError(403, 'this run is another workspace\'s')
    await this.fromWorkspace(req, res, url, run, part)
  }

  private async fromInstance(req: IncomingMessage, res: ServerResponse, url: URL, run: Run, part: string): Promise<void> {
    if (part === 'spec') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(run.spec))
    } else if (part === 'tree') {
      startStream(res)
      run.tree = res
      run.output?.write(frame(FRAME.ready))
    } else {
      const body = await readLimited(req, MAX_OUTPUT_BYTES)
      if (run.output && body.length) await write(run.output, body)
      if (url.searchParams.get('end') === '1') {
        this.runs.delete(run.id)
        this.deps.log.info('test_relay.run.finished', { id: run.id, handle: run.handle, jobId: run.jobId, seconds: Math.round((this.deps.now() - run.created) / 1000) })
        run.output?.end()
      }
      res.writeHead(204).end()
    }
  }

  private async fromWorkspace(req: IncomingMessage, res: ServerResponse, url: URL, run: Run, part: string | undefined): Promise<void> {
    if (req.method === 'GET' && part === 'output') {
      startStream(res)
      run.output = res
      res.once('close', () => { if (this.runs.has(run.id)) this.kill(run, 'the workspace went away') })
      if (run.tree) res.write(frame(FRAME.ready))
    } else if (req.method === 'POST' && part === 'lease') {
      run.lease = this.deps.now()
      res.writeHead(204).end()
    } else if (req.method === 'POST' && part === 'tree') {
      const tree = run.tree
      if (!tree) throw new RelayError(409, 'the test instance is not ready')
      for await (const chunk of req) await write(tree, chunk as Buffer)
      if (url.searchParams.get('end') === '1') tree.end()
      res.writeHead(204).end()
    } else if (req.method === 'DELETE' && !part) {
      this.kill(run, 'the suite was stopped', 143)
      res.writeHead(204).end()
    } else {
      throw new RelayError(404, 'There is nothing at this address.')
    }
  }
}
