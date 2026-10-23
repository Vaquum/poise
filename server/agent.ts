import { prepareModelClis } from './provider-clis'
import { captureBehaviorAdmission, captureBehaviorOutcome, observeAgentSnapshot } from './behavior-ledger'
// Bridge to the local `agent-interface` CLI for Swarm's data source.
//
// Log reads:
//   --logs                        → JSON array of all calls, oldest first
//   --logs --status running        → the running calls only, indexed
//   --logs --limit N [--cursor C]  → one bounded newest-first page
//   --read-response <id>          → response body, looked up by the full
//                                   call id field
//
// Everything is hash-routed now — Poise never touches the filesystem
// the agent-interface project owns.

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { agentInterfaceRoot } from '../scripts/caller.mjs'
import { getHeadSha, localCheckoutPath } from './gh'
import { claudeAuth } from './claude-auth'
import { HttpError } from './http'
import { needsClaude, reviewChoice } from './review-model'
import { claudeSubscriptionEnvironment, runFile, spawnDetached } from './process'
import { withNoticeDiagnosticIdentity } from './logging-context'
import { diagnostic } from './logging'
import { requireAgentAccount } from './settings'
import { ISSUE_REVIEW_BEHAVIOR, freezeAgentLogSnapshot, parseAgentLogStdout, scopedAgentLogs } from './agent-log-parse'
import type { AgentLogParseReply, AgentLogParseRequest } from './agent-log-worker'
import type { AgentLogIdentity, AgentLogSnapshot, LogEntry } from './agent-log-parse'

export { ISSUE_REVIEW_BEHAVIOR, freezeAgentLogSnapshot, quarantinedLogMayMatch, scopedAgentLogs } from './agent-log-parse'
export type {
  AgentLogIdentity, AgentLogSnapshot, IssueCommentReceipt, LogEntry, QuarantinedAgentLog,
} from './agent-log-parse'

const CLI = 'agent-interface'

// agent-interface's DB stores some response_paths as relative
// (`data/responses/<id>.txt`) and `--read-response` reads them without
// resolving against the project root — so the CLI must be invoked with
// cwd at the agent-interface project root for those entries to work.
// That is caller/agent_interface unless AGENT_INTERFACE_ROOT names another.
function agentCwd(): string {
  return agentInterfaceRoot()
}

/** An unscoped read remains strict; scoped reads retain uncertainty in that scope. */
export async function fetchAgentLogs(
  options: { signal?: AbortSignal, identity?: AgentLogIdentity, fresh?: boolean } = {},
): Promise<LogEntry[]> {
  return scopedAgentLogs(await fetchAgentLogSnapshot(options), options.identity)
}

// A running-only read: indexed at the source, so retained history does not
// raise its cost. The status filter stays on this side too: Caller
// pre-filters, and the read is still exactly the running set when it cannot.
export async function fetchRunningAgentLogs(
  options: { signal?: AbortSignal, identity?: AgentLogIdentity, fresh?: boolean } = {},
): Promise<LogEntry[]> {
  return scopedAgentLogs(await fetchRunningAgentLogSnapshot(options), options.identity)
    .filter((entry) => entry.status === 'running')
}

// `--logs` still dumps the whole Caller log on every read, and runFile kills
// the child once stdout passes the cap below: reads work fully until then,
// then all fail at once. Warn into the workspace diagnostics at 75% of the
// cap so the cliff is seen first. At most hourly: every spawn would refire.
const AGENT_LOG_READ_CAP_BYTES = 32 * 1024 * 1024
const AGENT_LOG_CAP_WARN_BYTES = (AGENT_LOG_READ_CAP_BYTES * 3) / 4
const AGENT_LOG_CAP_WARN_INTERVAL_MS = 60 * 60 * 1000
let lastAgentLogCapWarningAt = 0

