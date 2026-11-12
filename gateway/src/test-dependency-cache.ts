import { mkdtemp, open, rm, unlink, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MAX_BYTES = 512 * 1024 * 1024
const MAX_PARTS = 128
const IDLE_MS = 30 * 60_000

interface Part {
  file: FileHandle
  size: number
  usedAt: number
}

/** Verified gzip members, kept on disk for this relay process only. */
export class TestDependencyCache {
  private readonly parts = new Map<string, Part>()
  private size = 0
  private stopped = false

  constructor(private readonly report: (error: unknown) => void) {}

  async get(handle: string, digest: string, now: number): Promise<Buffer | null> {
    const key = `${handle}:${digest}`
    const part = this.parts.get(key)
    if (!part) return null
    if (now - part.usedAt >= IDLE_MS) {
      this.evict(key)
      return null
    }
    this.parts.delete(key)
    this.parts.set(key, part)
    part.usedAt = now
    // An explicit position permits concurrent reads. FileHandle.close waits for an outstanding read.
    const result = await part.file.read(Buffer.allocUnsafe(part.size), 0, part.size, 0)
    return result.bytesRead === part.size ? result.buffer : null
  }

  async put(handle: string, digest: string, data: Buffer, now: number): Promise<void> {
    const key = `${handle}:${digest}`
    if (this.stopped || this.parts.has(key)) return
    const dir = await mkdtemp(join(tmpdir(), 'poise-test-cache-'))
    const path = join(dir, 'part')
    let file: FileHandle | undefined
    try {
      file = await open(path, 'wx+', 0o600)
      // Keep the descriptor only. Even an abrupt gateway exit releases the data.
      await unlink(path)
      await file.writeFile(data)
      if (this.stopped || this.parts.has(key)) return
      while (this.size + data.length > MAX_BYTES || this.parts.size >= MAX_PARTS) {
        this.evict(this.parts.keys().next().value!)
      }
      this.parts.set(key, { file, size: data.length, usedAt: now })
      this.size += data.length
      file = undefined
    } finally {
      await file?.close()
      await rm(dir, { recursive: true, force: true })
    }
  }

  sweep(now: number): void {
    for (const [key, part] of this.parts) {
      if (now - part.usedAt >= IDLE_MS) this.evict(key)
    }
  }

  stop(): void {
    this.stopped = true
    for (const key of this.parts.keys()) this.evict(key)
  }

  private evict(key: string): void {
    const part = this.parts.get(key)!
    this.parts.delete(key)
    this.size -= part.size
    void part.file.close().catch(this.report)
  }
}
