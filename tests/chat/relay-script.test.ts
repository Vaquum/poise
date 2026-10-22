// The per-session relay process: Poise spawns it, it owns the agent's
// stdio, and a reconnecting Poise gets the spooled turn first, then live
// output. These tests drive the real relay script with scripted agents.

import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { CLAUDE_SUBSCRIPTION_CLI } from '../../server/process'
import { WORKER_GATE, pgidAlive, pidAlive } from '../../server/chat/worker'
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

  it('shuts an adopted relay down and waits for it to leave', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'poise-relay-'))
    const socketPath = join(dir, 'r.sock')
    const first = track(await spawnRelay({
      sessionId: 'session-relay-adopted-shutdown', dir, socketPath, command: process.execPath, args: ['-e', ECHO_AGENT], env: {}, cwd: dir,
    }))
    await first.go()
    first.turnStart('turn-1')
    const relayPid = first.relayPid
    const gatePgid = first.gatePgid
    first.detach()
    const { connection: second } = await attachRelay({ sessionId: 'session-relay-adopted-shutdown', dir, socketPath, relayPid, relayIdent: first.ident })
    track(second)
    // Adopted: no child handle, but shutdown still waits the relay out,
    // so the runtime's group probe after it does not fail.
    await second.shutdown()
    expect(pidAlive(relayPid)).toBe(false)
    expect(pgidAlive(gatePgid)).toBe(false)
    expect(existsSync(socketPath)).toBe(false)
    expect(existsSync(join(dir, 'turn.spool'))).toBe(false)
  })

  it('reports a lost socket to a live adopted relay as a dead link, not a dead agent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'poise-relay-'))
    const socketPath = join(dir, 'r.sock')
    const first = track(await spawnRelay({
      sessionId: 'session-relay-link-loss', dir, socketPath, command: process.execPath, args: ['-e', ECHO_AGENT], env: {}, cwd: dir,
    }))
    await first.go()
    first.detach()
    const { connection: second } = await attachRelay({ sessionId: 'session-relay-link-loss', dir, socketPath, relayPid: first.relayPid, relayIdent: first.ident })
    track(second)
    await second.whenLive()
    const exit = new Promise((resolve) => second.once('exit', (...args: unknown[]) => resolve(args)))
    // Drop the link without stopping anything, as a relay does when it
    // sheds a client it can no longer serve.
    ;(second as unknown as { socket: { destroy(): void } }).socket.destroy()
    // No code, no signal, like a detach: the runtime keeps the worker
    // and relay rows (and the lease) for a verified shutdown.
    expect(await exit).toEqual([null, null])
    expect(pidAlive(first.relayPid)).toBe(true)
    // The relay survived for the next Poise: it adopts cleanly.
    const { connection: third } = await attachRelay({ sessionId: 'session-relay-link-loss', dir, socketPath, relayPid: first.relayPid, relayIdent: first.ident })
    track(third)
    await third.whenLive()
  })

  it('sends bytes written during a replay exactly once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'poise-relay-'))
    const socketPath = join(dir, 'r.sock')
    const first = track(await spawnRelay({
      sessionId: 'session-relay-spool-bound', dir, socketPath, command: process.execPath, args: ['-e', ECHO_AGENT], env: {}, cwd: dir,
    }))
    await first.go()
    first.turnStart('turn-1')
    // A spool slow enough that the probe below lands mid-stream: the
    // relay appends it to the spool and queues it, so it must arrive
    // once, after the spooled bytes — never twice, never interleaved.
    const filler = `filler-${'x'.repeat(2 * 1024 * 1024)}\n`
    first.stdin!.write(filler)
    await collectStdout(first, `echo:${filler}`.length)
    first.detach()
    const { connection: second } = await attachRelay({ sessionId: 'session-relay-spool-bound', dir, socketPath, relayPid: first.relayPid, relayIdent: first.ident })
    track(second)
    second.stdin!.write('probe\n')
    const replayed = await collectStdout(second, `echo:${filler}`.length + 'echo:probe\n'.length, 15_000)
    expect(replayed).toBe(`echo:${filler}echo:probe\n`)
    await second.whenLive()
  })

  it('keeps a replacement replay exact when the stale client closes late', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'poise-relay-'))
    const socketPath = join(dir, 'r.sock')
    const first = track(await spawnRelay({
      sessionId: 'session-relay-replace', dir, socketPath, command: process.execPath, args: ['-e', ECHO_AGENT], env: {}, cwd: dir,
    }))
    await first.go()
    first.turnStart('turn-1')
    const filler = `filler-${'x'.repeat(1024 * 1024)}\n`
    first.stdin!.write(filler)
    await collectStdout(first, `echo:${filler}`.length)
    first.detach()

    const frame = (kind: number, payload: Buffer): Buffer => {
      const header = Buffer.alloc(5)
      header.writeUInt8(kind, 0)
      header.writeUInt32BE(payload.length, 1)
      return Buffer.concat([header, payload])
    }
    const hello = frame(1, Buffer.from(JSON.stringify({ version: 1, session: 'session-relay-replace' }), 'utf8'))
    const connected = (socket: Socket): Promise<void> => new Promise((resolve, reject) => {
      socket.once('connect', () => resolve())
      socket.once('error', reject)
    })
    // Raw client A attaches; its replay is drained and ignored.
    const a = connect(socketPath)
    await connected(a)
    const aReady = new Promise<unknown>((resolve, reject) => {
      let buffer: Buffer = Buffer.alloc(0)
      const timer = setTimeout(() => reject(new Error('A never got READY')), 5_000)
      a.on('data', (chunk: Buffer) => {
        buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk
        while (buffer.length >= 5) {
          const kind = buffer.readUInt8(0)
          const length = buffer.readUInt32BE(1)
          if (buffer.length < 5 + length) return
          const payload = buffer.subarray(5, 5 + length)
          buffer = buffer.subarray(5 + length)
          if (kind === 101) {
            clearTimeout(timer)
            a.removeAllListeners('data')
            a.on('data', () => {})
            a.on('error', () => {})
            resolve(JSON.parse(payload.toString('utf8')))
            return
          }
        }
      })
    })
    a.write(hello)
    await aReady
    // Raw client B is already connected but silent; ending A and helloing
    // B in one tick lands B's hello while A is FIN-seen but not closed,
    // so the relay replaces A and streams the spool to B — and A's close
    // lands mid-replay. Only the new client's close may reset that replay.
    // (If B is refused instead, A had not ended yet; a fresh B retries.)
    const attempt = async (socket: Socket, writeHello: () => void): Promise<{ stdout: string, spoolTurn: unknown }> => new Promise((resolve, reject) => {
      let buffer: Buffer = Buffer.alloc(0)
      let text = ''
      let spoolTurn: unknown = null
      const timer = setTimeout(() => reject(new Error(`B timed out waiting for LIVE after ${text.length} stdout bytes`)), 15_000)
      socket.on('data', (chunk: Buffer) => {
        buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk
        while (buffer.length >= 5) {
          const kind = buffer.readUInt8(0)
          const length = buffer.readUInt32BE(1)
          if (buffer.length < 5 + length) return
          const payload = buffer.subarray(5, 5 + length)
          buffer = buffer.subarray(5 + length)
          if (kind === 101) {
            spoolTurn = (JSON.parse(payload.toString('utf8')) as { spoolTurn?: unknown }).spoolTurn
            socket.write(frame(3, Buffer.from('probe\n')))
          } else if (kind === 103) text += payload.toString('utf8')
          else if (kind === 106) { clearTimeout(timer); resolve({ stdout: text, spoolTurn }); return }
          else if (kind === 108) { clearTimeout(timer); reject(new Error(`relay refused B: ${payload.toString('utf8')}`)); return }
        }
      })
      socket.on('error', () => {})
      writeHello()
    })
    const b = connect(socketPath)
    await connected(b)
    let done: { stdout: string, spoolTurn: unknown } | null = null
    let lastRefusal = ''
    try {
      try {
        done = await attempt(b, () => { a.end(); b.write(hello) })
      } catch (error) {
        lastRefusal = error instanceof Error ? error.message : String(error)
        if (!lastRefusal.includes('already attached')) throw error
      }
      for (let retry = 0; !done && retry < 10; retry++) {
        await new Promise((resolve) => setTimeout(resolve, 10))
        const next = connect(socketPath)
        await connected(next)
        try {
          done = await attempt(next, () => next.write(hello))
        } catch (error) {
          lastRefusal = error instanceof Error ? error.message : String(error)
          if (!lastRefusal.includes('already attached')) throw error
        } finally {
          next.destroy()
        }
      }
      if (!done) throw new Error(`B never attached: ${lastRefusal}`)
      expect(done.spoolTurn).toBe('turn-1')
      expect(done.stdout).toBe(`echo:${filler}echo:probe\n`)
    } finally {
      a.destroy()
      b.destroy()
    }
  })
})