// Two lanes share nothing: a history read's seconds-long child never queues a
// current read behind it. One child runs per lane: the whole-log dump used
// to convoy a dozen children on Caller's database until each hit its 30 s
// timeout. Concurrent readers join the in-flight read, and readers arriving
// within the TTL reuse its snapshot, so a behavior tick plus open browser
// views share one read instead of spawning at the same minute boundary. A
// read-after-write caller passes fresh to queue the *next* read, which
// starts when the running one settles, so it only sees data from a child
// spawned after it called.
interface AgentLogWaiter {
  signal: AbortSignal | undefined
  onAbort: () => void
  resolve: (snapshot: AgentLogSnapshot) => void
  reject: (error: unknown) => void
}

interface AgentLogRead {
  controller: AbortController
  waiters: Set<AgentLogWaiter>
  started: boolean
  settled: boolean
}

interface AgentLogLane {
  args: readonly string[]
  source: string
  running: AgentLogRead | null
  queued: AgentLogRead | null
  cached: { snapshot: AgentLogSnapshot, expiresAt: number } | null
}

const AGENT_LOG_SNAPSHOT_TTL_MS = 5_000

const historyAgentLogLane: AgentLogLane = {
  args: ['--logs'], source: 'agent-interface --logs', running: null, queued: null, cached: null,
}

const runningAgentLogLane: AgentLogLane = {
  args: ['--logs', '--status', 'running'], source: 'agent-interface --logs --status running',
  running: null, queued: null, cached: null,
}
const selectedAgentLogLanes = new Map<string, AgentLogLane>()

// Test lifecycle: drop both lanes' cached snapshots so the next read spawns.
// Production never calls it; in-flight reads are untouched.
export function resetAgentLogCache(): void {
  historyAgentLogLane.cached = null
  runningAgentLogLane.cached = null
  for (const [key, lane] of selectedAgentLogLanes) {
    lane.cached = null
    if (!lane.running && !lane.queued) selectedAgentLogLanes.delete(key)
  }
}

// Shaped like runFile's own abort rejection, minus the child-kill fields:
// the child may live on for the remaining waiters.
function agentLogAbortError(signal: AbortSignal): Error {
  const error = new Error('The operation was aborted', { cause: signal.reason })
  error.name = 'AbortError'
  return Object.assign(error, { code: 'ABORT_ERR' })
}

export async function fetchAgentLogSnapshot(
  options: { signal?: AbortSignal, fresh?: boolean } = {},
): Promise<AgentLogSnapshot> {
  return laneAgentLogSnapshot(historyAgentLogLane, options, readHistoryAgentLogSnapshot)
}

export async function fetchRunningAgentLogSnapshot(
  options: { signal?: AbortSignal, fresh?: boolean } = {},
): Promise<AgentLogSnapshot> {
  return laneAgentLogSnapshot(runningAgentLogLane, options, readRunningAgentLogSnapshot)
}

async function laneAgentLogSnapshot(
  lane: AgentLogLane,
  options: { signal?: AbortSignal, fresh?: boolean },
  read: (signal: AbortSignal) => Promise<AgentLogSnapshot>,
): Promise<AgentLogSnapshot> {
  // A caller that is already gone never joins work it cannot use.
  options.signal?.throwIfAborted()
  if (!options.fresh && lane.cached && Date.now() < lane.cached.expiresAt) return lane.cached.snapshot
  const target = lane.running
    ? (!options.fresh ? lane.running : (lane.queued ?? createLaneAgentLogRead(lane)))
    : startLaneAgentLogRead(lane, createLaneAgentLogRead(lane), read)
  return new Promise<AgentLogSnapshot>((resolve, reject) => {
    const waiter: AgentLogWaiter = { signal: options.signal, onAbort: () => {}, resolve, reject }
    const signal = waiter.signal
    if (signal) {
      waiter.onAbort = () => {
        target.waiters.delete(waiter)
        if (target.waiters.size === 0 && !target.settled) {
          if (!target.started) {
            // Dropped before it ever spawned.
            if (lane.queued === target) lane.queued = null
          } else {
            // Clear synchronously so a caller arriving during kill
            // teardown spawns fresh instead of joining a dying child.
            target.controller.abort()
            if (lane.running === target) {
              lane.running = null
              promoteLaneAgentLogRead(lane, read)
            }
          }
        }
        reject(agentLogAbortError(signal))
      }
      signal.addEventListener('abort', waiter.onAbort, { once: true })
    }
    target.waiters.add(waiter)
  })
}

