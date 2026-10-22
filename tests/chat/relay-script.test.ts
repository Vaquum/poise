// The per-session relay process: Poise spawns it, it owns the agent's
// stdio, and a reconnecting Poise gets the spooled turn first, then live
// output. These tests drive the real relay script with scripted agents.

import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { CLAUDE_SUBSCRIPTION_CLI } from '../../server/process'
import { WORKER_GATE } from '../../server/chat/worker'
import { RELAY_SCRIPT, attachRelay, relayIdentityMatches, spawnRelay, type RelayConnection } from '../../server/chat/relay'

const ECHO_AGENT = `let b='';process.stdin.on('data',(c)=>{b+=c.toString();let i;while((i=b.indexOf('\\n'))>=0){const l=b.slice(0,i+1);b=b.slice(i+1);if(l.includes('quit'))process.exit(0);process.stdout.write('echo:'+l)}})`

const live: RelayConnection[] = []
afterEach(async () => {
  for (const peer of live.splice(0)) {
    try { await peer.shutdown() } catch { /* already gone */ }
    peer.detach()
  }
})

function track(peer: RelayConnection): RelayConnection {
  live.push(peer)
  return peer
}

async function collectStdout(peer: RelayConnection, count: number, timeoutMs = 5_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = ''
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`timed out after ${JSON.stringify(text)}`))
    }, timeoutMs)
    const cleanup = () => {
      clearTimeout(timer)
      peer.stdout!.off('data', onData)
    }
    const onData = (chunk: Buffer) => {
      text += chunk.toString()
      if (text.length >= count) {
        cleanup()
        resolve(text)
      }
    }
    peer.stdout!.on('data', onData)
  })
}

describe('chat relay script', () => {
  it('sits next to the worker gate, so the production bundle finds it too', () => {
    expect(RELAY_SCRIPT).toBe(join(dirname(CLAUDE_SUBSCRIPTION_CLI), 'chat-relay.mjs'))
    expect(existsSync(RELAY_SCRIPT)).toBe(true)
    expect(existsSync(WORKER_GATE)).toBe(true)
  })

  it('starts nothing before GO and pumps both directions after it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'poise-relay-'))
    const peer = track(await spawnRelay({
      sessionId: 'session-relay-1', dir, command: process.execPath, args: ['-e', ECHO_AGENT], env: {}, cwd: dir,
    }))
    expect(peer.gatePid).toBeGreaterThan(0)
    expect(peer.healthy).toBe(true)
    expect(await relayIdentityMatches(peer.relayPid, peer.ident)).toBe(true)
    // Nothing runs before GO: the agent answers nothing.
    peer.stdin!.write('before-go\n')
    await new Promise((resolve) => setTimeout(resolve, 100))
    await peer.go()
    peer.stdin!.write('hello\n')
    const text = await collectStdout(peer, 'echo:hello\n'.length)
    expect(text).toContain('echo:hello\n')
  })

  it('spools the turn output and drops the spool when the turn finishes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'poise-relay-'))
    const peer = track(await spawnRelay({
      sessionId: 'session-relay-2', dir, command: process.execPath, args: ['-e', ECHO_AGENT], env: {}, cwd: dir,
    }))
    await peer.go()
    peer.stdin!.write('unspooled\n')
    await collectStdout(peer, 'echo:unspooled\n'.length)
    expect(existsSync(join(dir, 'turn.spool'))).toBe(false)
    peer.turnStart('turn-1')
    peer.stdin!.write('spooled\n')
    await collectStdout(peer, 'echo:spooled\n'.length)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(readFileSync(join(dir, 'turn.spool'), 'utf8')).toBe('echo:spooled\n')
    const outbound = await peer.getOutbound()
    expect(outbound.truncated).toBe(false)
    expect(outbound.bytes.toString('utf8')).toBe('spooled\n')
    peer.turnFinish()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(existsSync(join(dir, 'turn.spool'))).toBe(false)
  })

  it('replays the spool to a reconnecting client, then goes live', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'poise-relay-'))
    const socketPath = join(dir, 'r.sock')
    const first = track(await spawnRelay({
      sessionId: 'session-relay-3', dir, socketPath, command: process.execPath, args: ['-e', ECHO_AGENT], env: {}, cwd: dir,
    }))
    await first.go()
    first.turnStart('turn-1')
    first.stdin!.write('one\ntwo\n')
    await collectStdout(first, 'echo:one\necho:two\n'.length)
    // A second client is refused while one is attached.
    await expect(attachRelay({ sessionId: 'session-relay-3', dir, socketPath, relayPid: first.relayPid, relayIdent: first.ident }))
      .rejects.toThrow('already attached')
    first.detach()
    const { connection: second, ready } = await attachRelay({ sessionId: 'session-relay-3', dir, socketPath, relayPid: first.relayPid, relayIdent: first.ident })
    track(second)
    expect(ready.spoolTurn).toBe('turn-1')
    const replayed = await collectStdout(second, 'echo:one\necho:two\n'.length)
    expect(replayed).toBe('echo:one\necho:two\n')
    await second.whenLive()
    second.stdin!.write('three\n')
    const liveText = await collectStdout(second, 'echo:three\n'.length)
    expect(liveText).toContain('echo:three\n')
    // The agent never saw a duplicate: the outbound log holds one copy.
    const outbound = await second.getOutbound()
    expect(outbound.bytes.toString('utf8')).toBe('one\ntwo\nthree\n')
  })

  it('shuts the agent and itself down verifiably', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'poise-relay-'))
    const peer = track(await spawnRelay({
      sessionId: 'session-relay-4', dir, command: process.execPath, args: ['-e', ECHO_AGENT], env: {}, cwd: dir,
    }))
    await peer.go()
    peer.turnStart('turn-1')
    await peer.shutdown()
    expect(peer.healthy).toBe(false)
    expect(existsSync(join(dir, 'r.sock'))).toBe(false)
    expect(existsSync(join(dir, 'turn.spool'))).toBe(false)
  })

  it('reports the agent exit and leaves once the agent is gone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'poise-relay-'))
    const peer = track(await spawnRelay({
      sessionId: 'session-relay-5', dir, command: process.execPath, args: ['-e', ECHO_AGENT], env: {}, cwd: dir,
    }))
    await peer.go()
    const exit = new Promise((resolve) => peer.once('exit', (...args: unknown[]) => resolve(args)))
    peer.stdin!.write('quit\n')
    const [code] = (await exit) as [number | null, unknown]
    expect(code).toBe(0)
    expect(peer.exitCode).toBe(0)
  })
})
