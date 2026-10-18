import { createHash } from 'node:crypto'
import { TASK_STDERR_LINE_LIMIT, type ContainerSummary, type DockerClient, type TaskFailureEvidence } from '../docker.js'
import type { Context } from '../context.js'
import { signAssertion } from '../assertion.js'
import http from 'node:http'
import { normalize, type DiagnosticInput, type LogEvent } from './contract.js'
import { DiagnosticRuntime } from './runtime.js'
import { nativeDiagnostic, supervisorDiagnostic, workspaceEnvelope } from './sources.js'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const handle = (value: string | undefined) => value && /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(value) ? value : null
export const diagnosticOwner = (labels: Record<string, string>) =>
  labels['poise.managed'] === 'true' || labels['poise.task'] === 'install-release' ? handle(labels['poise.workspace']) : null
export const diagnosticManaged = (labels: Record<string, string>) => diagnosticOwner(labels) !== null || labels['com.docker.compose.project'] === 'poise'

/** Only an allow-listed technical projection can cross the infrastructure boundary. */
export function gatewayDiagnostic(level: string, operation: string, fields: Record<string, unknown>): DiagnosticInput {
  const workspace = typeof fields.handle === 'string' ? handle(fields.handle) : null
  const shared = /^(?:proxy\.|workspace\.(?:unreachable|start|stop|drain|update)|disk\.)/.test(operation)
  const context = Object.fromEntries(['method', 'route', 'upstream', 'durationMs', 'requestId', 'container', 'release', 'limit', 'free', 'total', 'errno', 'code', 'disconnect']
    .map((key) => [key, fields[key] ?? null]))
  const cause = typeof fields.error === 'string' ? fields.error.replace(/\/(?:home|Users)\/[^\s:'"<>]+/g, '[private path]').replace(/https?:\/\/[^\s]+/g, '[upstream URL]') : null
  return { source: 'gateway', level, operation, workspace: shared ? workspace : null, visibility: shared && workspace ? 'infrastructure' : 'operator',
    message: cause ? `${operation}: ${cause}` : operation, context: shared ? context : { ...context, causeUnavailable: cause === null },
    requestId: typeof fields.requestId === 'string' ? fields.requestId : null }
}

/** Docker multiplex framing and line bounds are enforced before JSON parsing. */
function decodedDockerLines(bytes: Buffer): string[] {
  const streams = new Map<number, Buffer[]>()
  let offset = 0
  while (offset < bytes.length) {
    if (bytes.length - offset < 8) throw new Error('Truncated Docker log frame')
    const size = bytes.readUInt32BE(offset + 4)
    if (bytes[offset] > 2 || bytes[offset + 1] || bytes[offset + 2] || bytes[offset + 3] || size > 2 * 1024 * 1024 || offset + 8 + size > bytes.length) throw new Error('Invalid Docker log frame')
    const stream = bytes[offset]
    if (!streams.has(stream)) streams.set(stream, [])
    streams.get(stream)!.push(bytes.subarray(offset + 8, offset + 8 + size)); offset += 8 + size
  }
  const lines = [...streams.values()].flatMap((chunks) => Buffer.concat(chunks).toString('utf8').split('\n').filter(Boolean))
  if (lines.some((line) => Buffer.byteLength(line) > 64 * 1024)) throw new Error('Docker log line bound exceeded; collection gap')
  return lines
}

export function dockerLines(bytes: Buffer): string[] {
  const lines = decodedDockerLines(bytes)
  if (lines.length > 1000) throw new Error('Docker log count bound exceeded; collection gap')
  return lines
}

/** Preserve release-task evidence before cleanup, including unknown completion. */
export function releaseTaskDiagnostic(evidence: TaskFailureEvidence): DiagnosticInput | null {
  const workspace = diagnosticOwner(evidence.labels)
  if (!workspace || evidence.labels['poise.task'] !== 'install-release') return null
  const technical = (value: string) => value.replace(/\/(?:home|Users)\/[^\s:'"<>]+/g, '[private path]')
  let stderr: string | null = null; let stderrError = evidence.stderrError; let lineBoundReached = false
  try {
    if (evidence.stderr) {
      const lines = decodedDockerLines(evidence.stderr)
      lineBoundReached = lines.length > TASK_STDERR_LINE_LIMIT
      stderr = lines.slice(0, TASK_STDERR_LINE_LIMIT).map((line) => line.slice(line.indexOf(' ') + 1)).join('\n')
    }
  }
  catch (error) { stderrError = error instanceof Error ? error.message : String(error) }
  return { id: 'release-task:' + evidence.id, time: null, source: 'docker', component: 'release-installer', operation: 'release.install', phase: evidence.phase,
    level: 'error', workspace, visibility: 'infrastructure', container: evidence.container,
    message: evidence.error ? 'Release installation completion is unknown: ' + technical(evidence.error) : `Release installation task exited ${evidence.exitCode}`,
    exitCode: evidence.exitCode, stderr: stderr === null ? null : technical(stderr), truncated: lineBoundReached || stderrError !== null,
    context: { taskName: evidence.name, controlError: evidence.error === null ? null : technical(evidence.error), stderrEvidenceUnavailable: stderrError === null ? null : technical(stderrError),
      stderrLineLimit: TASK_STDERR_LINE_LIMIT, stderrLineBoundReached: lineBoundReached,
      stderrEvidenceTruncated: lineBoundReached ? 'Docker stderr line bound reached; later cause lines may be missing'
        : stderrError !== null ? 'Stderr capture unavailable; completeness is unverified' : null,
      completionKnown: evidence.phase === 'installer_exit', observedAt: new Date().toISOString() },
    resources: { configuredMemoryLimitBytes: evidence.limits.memoryBytes, configuredNanoCpus: evidence.limits.nanoCpus, configuredPidsLimit: evidence.limits.pids,
      measurement: 'configuration submitted to Docker; incident usage not observed' } }
}

export function observeReleaseTask(runtime: DiagnosticRuntime, evidence: TaskFailureEvidence): void {
  try {
    const input = releaseTaskDiagnostic(evidence)
    if (input) runtime.emit(input)
    runtime.observe('docker-task-reporting', 'collection', null)
  } catch (error) {
    runtime.observe('docker-task-reporting', 'collection', null, error instanceof Error ? error.message : String(error))
    throw error
  }
}

export function dockerLifecycle(value: unknown): DiagnosticInput | null {
  if (!value || typeof value !== 'object') throw new Error('Malformed Docker lifecycle event')
  const row = value as { Type?: string; Action?: string; Actor?: { ID?: string; Attributes?: Record<string, string> }; timeNano?: number; time?: number }
  const labels = row.Actor?.Attributes ?? {}
  if (row.Type !== 'container' || !diagnosticManaged(labels)) return null
  const action = row.Action ?? ''
  const exitCode = labels.exitCode === undefined || !/^-?\d+$/.test(labels.exitCode) ? null : Number(labels.exitCode)
  const level = action === 'oom' ? 'critical' : action === 'die' && exitCode !== null && Number.isFinite(exitCode) && exitCode !== 0 ? 'error' : action === 'health_status: unhealthy' ? 'warning' : null
  if (!level) return null
  const workspace = diagnosticOwner(labels)
  const time = typeof row.time === 'number' && Number.isFinite(row.time) && row.time >= 0 && row.time < 8.64e12 ? new Date(row.time * 1000).toISOString() : null
  return { id: hash(JSON.stringify([row.Actor?.ID, action, row.timeNano ?? row.time])), time, source: 'docker', operation: 'container.' + action,
    level, workspace, visibility: workspace ? 'infrastructure' : 'operator', container: row.Actor?.ID ?? null,
    message: action === 'oom' ? 'Docker reported a container OOM kill' : action === 'die' ? `Container exited with code ${exitCode}` : 'Docker reported an unhealthy container',
    exitCode: Number.isFinite(exitCode) ? exitCode : null, resources: { oomKilled: action === 'oom', memoryLimitBytes: null, cpuLimit: null, pidsLimit: null } }
}

class WorkspaceCursorError extends Error {}

export class EnvironmentCollectors {
  private timer: ReturnType<typeof setInterval> | null = null
  private pass: Promise<void> | null = null
  private stopping = false
  constructor(private readonly runtime: DiagnosticRuntime, private readonly docker: DockerClient, private readonly context: Context, private readonly workspaceTimeoutMs = 5000) {}

  start(): void {
    if (this.timer) return
    this.stopping = false
    if (this.context.deps.config.proxyListen) {
      try {
        this.runtime.query((db) => {
          if (!db.readCoverage({ workspace: 'operator', operator: true }).some((source) => source.id === 'external-ingress')) db.coverage({
            id: 'external-ingress', source: 'ingress', workspace: null, status: 'not-configured', observedAt: null, ingestedAt: null, availableFrom: null,
            error: 'External proxy diagnostic delivery has not been configured; coverage is unknown', gaps: [],
          })
        })
      } catch (error) { this.runtime.observe('external-ingress', 'ingress', null, String(error)) }
    }
    const run = () => { if (!this.pass) this.pass = this.collect().finally(() => { this.pass = null }) }
    this.timer = setInterval(run, 15_000); this.timer.unref(); run()
  }
  async stop(): Promise<void> { this.stopping = true; if (this.timer) clearInterval(this.timer); this.timer = null; await this.pass }

  private async collect(): Promise<void> {
    const until = Math.floor(Date.now() / 1000) - 1
    this.runtime.observe('docker-task-reporting', 'collection', null, this.docker.taskCaptureError)
    try {
      const containers = await this.docker.diagnosticContainers()
      if (containers.length > 128) throw new Error('Docker collection exceeds 128 source containers; remaining coverage is unavailable')
      this.runtime.query((db) => db.reconcileDockerCheckpoints(containers.map((container) => container.Id)))
      for (const container of containers) {
        if (this.stopping) return
        await this.logs(container, until)
      }
      await this.events(until)
      this.runtime.observe('docker', 'docker', null)
    } catch (error) { this.runtime.observe('docker', 'docker', null, String(error)) }
    for (const user of this.context.deps.store.listUsers()) {
      if (this.stopping) return
      if (user.disabledAt === null) await this.workspace(user.handle, user.login)
    }
  }

  private async logs(container: ContainerSummary, until: number): Promise<void> {
    if (!diagnosticManaged(container.Labels) || container.Labels['com.docker.compose.service'] === 'gateway') return
    const workspace = diagnosticOwner(container.Labels)
    const key = 'docker-log:' + container.Id
    const coverage = workspace ? 'workspace-stream:' + workspace : 'ingress'
    try {
      const previous = this.runtime.query((db) => db.checkpoint(key))
      const since = previous ? Number(previous) : until - 60
      const bytes = await this.docker.diagnosticRead(`/containers/${encodeURIComponent(container.Id)}/logs?stdout=1&stderr=1&timestamps=1&since=${since}&until=${until}&tail=1000`)
      const events: LogEvent[] = []
      let excluded = 0
      const lines = dockerLines(bytes)
      if (lines.length >= 1000) throw new Error('Docker log tail bound reached; earlier records may be missing')
      for (const line of lines) {
        const content = line.slice(line.indexOf(' ') + 1)
        const startup = workspace ? supervisorDiagnostic(content, container.Id + ':' + hash(line), workspace) : null
        if (startup) {
          const event = normalize({ ...startup, time: line.slice(0, line.indexOf(' ')), container: container.Id })
          if (event) events.push(event)
          continue
        }
        let row: unknown
        try { row = JSON.parse(content) } catch { excluded++; continue }
        const envelope = row && typeof row === 'object' && 'poiseDiagnostic' in row ? row.poiseDiagnostic : null
        if (workspace && envelope) {
          try { events.push(workspaceEnvelope(envelope, workspace, Date.now(), [])) }
          catch (error) {
            excluded++
            const warning = normalize({ id: 'invalid-envelope:' + hash(line), source: 'collection', operation: 'workspace.envelope_rejected', level: 'warning', workspace, message: error instanceof Error ? error.message : String(error) })
            if (warning) events.push(warning)
          }
        }
        else if (container.Labels['com.docker.compose.service'] === 'caddy') {
          const input = nativeDiagnostic(row, 'ingress', container.Id + ':' + hash(line), null)
          // Never copy HTTP request headers, query strings, payloads or arbitrary route IDs.
          input.context = { container: container.Id, originalSource: 'caddy' }
          const event = normalize(input)
          if (event) events.push(event)
        } else excluded++
      }
      const rejected = this.runtime.deliver(events, key, String(until), { id: coverage, source: workspace ? 'poise' : 'ingress', workspace })
      this.runtime.observe(coverage, workspace ? 'poise' : 'ingress', workspace, excluded || rejected ? 'Unstructured source output excluded to protect user content; structured diagnostic coverage only' : null)
    } catch (error) {
      if (/bound|exceeds|tail/i.test(String(error))) {
        try { this.runtime.query((db) => db.commitDelivery([], key, String(until))) }
        catch (failure) { this.runtime.observe(coverage, workspace ? 'poise' : 'ingress', workspace, String(failure)); return }
      }
      this.runtime.observe(coverage, workspace ? 'poise' : 'ingress', workspace, String(error))
    }
  }

  private async events(until: number): Promise<void> {
    const key = 'docker-events'
    try {
      const previous = this.runtime.query((db) => db.checkpoint(key))
      const since = previous ? Number(previous) : until - 60
      const bytes = await this.docker.diagnosticRead(`/events?since=${since}&until=${until}`, 512 * 1024)
      const lines = bytes.toString().split('\n').filter(Boolean)
      if (lines.length >= 256) throw new Error('Docker retained native event history limit reached; collection gap')
      const events: LogEvent[] = []
      const inspectionDeadline = Date.now() + 2000
      for (const line of lines) {
        const input = dockerLifecycle(JSON.parse(line))
        if (!input) continue
        input.id = 'docker-event:' + hash(line)
        if (input.container && Date.now() < inspectionDeadline) {
          try {
            const bytes = await this.docker.diagnosticRead(`/containers/${encodeURIComponent(input.container)}/json`, 256 * 1024, 250)
            const detail = JSON.parse(bytes.toString()) as { Image?: string; State?: { OOMKilled?: boolean; ExitCode?: number; StartedAt?: string; FinishedAt?: string }; HostConfig?: { Memory?: number; NanoCpus?: number; PidsLimit?: number } }
            const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null
            input.resources = { ...input.resources, memoryLimitBytes: finite(detail.HostConfig?.Memory), memoryUnlimited: detail.HostConfig?.Memory === 0,
              cpuLimitNanoCpus: finite(detail.HostConfig?.NanoCpus), pidsLimit: finite(detail.HostConfig?.PidsLimit),
              observedOomKilled: typeof detail.State?.OOMKilled === 'boolean' ? detail.State.OOMKilled : null,
              measuredAt: new Date().toISOString(), measurement: 'container configuration/state after the native event' }
            input.context = { imageId: detail.Image ?? null, startedAt: detail.State?.StartedAt ?? null, finishedAt: detail.State?.FinishedAt ?? null }
          } catch (error) { input.context = { resourceEvidenceUnavailable: true, inspectionError: error instanceof Error ? error.message : String(error) } }
        } else input.context = { resourceEvidenceUnavailable: true, reason: 'Bounded resource-inspection budget exhausted' }
        const event = normalize(input)
        if (event) events.push(event)
      }
      const rejected = this.runtime.deliver(events, key, String(until), { id: key, source: 'docker', workspace: null })
      if (rejected) this.runtime.partial('docker-events', 'docker', null, 'Native evidence rejected; historical collection gap')
      else this.runtime.observe('docker-events', 'docker', null)
    } catch (error) {
      if (/bound|exceeds|limit reached/i.test(String(error))) {
        try { this.runtime.query((db) => db.commitDelivery([], key, String(until))) }
        catch (failure) { this.runtime.observe('docker-events', 'docker', null, String(failure)); return }
      }
      this.runtime.observe('docker-events', 'docker', null, String(error))
    }
  }

  private async workspace(handle: string, login: string): Promise<void> {
    const key = 'workspace:' + handle
    try {
      const cursor = this.runtime.query((db) => db.checkpoint(key))
      const target = this.context.deps.upstream(handle)
      const { config, keys, now } = this.context.deps
      const path = '/api/service/diagnostics' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : '')
      const page = await new Promise<{ version: number; events: unknown[]; cursor: string; coverage: { status: string; error?: string | null } }>((resolve, reject) => {
        const req = http.get({ host: target.host, port: target.port, path, agent: false, headers: {
          host: `${handle}.${config.domain}`, 'x-poise-identity': signAssertion(keys.privateKey, { handle, login, scope: 'admin' }, now()),
        } }, (res) => {
          let size = 0; const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 256 * 1024) req.destroy(new Error('Workspace diagnostic delivery exceeds 256 KiB')); else chunks.push(chunk) })
          res.on('error', reject)
          res.on('end', () => {
            try {
              const text = Buffer.concat(chunks).toString()
              if (res.statusCode === 409 && cursor && JSON.parse(text)?.error === 'diagnostic_cursor_invalid') throw new WorkspaceCursorError('Workspace diagnostic store rejected its previous cursor; bounded backfill restarted with a historical collection gap')
              if (res.statusCode !== 200) throw new Error(`Workspace diagnostic source answered HTTP ${res.statusCode}`)
              resolve(JSON.parse(text))
            }
            catch (error) { reject(error) }
          })
        })
        const deadline = setTimeout(() => req.destroy(new Error('Workspace diagnostic source exceeded its absolute deadline')), this.workspaceTimeoutMs)
        req.once('close', () => clearTimeout(deadline))
        req.setTimeout(this.workspaceTimeoutMs, () => req.destroy(new Error('Workspace diagnostic source timed out'))); req.on('error', reject)
      })
      if (page.version !== 1 || !Array.isArray(page.events) || page.events.length > 3 || typeof page.cursor !== 'string' || !page.coverage || typeof page.coverage.status !== 'string') throw new Error('Workspace diagnostic delivery is incompatible')
      const events: LogEvent[] = []
      let rejected = 0
      for (const row of page.events) {
        try { events.push(workspaceEnvelope(row, handle, Date.now(), [])) }
        catch (error) {
          rejected++
          const warning = normalize({ id: 'workspace-rejected:' + hash(JSON.stringify(row)), source: 'collection', operation: 'workspace.envelope_rejected',
            level: 'warning', workspace: handle, message: error instanceof Error ? error.message : String(error) })
          if (warning) events.push(warning)
        }
      }
      rejected += this.runtime.deliver(events, key, page.cursor, { id: key, source: 'poise', workspace: handle })
      if (page.coverage.status === 'unavailable' || page.coverage.status === 'initializing' || page.coverage.error) this.runtime.observe(key, 'poise', handle, 'Workspace diagnostic sink is currently unavailable')
      else if (rejected || page.coverage.status === 'partial' || ('hasMore' in page && page.hasMore)) this.runtime.partial(key, 'poise', handle, 'Workspace is reachable; historical gaps or pending backfill limit completeness')
      else this.runtime.observe(key, 'poise', handle)
    } catch (error) {
      if (error instanceof WorkspaceCursorError) {
        this.runtime.observe(key, 'poise', handle, error.message)
        try { this.runtime.query((db) => db.resetCheckpoint(key)) }
        catch (failure) { this.runtime.observe(key, 'poise', handle, String(failure)) }
      } else this.runtime.observe(key, 'poise', handle, String(error))
    }
  }
}