function createLaneAgentLogRead(lane: AgentLogLane): AgentLogRead {
  const read: AgentLogRead = { controller: new AbortController(), waiters: new Set(), started: false, settled: false }
  if (lane.running) lane.queued = read
  return read
}

function startLaneAgentLogRead(
  lane: AgentLogLane,
  read: AgentLogRead,
  readSnapshot: (signal: AbortSignal) => Promise<AgentLogSnapshot>,
): AgentLogRead {
  read.started = true
  lane.running = read
  readSnapshot(read.controller.signal).then(
    (snapshot) => {
      lane.cached = { snapshot, expiresAt: Date.now() + AGENT_LOG_SNAPSHOT_TTL_MS }
      settleLaneAgentLogRead(lane, read, { snapshot }, readSnapshot)
    },
    (error) => settleLaneAgentLogRead(lane, read, { error }, readSnapshot),
  )
  return read
}

function promoteLaneAgentLogRead(
  lane: AgentLogLane,
  readSnapshot: (signal: AbortSignal) => Promise<AgentLogSnapshot>,
): void {
  // A queued read starts even after a failure: its waiters arrived for
  // data, and the running read's failure is not theirs.
  if (lane.queued && !lane.running) {
    const next = lane.queued
    lane.queued = null
    startLaneAgentLogRead(lane, next, readSnapshot)
  }
}

function settleLaneAgentLogRead(
  lane: AgentLogLane,
  read: AgentLogRead,
  outcome: { snapshot: AgentLogSnapshot } | { error: unknown },
  readSnapshot: (signal: AbortSignal) => Promise<AgentLogSnapshot>,
): void {
  read.settled = true
  if (lane.running === read) lane.running = null
  for (const waiter of read.waiters) {
    read.waiters.delete(waiter)
    // Completion wins over a racing abort once the read has settled,
    // matching a directly linked child.
    waiter.signal?.removeEventListener('abort', waiter.onAbort)
    if ('snapshot' in outcome) waiter.resolve(outcome.snapshot)
    else waiter.reject(copyAgentLogError(outcome.error))
  }
  promoteLaneAgentLogRead(lane, readSnapshot)
}

// Each waiter gets its own error object, as if it had spawned its own
// child: sharing one object would attribute it to whichever waiter's
// diagnostic context logged it last.
function copyAgentLogError(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return new Error(typeof error === 'string' ? error : 'agent-interface --logs failed without an Error', { cause: error })
  }
  const copy = new Error(error.message, { cause: error })
  copy.name = error.name
  copy.stack = error.stack
  const source = error as unknown as Record<string, unknown>
  const target = copy as unknown as Record<string, unknown>
  for (const field of ['code', 'errno', 'killed', 'signal', 'stdout', 'stderr']) {
    if (source[field] !== undefined) target[field] = source[field]
  }
  return copy
}

async function readHistoryAgentLogSnapshot(signal: AbortSignal): Promise<AgentLogSnapshot> {
  const { stdout } = await spawnAgentLogRead(historyAgentLogLane.args, signal)
  const snapshot = await decodeAgentLogSnapshot(stdout, historyAgentLogLane.source, signal)
  observeAgentSnapshot(snapshot)
  warnAgentLogCap(stdout, snapshot.entries.length + snapshot.quarantined.length)
  return snapshot
}

