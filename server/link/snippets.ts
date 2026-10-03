// The feed of the snippets a paired desktop receives (see linkSnippetsFrom):
// it re-reads the library whenever it changes and announces a new version to
// the event streams and the long polls waiting for one.

import { EventEmitter } from 'node:events'
import type { ServerResponse } from 'node:http'
import { snippetLibraryEvents } from '../snippet-library'
import { readSnippetSnapshotSync } from '../snippets'
import { linkSnippetsFrom, type LinkSnippets } from './espanso'

/** How a wait for a new version ended. */
export type WaitOutcome = 'changed' | 'timeout' | 'gone' | 'closed'

interface Waiter {
  version: string
  finish(outcome: WaitOutcome): void
}

/** Emits `version` with each version unlike the one read before it. */
export class SnippetFeed extends EventEmitter {
  private version: string | null = null
  private readonly waiters = new Set<Waiter>()
  private closed = false
  private readonly onLibraryChanged = () => {
    try {
      this.read()
    } catch (error) {
      console.error('[link] the snippets could not be read after a change:', error)
    }
  }

  constructor(private readonly maxWaiters: number) {
    super()
    snippetLibraryEvents.on('changed', this.onLibraryChanged)
  }

  /** The desktop copy as the library holds it now. Throws when the library
   *  file cannot be read. */
  read(): LinkSnippets {
    const snippets = linkSnippetsFrom(readSnippetSnapshotSync().raw)
    if (snippets.version !== this.version) {
      this.version = snippets.version
      for (const waiter of this.waiters) {
        if (waiter.version !== snippets.version) waiter.finish('changed')
      }
      this.emit('version', snippets.version)
    }
    return snippets
  }

  get waiting(): number {
    return this.waiters.size
  }

  /** Whether another long poll may wait. */
  get full(): boolean {
    return this.waiters.size >= this.maxWaiters
  }

  /** Waits until a version other than `version` is read, `ms` passes, the
   *  client goes away (`res` closes) or the feed is closed. */
  waitForChange(version: string, ms: number, res: ServerResponse): Promise<WaitOutcome> {
    if (this.closed) return Promise.resolve('closed')
    return new Promise((resolve) => {
      const timer = setTimeout(() => waiter.finish('timeout'), ms)
      timer.unref()
      const gone = () => waiter.finish('gone')
      const waiter: Waiter = {
        version,
        finish: (outcome) => {
          if (!this.waiters.delete(waiter)) return
          clearTimeout(timer)
          res.off('close', gone)
          resolve(outcome)
        },
      }
      this.waiters.add(waiter)
      res.once('close', gone)
    })
  }

  close(): void {
    this.closed = true
    snippetLibraryEvents.off('changed', this.onLibraryChanged)
    for (const waiter of [...this.waiters]) waiter.finish('closed')
    this.removeAllListeners()
  }
}
