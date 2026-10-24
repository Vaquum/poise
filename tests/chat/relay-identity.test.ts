// Relay and gate identity across release directories: after a switch the
// surviving processes still run from the previous release's scripts, and
// the new server must verify them to adopt them. These tests drive the
// real scripts from a stand-in previous-release directory.

import { afterEach, describe, expect, it } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { RELAY_SCRIPT, livePromise, relayIdentityMatches, spawnRelay, RelayConnection } from '../../server/chat/relay'
import { workerIdentityMatches } from '../../server/chat/worker'

const live: RelayConnection[] = []
const strays: ChildProcess[] = []
afterEach(async () => {
  for (const peer of live.splice(0)) {
    try { await peer.shutdown() } catch { /* already gone */ }
    peer.detach()
  }
  for (const child of strays.splice(0)) {
    try { child.kill('SIGKILL') } catch { /* gone */ }
  }
})

/** A stand-in previous release's scripts directory, mirroring the
 *  installed layout (`releases/<release>/poise/scripts/`). */
function oldReleaseScripts(): { relay: string, gate: string } {
  const dir = join(mkdtempSync(join(tmpdir(), 'poise-relay-oldrelease-')), 'releases', 'oldrelease', 'poise', 'scripts')
  mkdirSync(dir, { recursive: true })
  const from = dirname(RELAY_SCRIPT)
  for (const file of ['chat-relay.mjs', 'chat-worker-gate.mjs']) copyFileSync(join(from, file), join(dir, file))
  return { relay: join(dir, 'chat-relay.mjs'), gate: join(dir, 'chat-worker-gate.mjs') }
}

function commandLine(pid: number): string {
  return spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim()
}

describe('relay identity across releases', () => {
  it('verifies a relay and gate running from a previous release directory', async () => {
    const scripts = oldReleaseScripts()
    const dir = mkdtempSync(join(tmpdir(), 'poise-relay-ident-'))
    const relayIdent = randomUUID()
    const gateIdent = randomUUID()
    const peer = await spawnRelay({
      sessionId: 'ident-session', dir,
      command: 'sh', args: ['-c', 'sleep 30'],
      env: { ...process.env }, cwd: dir,
      ident: relayIdent, gateIdent,
      relayScript: scripts.relay, gateScript: scripts.gate,
    })
    live.push(peer)
    // The premise: both processes really run from the old directory.
    expect(commandLine(peer.relayPid)).toContain(join('releases', 'oldrelease'))
    expect(commandLine(peer.gatePid)).toContain(join('releases', 'oldrelease'))
    expect(await relayIdentityMatches(peer.relayPid, relayIdent)).toBe(true)
    expect(await workerIdentityMatches(peer.gatePid, gateIdent)).toBe(true)
    expect(await relayIdentityMatches(peer.relayPid, randomUUID())).toBe(false)
    expect(await workerIdentityMatches(peer.gatePid, randomUUID())).toBe(false)
  })

  it('rejects dead pids, malformed idents and same-named scripts outside a scripts directory', async () => {
    const dead = spawnSync('true').pid!
    expect(await relayIdentityMatches(dead, randomUUID())).toBe(false)
    expect(await workerIdentityMatches(dead, randomUUID())).toBe(false)
    expect(await relayIdentityMatches(process.pid, 'not an ident!!')).toBe(false)

    // Same basename and flag shape, but not from a Poise scripts directory.
    const evilDir = mkdtempSync(join(tmpdir(), 'poise-relay-evil-'))
    const evilScript = join(evilDir, 'chat-relay.mjs')
    writeFileSync(evilScript, 'setTimeout(() => {}, 30000)\n')
    const ident = randomUUID()
    const evil = spawn(process.execPath, [evilScript, '--relay-session', 's', '--relay-ident', ident, '--', 'x'],
      { detached: true, stdio: 'ignore' })
    strays.push(evil)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(commandLine(evil.pid!)).toContain('--relay-ident')
    expect(await relayIdentityMatches(evil.pid!, ident)).toBe(false)
  })
})

describe('adoption liveness bound', () => {
  it('fails a handoff that never goes live instead of hanging', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'poise-relay-nolive-'))
    const peer = new RelayConnection({ sessionId: 'live-never', ident: randomUUID(), dir, socketPath: join(dir, 'r.sock') })
    await expect(livePromise(peer, 50)).rejects.toThrow('did not go live')
    peer.detach()
  })

  it('resolves a live relay before the bound', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'poise-relay-live-'))
    const peer = await spawnRelay({
      sessionId: 'live-session', dir,
      command: 'sh', args: ['-c', 'sleep 30'],
      env: { ...process.env }, cwd: dir,
    })
    live.push(peer)
    await expect(livePromise(peer, 5_000)).resolves.toBeUndefined()
  })
})