async function readRunningAgentLogSnapshot(signal: AbortSignal): Promise<AgentLogSnapshot> {
  let stdout: string
  try {
    ({ stdout } = await spawnAgentLogRead(runningAgentLogLane.args, signal))
  } catch (error) {
    throw callerUpdateError(runningAgentLogLane.args, error) ?? error
  }
  return decodeAgentLogSnapshot(stdout, runningAgentLogLane.source, signal)
}

function spawnAgentLogRead(args: readonly string[], signal: AbortSignal | undefined): Promise<{ stdout: string }> {
  // The child serves every waiter, so it runs under the shared read's own
  // diagnostic identity — never the AsyncLocalStorage context of whoever
  // started the preceding read, whose correlationId would otherwise own
  // this read's timeouts. Absent fields stay null: diagnostics persist ''
  // as a distinct value, not as absence.
  return withNoticeDiagnosticIdentity({
    correlationId: randomUUID(),
    behavior: 'agent-logs',
    repository: null,
    target: null,
    account: null,
  }, () => runFile(CLI, args, {
    cwd: agentCwd(),
    timeoutMs: 30_000,
    maxOutputBytes: AGENT_LOG_READ_CAP_BYTES,
    signal,
  }))
}

// An older Caller answers the new flags with its usage text. Name the fix;
// anything else is a real failure and passes through untouched.
function callerUpdateError(args: readonly string[], error: unknown): Error | null {
  if (args.length < 2) return null
  const stderr = (error as { stderr?: unknown } | null)?.stderr
  if (typeof stderr !== 'string' || !stderr.includes('usage:')) return null
  const feature = args.includes('--status') ? 'running-only'
    : args.includes('--limit') ? 'paged' : 'selected'
  return new Error(`Update Caller: ${feature} log reads are unavailable`, { cause: error })
}

// Decoding moves off the event loop past this size. Measured on this tree:
// 6,276 rows (4 MB) decode inline in ~60 ms, a whole loop block; the worker
// halves the main-thread cost to the two structured-clone trips, and below
// 1 MB inline wins outright (~15 ms against the worker's ~150 ms boot).
const AGENT_LOG_WORKER_PARSE_BYTES = 1024 * 1024
const AGENT_LOG_PARSE_TIMEOUT_MS = 30_000

async function decodeAgentLogSnapshot(stdout: string, source: string, signal?: AbortSignal): Promise<AgentLogSnapshot> {
  if (Buffer.byteLength(stdout, 'utf8') < AGENT_LOG_WORKER_PARSE_BYTES) {
    return freezeAgentLogSnapshot(parseAgentLogStdout(stdout, source))
  }
  signal?.throwIfAborted()
  const asset = await agentLogWorkerAssetUrl()
  let worker: Worker | undefined
  try {
    signal?.throwIfAborted()
    return await new Promise<AgentLogSnapshot>((resolve, reject) => {
      worker = new Worker(asset.url)
      worker.unref()
      let settled = false
      const timer = setTimeout(() => fail(new Error(`${source} parse timed out`)), AGENT_LOG_PARSE_TIMEOUT_MS)
      const fail = (error: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        reject(error)
      }
      const onAbort = () => fail(agentLogAbortError(signal!))
      signal?.addEventListener('abort', onAbort, { once: true })
      worker.once('message', (reply: AgentLogParseReply) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        if (reply?.ok) {
          try { resolve(freezeAgentLogSnapshot(reply.snapshot)) }
          catch (error) { reject(error) }
        } else {
          reject(Object.assign(
            new Error(reply?.error?.message ?? `${source} parse failed`,
              { cause: reply?.error?.causeMessage ?? undefined }),
            { name: reply?.error?.name ?? 'Error' }))
        }
      })
      worker.once('error', fail)
      worker.once('exit', (code) => fail(new Error(`${source} parse worker stopped (exit ${code})`)))
      worker.postMessage({ stdout, source } satisfies AgentLogParseRequest)
    })
  } finally {
    try { await worker?.terminate() } finally { await asset.release() }
  }
}

