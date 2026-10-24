import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { spawnWorker, workerGateStatus, workerIdentityMatches } from '../../server/chat/worker'

let root = ''

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-worker-status-'))
  await mkdir(join(root, 'emptybin'))
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

describe('worker gate verification', () => {
  it('verifies a live gate, rejects the dead and the reused', async () => {
    const gate = spawnWorker('true', [], { cwd: root })
    try {
      expect(await workerGateStatus(gate.pid, gate.ident)).toBe('verified')
      expect(await workerIdentityMatches(gate.pid, gate.ident)).toBe(true)
      // This process is alive but is no gate: pid reuse reads gone, not unknown.
      expect(await workerGateStatus(process.pid, gate.ident)).toBe('gone')
      expect(await workerIdentityMatches(process.pid, gate.ident)).toBe(false)
      // A malformed ident can never verify.
      expect(await workerGateStatus(gate.pid, 'nope!')).toBe('gone')
    } finally {
      await gate.terminate(2_000)
    }
    expect(await workerGateStatus(gate.pid, gate.ident)).toBe('gone')
    expect(await workerIdentityMatches(gate.pid, gate.ident)).toBe(false)
  }, 25_000)

  it('reports unknown when the process table cannot be read', async () => {
    vi.stubEnv('PATH', join(root, 'emptybin'))
    try {
      // A live pid whose table entry is unreadable: not gone, not verified.
      expect(await workerGateStatus(process.pid, '12345678-1234-1234-1234-1234567890ab')).toBe('unknown')
    } finally {
      vi.unstubAllEnvs()
    }
  }, 25_000)
})
