// One program on a pseudo-terminal, through the Python helper (helper.ts):
// its output as it comes, input and resizes on the way in, and one exit.

import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { constants } from 'node:os'
import type { Writable } from 'node:stream'
import { PTY_HELPER } from './helper'

export interface TerminalCommand {
  command: string
  args: readonly string[]
  env: NodeJS.ProcessEnv
  cwd: string
}

export interface TerminalSize {
  cols: number
  rows: number
}

/** The helper hangs its program up within a second; past this its own
 *  process group is killed, which closes the terminal under the program. */
const HELPER_GRACE_MS = 3_000

/** What a terminal session needs of its process; tests substitute it. */
export interface TerminalProcess extends EventEmitter<TerminalProcessEvents> {
  write(data: Buffer): boolean
  resize(size: TerminalSize): void
  pause(): void
  resume(): void
  close(): void
}

export interface TerminalProcessEvents {
  output: [Buffer]
  /** Input can be written again after write() returned false. */
  drain: []
  /** The terminal could not start; `exit` follows. */
  error: [Error]
  /** Exactly once: the program's exit code, or 128 + its signal. */
  exit: [number]
}

export class PtyProcess extends EventEmitter<TerminalProcessEvents> implements TerminalProcess {
  private readonly child: ChildProcess
  private readonly control: Writable
  private exited = false
  private stopping: NodeJS.Timeout | null = null

  constructor(command: TerminalCommand, size: TerminalSize) {
    super()
    // `python3` from the program's own PATH; a missing one is the spawn
    // error below, reported as such.
    this.child = spawn('python3', ['-I', '-c', PTY_HELPER, String(size.cols), String(size.rows), command.command, ...command.args], {
      cwd: command.cwd,
      env: command.env,
      // The helper leads its own process group, so a stuck one dies with it.
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    })
    const child = this.child
    this.control = child.stdio[3] as Writable
    child.stdout!.on('data', (chunk: Buffer) => this.emit('output', chunk))
    let diagnostics = ''
    child.stderr!.on('data', (chunk: Buffer) => {
      diagnostics += chunk.toString('utf8')
      const lines = diagnostics.split('\n')
      diagnostics = lines.pop() ?? ''
      for (const line of lines) if (line.trim()) console.error(`[terminal] ${line}`)
    })
    child.stdin!.on('drain', () => this.emit('drain'))
    // A write racing the helper's exit fails; the exit that follows is what
    // ends the terminal, so these only make sure it is being ended.
    child.stdin!.on('error', () => this.close())
    this.control.on('error', () => this.close())
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (child.pid !== undefined) {
        console.error('[terminal] the helper process failed:', error)
        return
      }
      this.emit('error', new Error(error.code === 'ENOENT'
        ? 'The terminal needs python3 on Poise\'s PATH, and there is none.'
        : `The terminal could not start python3: ${error.message}`))
    })
    child.once('close', (code, signal) => {
      if (this.stopping) clearTimeout(this.stopping)
      this.exited = true
      if (child.pid === undefined) this.emit('exit', 127)
      else this.emit('exit', code ?? 128 + (signal ? constants.signals[signal] : 0))
    })
  }

  write(data: Buffer): boolean {
    if (this.exited || !this.child.stdin!.writable) return true
    return this.child.stdin!.write(data)
  }

  resize(size: TerminalSize): void {
    if (this.exited || !this.control.writable) return
    this.control.write(`resize ${size.cols} ${size.rows}\n`)
  }

  pause(): void {
    this.child.stdout!.pause()
  }

  resume(): void {
    this.child.stdout!.resume()
  }

  /** Hang the program up. The helper kills its process group and exits; a
   *  helper that has not exited after HELPER_GRACE_MS is killed with its own. */
  close(): void {
    if (this.exited || this.stopping) return
    const pid = this.child.pid
    if (pid === undefined) return
    // Nobody reads the rest of the output now; let it drain so `close` comes.
    this.child.stdout!.resume()
    this.child.stdin!.end()
    this.child.kill('SIGTERM')
    this.stopping = setTimeout(() => {
      try { process.kill(-pid, 'SIGKILL') } catch { /* the group has already gone */ }
    }, HELPER_GRACE_MS)
    this.stopping.unref()
  }
}