let agentLogWorkerAsset: URL | null = null
interface DevelopmentLogWorkerAsset { url: URL, dir: string, users: number }
let agentLogWorkerBuild: Promise<DevelopmentLogWorkerAsset> | null = null

async function agentLogWorkerAssetUrl(): Promise<{ url: URL, release: () => Promise<void> }> {
  if (agentLogWorkerAsset) return { url: agentLogWorkerAsset, release: () => Promise.resolve() }
  const built = new URL('./agent-log-worker.js', import.meta.url)
  if (existsSync(built)) {
    agentLogWorkerAsset = built
    return { url: built, release: () => Promise.resolve() }
  }
  const source = new URL('./agent-log-worker.ts', import.meta.url)
  if (process.env.NODE_ENV === 'production' || !existsSync(source)) {
    throw new Error('The agent-log parse worker asset is missing')
  }
  const building = agentLogWorkerBuild ??= buildDevelopmentLogWorker(source)
  let asset: DevelopmentLogWorkerAsset
  try { asset = await building }
  catch (error) { if (agentLogWorkerBuild === building) agentLogWorkerBuild = null; throw error }
  asset.users += 1
  let released = false
  return { url: asset.url, release: async () => {
    if (released) return
    released = true
    if (--asset.users === 0) {
      if (agentLogWorkerBuild === building) agentLogWorkerBuild = null
      await rm(asset.dir, { recursive: true, force: true })
    }
  } }
}

