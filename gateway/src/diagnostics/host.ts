import { spawn, type ChildProcess } from 'node:child_process'
import { normalize } from './contract.js'
import { nativeDiagnostic } from './sources.js'
import { DiagnosticRuntime } from './runtime.js'

/** Host journal is read-only. No unrelated systemd service units are selected. */
export class HostJournal {
  private child: ChildProcess | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private stopping = false
  constructor(private readonly runtime: DiagnosticRuntime, private readonly executable = 'journalctl') {}
  start(): void {
    if (this.timer) return
    this.stopping = false
    this.timer = setInterval(() => { if (!this.child) this.connect() }, 15_000); this.timer.unref()
    this.connect()
  }
  private connect(): void {
    if (this.stopping) return
    let cursor: string | null
    try { cursor = this.runtime.query((db) => db.checkpoint('host-journal')) }
    catch (error) { this.runtime.observe('host-journal', 'kernel', null, String(error)); return }
    const args = ['--follow', '--no-tail', '--all', '--no-pager', '--output=json', '--output-fields=MESSAGE,PRIORITY,_TRANSPORT,_SYSTEMD_UNIT', '--priority=warning', ...(cursor ? ['--after-cursor=' + cursor] : ['--since=-1 minute']), '_TRANSPORT=kernel', '+', '_SYSTEMD_UNIT=docker.service']
    const child = spawn(this.executable, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child
    let pending = Buffer.alloc(0)
    let discarding = false
    let sourceError: string | null = null
    child.once('spawn', () => this.runtime.observe('host-journal', 'kernel', null))
    child.stdout?.on('data', (chunk: Buffer) => {
      let remaining = chunk
      while (remaining.length) {
        const end = remaining.indexOf(10)
        const part = end < 0 ? remaining : remaining.subarray(0, end)
        if (!discarding && pending.length + part.length > 64 * 1024) {
          discarding = true; pending = Buffer.alloc(0)
          this.runtime.observe('host-journal', 'kernel', null, 'Oversized native journal record excluded; historical coverage gap')
        }
        if (!discarding) pending = Buffer.concat([pending, part])
        if (end < 0) return
        remaining = remaining.subarray(end + 1)
        if (discarding) { discarding = false; continue }
        const line = pending; pending = Buffer.alloc(0)
        try {
          if (line.length > 64 * 1024) throw new Error('Host journal record exceeds 64 KiB')
          const row = JSON.parse(line.toString()) as Record<string, unknown>
          if (typeof row.__CURSOR !== 'string' || row.__CURSOR.length > 1024) throw new Error('Host journal supplied no usable cursor')
          if (row._TRANSPORT !== 'kernel' && row._SYSTEMD_UNIT !== 'docker.service') continue
          if (row._SYSTEMD_UNIT === 'docker.service' && row._TRANSPORT !== 'kernel' && !/poise[-_. ]|daemon|no space left|read-only file system|out of memory|too many open files/i.test(String(row.MESSAGE))) {
            this.runtime.query((db) => db.commitDelivery([], 'host-journal', String(row.__CURSOR))); continue
          }
          // Native operational metadata only; never unit environments or arbitrary service payloads.
          const input = nativeDiagnostic(row, row._TRANSPORT === 'kernel' ? 'kernel' : 'docker', row.__CURSOR, null)
          input.message = input.message.replace(/\/(?:home|Users)\/[^\s:'"<>]+/g, '[private path]')
          input.context = { sourceCursor: row.__CURSOR, unit: row._SYSTEMD_UNIT ?? null, transport: row._TRANSPORT ?? null }
          const event = normalize(input)
          const rejected = this.runtime.deliver(event ? [event] : [], 'host-journal', String(row.__CURSOR), { id: 'host-journal', source: 'kernel', workspace: null })
          sourceError = null
          if (rejected) this.runtime.partial('host-journal', 'kernel', null, 'Native evidence rejected; historical collection gap')
          else this.runtime.observe('host-journal', 'kernel', null)
        } catch (error) { sourceError = String(error); this.runtime.observe('host-journal', 'kernel', null, sourceError); child.kill('SIGTERM'); return }
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      sourceError = chunk.subarray(0, 2048).toString()
      this.runtime.observe('host-journal', 'kernel', null, sourceError)
      if (/failed to seek.*cursor|cursor.*not found/i.test(sourceError)) {
        try { this.runtime.query((db) => db.commitDelivery([], 'host-journal', '')) }
        catch (error) { this.runtime.observe('host-journal', 'kernel', null, String(error)) }
      }
    })
    child.once('error', (error) => this.runtime.observe('host-journal', 'kernel', null, error.message))
    child.once('close', (code, signal) => {
      if (this.child === child) this.child = null
      if (!this.stopping) this.runtime.observe('host-journal', 'kernel', null, sourceError ?? `Host journal stopped (exit ${code}, signal ${signal}); observation unavailable`)
    })
  }
  stop(): void { this.stopping = true; if (this.timer) clearInterval(this.timer); this.timer = null; this.child?.kill('SIGTERM'); this.child = null }
}
