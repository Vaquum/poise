import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { groupMembers, spawnWorker, workerGateStatus, workerIdentityMatches } from '../../server/chat/worker'

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

  it('excludes zombies from group members while live members still list', async () => {
    // The worker execs into sleep, so its short-lived sibling is never
    // reaped: it lingers in the table as a zombie until the group dies.
    const gate = spawnWorker('sh', ['-c', 'sleep 0.2 & exec sleep 30'], { cwd: root })
    try {
      gate.go()
      const zombies = async () => {
        const stdout = execFileSync('ps', ['-eo', 'pid=,pgid=,stat='], { encoding: 'utf8' })
        const found: number[] = []
        for (const line of stdout.split('\n')) {
          const fields = line.trim().split(/\s+/)
          if (fields.length < 3) continue
          const [pid, listed] = fields.slice(0, 2).map(Number)
          if (listed === gate.pgid && fields[2].startsWith('Z')) found.push(pid)
        }
        return found
      }
      const deadline = Date.now() + 10_000
      let zombie: number[] = []
      while (Date.now() < deadline) {
        zombie = await zombies()
        if (zombie.length > 0) break
        await new Promise((r) => setTimeout(r, 20))
      }
      // The fixture really produced a zombie; the assertion below is void else.
      expect(zombie.length).toBeGreaterThan(0)
      const members = await groupMembers(gate.pgid)
      expect(members).not.toBeNull()
      for (const pid of zombie) expect(members!.some((member) => member.pid === pid)).toBe(false)
      expect(members!.some((member) => member.pid === gate.pid)).toBe(true)
      expect(members!.some((member) => member.command === 'sleep 30')).toBe(true)
    } finally {
      await gate.terminate(2_000)
    }
  }, 25_000)
})