async function buildDevelopmentLogWorker(source: URL): Promise<DevelopmentLogWorkerAsset> {
  const dir = await mkdtemp(join(tmpdir(), 'poise-agent-log-parse-'))
  const output = join(dir, 'worker.mjs')
  try {
    // Only builtins remain external; the development asset needs no dependency-tree location.
    const { build } = await import('esbuild')
    await build({ entryPoints: [fileURLToPath(source)], outfile: output, bundle: true,
      platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' })
    return { url: pathToFileURL(output), dir, users: 0 }
  } catch (error) {
    await rm(dir, { recursive: true, force: true })
    throw error
  }
}

export interface AgentLogSelection {
  latest: Array<{ behavior: string, source: string, owner: string }>
  ids: string[]
}

export async function fetchSelectedAgentLogSnapshot(
  selection: AgentLogSelection,
  options: { signal?: AbortSignal, fresh?: boolean } = {},
): Promise<AgentLogSnapshot> {
  return selectedAgentLogSnapshot(['--logs', '--select', JSON.stringify(selection)], options)
}

export async function fetchAgentLogsSince(
  after: string,
  selection: { session: string, behavior: string, prompt: string },
  options: { signal?: AbortSignal, fresh?: boolean } = {},
): Promise<AgentLogSnapshot> {
  return selectedAgentLogSnapshot(['--logs', '--after', after, '--session', selection.session,
    '--behavior', selection.behavior, '--prompt', selection.prompt], options)
}

export async function fetchAgentLogWatermark(): Promise<string> {
  const args = ['--logs', '--watermark']
  let stdout: string
  try { ({ stdout } = await spawnAgentLogRead(args, undefined)) }
  catch (error) { throw callerUpdateError(args, error) ?? error }
  const value = JSON.parse(stdout) as { cursor?: unknown } | null
  if (!value || typeof value.cursor !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(value.cursor)) {
    throw new Error('agent-interface --logs --watermark returned an invalid insertion boundary')
  }
  return value.cursor
}

async function selectedAgentLogSnapshot(
  args: readonly string[], options: { signal?: AbortSignal, fresh?: boolean },
): Promise<AgentLogSnapshot> {
  const key = JSON.stringify(args)
  let lane = selectedAgentLogLanes.get(key)
  if (!lane) {
    for (const [oldKey, old] of selectedAgentLogLanes) {
      if (!old.running && !old.queued && (!old.cached || Date.now() >= old.cached.expiresAt || selectedAgentLogLanes.size >= 32)) selectedAgentLogLanes.delete(oldKey)
    }
    if (selectedAgentLogLanes.size >= 32) throw new Error('agent log selection capacity is full; retry after current reads settle')
    lane = { args, source: 'agent-interface --logs selected read', running: null, queued: null, cached: null }
    selectedAgentLogLanes.set(key, lane)
  }
  const source = lane.source
  return laneAgentLogSnapshot(lane, options, async signal => {
    let stdout: string
    try { ({ stdout } = await spawnAgentLogRead(args, signal)) }
    catch (error) { throw callerUpdateError(args, error) ?? error }
    return decodeAgentLogSnapshot(stdout, source, signal)
  })
}

function warnAgentLogCap(stdout: string, rows: number): void {
  const bytes = Buffer.byteLength(stdout, 'utf8')
  const now = Date.now()
  if (bytes < AGENT_LOG_CAP_WARN_BYTES || now - lastAgentLogCapWarningAt < AGENT_LOG_CAP_WARN_INTERVAL_MS) return
  lastAgentLogCapWarningAt = now
  diagnostic({ level: 'warning', operation: 'agent.logs.cap', condition: 'agent_logs_read_cap',
    message: `agent-interface --logs is ${bytes} bytes (${rows} row${rows === 1 ? '' : 's'}), past 75% of the ${AGENT_LOG_READ_CAP_BYTES}-byte read cap`,
    resources: { bytes, rows, cap: AGENT_LOG_READ_CAP_BYTES } })
}

// Fetch one response body by the full 32-hex call id. agent-interface also
// accepts prefixes, but those become ambiguous as the log grows.
export async function fetchAgentResponse(callId: string): Promise<{ id: string, body: string }> {
  if (!/^[0-9a-fA-F]{32}$/.test(callId)) {
    throw new Error('invalid agent call id')
  }
  const { stdout } = await runFile(CLI, ['--read-response', callId], {
    cwd: agentCwd(),
    timeoutMs: 30_000,
    maxOutputBytes: 32 * 1024 * 1024,
  })
  return { id: callId, body: stdout }
}

export async function fetchAgentReasoning(callId: string): Promise<{ id: string, body: string }> {
  if (!/^[0-9a-fA-F]{32}$/.test(callId)) throw new Error('invalid agent call id')
  const { stdout } = await runFile(CLI, ['--read-reasoning', callId.toLowerCase()], {
    cwd: agentCwd(), timeoutMs: 30_000, maxOutputBytes: 512 * 1024,
  })
  return { id: callId, body: stdout }
}

// Stop a running call. Caller owns the process: `agent-interface --stop`
// signals the call's process group and closes its row as failed with
// error_code "stopped". Used by the Swarm view's Stop column.
export interface StopResult { id: string, stopped: boolean, status: string, error_code?: string | null }

export async function stopAgentJob(callId: string): Promise<StopResult> {
  if (!/^[0-9a-fA-F]{32}$/.test(callId)) throw new HttpError(400, 'invalid agent call id')
  const { stdout } = await runFile(CLI, ['--stop', callId.toLowerCase()], {
    cwd: agentCwd(), timeoutMs: 30_000, maxOutputBytes: 64 * 1024,
  })
  let result: unknown
  try { result = JSON.parse(stdout) } catch { throw new Error('Update Caller: stopping a run is unavailable') }
  const value = result as Record<string, unknown>
  if (typeof value?.id !== 'string' || typeof value.stopped !== 'boolean' || typeof value.status !== 'string') {
    throw new Error('Update Caller: stopping a run is unavailable')
  }
  return { id: value.id, stopped: value.stopped, status: value.status, error_code: typeof value.error_code === 'string' ? value.error_code : null }
}

// Kick off `agent-interface --pr-review #<num> --pwd <local-checkout>`.
// The underlying claude run takes minutes; we spawn detached and return
// immediately. The user watches progress in the Swarm view (the agent
// call lands as a new entry with status='running' the moment track()
// fires upstream, then settles to completed/failed).
export async function triggerPrReview(
  prUrl: string,
): Promise<{ ok: true, source: string, correlationId: string }> {
  const m = String(prUrl || '').match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/)
  if (!m) throw new Error('not a github PR url')
  const [, owner, repo, num] = m
  const actor = requireAgentAccount()
  const repoFullName = `${owner}/${repo}`
  const { model, recovery, catalog } = await reviewChoice('pr_review')
  const claude = needsClaude(catalog, model)
  if (claude) await claudeAuth.requireReady()
  const modelCliEnv = await prepareModelClis(catalog, [model, recovery])
  const pwd = await localCheckoutPath(owner, repo)
  const expectedHead = await getHeadSha(repoFullName, Number(num))
  const source = 'poise:manual-review'
  const correlationId = randomUUID()

  if (claude) await claudeAuth.requireReady()
  if ((await reviewChoice('pr_review')).model !== model) throw new Error('Review model changed; retry the request')
  captureBehaviorAdmission({ admissionKey: correlationId, nativeId: correlationId,
    behavior: 'review-new-prs', source, owner, actor, repository: repoFullName,
    number: Number(num), head: expectedHead, slot: 'primary', plannedSlots: ['primary'], startedAt: new Date().toISOString() })
  try { await spawnDetached(CLI, [
    '--pr-review',
    `#${num}`,
    '--model',
    model,
    '--recovery-model',
    recovery,
    '--actor',
    actor,
    '--expected-head',
    expectedHead,
    '--source',
    source,
    '--correlation-id',
    correlationId,
    '--pwd',
    pwd,
  ], {
    cwd: agentCwd(),
    env: { ...claudeSubscriptionEnvironment(), ...modelCliEnv },
    onExit: (result) => { if (claude) claudeAuth.observeProcessFailure(result) },
  }) } catch (error) {
    captureBehaviorOutcome({ nativeId: correlationId, state: 'failed', activity: 'settled', stateSource: 'native', outcome: 'spawn_failed' })
    throw error
  }
  return { ok: true, source, correlationId }
}

// The scheduler's eligibility check for a replay (server/behaviors.ts
// admitReplay): it reads the target fresh and throws when the scheduler would
// not act on it. Passed in rather than imported, so this bridge to Caller does
// not depend on the behavior runtime.
export type ReplayAdmission = (behavior: 'pr_review' | 'pr_approve' | 'issue_review', repo: string, number: number) => Promise<void>

// Replay an existing agent-interface job — used by the Swarm view's
// Replay column. The frontend sends the row's `behavior` + `repo` +
// `pr_id`; we map behavior → CLI flag and re-spawn the same command
// with the repo's local checkout as --pwd. A new row will appear in
// `agent-interface --logs` for the new run; the existing row is
// untouched. pr_review, pr_approve and issue_review are replayable
// through this path — other behaviors aren't exposed as standalone CLI
// invocations today. Nothing is prepared or launched before `admit` passes.
export async function replayAgentJob(input: {
  behavior?: string,
  repo?: string,
  pr_id?: string | number,
}, admit: ReplayAdmission): Promise<{ ok: true, source: string, correlationId: string }> {
  const behavior = String(input.behavior || '')
  const repo = String(input.repo || '')
  const prId = String(input.pr_id || '')
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new Error('repo must be owner/name')
  if (!/^[1-9]\d*$/.test(prId))          throw new Error('pr_id must be a positive integer')

  if (behavior === ISSUE_REVIEW_BEHAVIOR) {
    await admit(behavior, repo, Number(prId))
    return replayIssueReview(repo, prId)
  }

  let flag: string
  if (behavior === 'pr_review')       flag = '--pr-review'
  else if (behavior === 'pr_approve') flag = '--pr-approve'
  else throw new Error(`behavior "${behavior}" is not replayable`)

  await admit(behavior, repo, Number(prId))
  const actor = requireAgentAccount()
  const place = behavior === 'pr_review' ? 'pr_review' : 'pr_approve'
  const { model, recovery, catalog } = await reviewChoice(place)
  const claude = needsClaude(catalog, model)
  if (claude) await claudeAuth.requireReady()
  const [owner, repoName] = repo.split('/', 2)
  const modelCliEnv = await prepareModelClis(catalog, [model, recovery])
  const pwd = await localCheckoutPath(owner, repoName)
  const expectedHead = await getHeadSha(repo, Number(prId))
  const source = 'poise:replay'
  const correlationId = randomUUID()
  if (claude) await claudeAuth.requireReady()
  if ((await reviewChoice(place)).model !== model) throw new Error('Review model changed; retry the request')
  captureBehaviorAdmission({ admissionKey: correlationId, nativeId: correlationId,
    behavior: behavior === 'pr_review' ? 'review-new-prs' : 'approve-prs', source, owner, actor,
    repository: repo, number: Number(prId), head: expectedHead, slot: 'primary', plannedSlots: ['primary'], startedAt: new Date().toISOString() })
  try { await spawnDetached(CLI, [
    flag,
    `#${prId}`,
    '--model',
    model,
    '--recovery-model',
    recovery,
    '--actor',
    actor,
    '--expected-head',
    expectedHead,
    '--source',
    source,
    '--correlation-id',
    correlationId,
    '--pwd',
    pwd,
  ], {
    cwd: agentCwd(),
    env: { ...claudeSubscriptionEnvironment(), ...modelCliEnv },
    onExit: (result) => { if (claude) claudeAuth.observeProcessFailure(result) },
  }) } catch (error) {
    captureBehaviorOutcome({ nativeId: correlationId, state: 'failed', activity: 'settled', stateSource: 'native', outcome: 'spawn_failed' })
    throw error
  }
  return { ok: true, source, correlationId }
}

// A replayed issue review is one fresh full-access run by the Issue review
// default, commenting again as the agent account. It needs no head and no
// local checkout: Caller prepares its own.
async function replayIssueReview(repo: string, issue: string): Promise<{ ok: true, source: string, correlationId: string }> {
  const actor = requireAgentAccount()
  const { model, recovery, catalog } = await reviewChoice('issue_review')
  const claude = needsClaude(catalog, model)
  if (claude) await claudeAuth.requireReady()
  const modelCliEnv = await prepareModelClis(catalog, [model, recovery])
  const source = 'poise:replay'
  const correlationId = randomUUID()
  if (claude) await claudeAuth.requireReady()
  if ((await reviewChoice('issue_review')).model !== model) throw new Error('Review model changed; retry the request')
  captureBehaviorAdmission({ admissionKey: correlationId, nativeId: correlationId,
    behavior: 'review-new-issues', source, owner: repo.split('/')[0], actor,
    repository: repo, number: Number(issue), head: null, slot: 'primary', plannedSlots: ['primary'], startedAt: new Date().toISOString() })
  try { await spawnDetached(CLI, [
    '--issue-review',
    `${repo}#${issue}`,
    '--model',
    model,
    '--recovery-model',
    recovery,
    '--actor',
    actor,
    '--source',
    source,
    '--correlation-id',
    correlationId,
  ], {
    cwd: agentCwd(),
    env: { ...claudeSubscriptionEnvironment(), ...modelCliEnv },
    onExit: (result) => { if (claude) claudeAuth.observeProcessFailure(result) },
  }) } catch (error) {
    captureBehaviorOutcome({ nativeId: correlationId, state: 'failed', activity: 'settled', stateSource: 'native', outcome: 'spawn_failed' })
    throw error
  }
  return { ok: true, source, correlationId }
}
