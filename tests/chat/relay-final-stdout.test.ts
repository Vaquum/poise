import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { attachRelay, spawnRelay, type RelayConnection } from '../../server/chat/relay'
import { StdioRpc } from '../../server/chat/rpc'
import { WORKER_GATE } from '../../server/chat/worker'

const PRIME = JSON.stringify({ jsonrpc: '2.0', method: 'test/prime', params: { text: 'spooled' } }) + '\n'
const AGENT = String.raw`
let buffer = '';
process.stdin.on('data', chunk => {
  buffer += chunk.toString();
  let end;
  while ((end = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    if (line === 'prime') { process.stdout.write(${JSON.stringify(PRIME)}); continue; }
    const request = JSON.parse(line);
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id,
      result: { stopReason: 'end_turn' } }) + '\n', () => process.exit(0));
  }
});
`

function fixture(hold: 'stdout' | 'replay') {
  const dir = mkdtempSync(join(tmpdir(), 'relay-final-'))
  const released = join(dir, 'released')
  const gateExited = join(dir, 'gate-exited')
  const gateClosed = join(dir, 'gate-closed')
  const replayHeld = join(dir, 'replay-held')
  const probe = join(dir, 'probe.cjs')
  // Hold the real relay's reads, not the agent: the real worker gate exits
  // normally while stdout EOF or the reconnecting spool is still pending.
  writeFileSync(probe, String.raw`
const cp = require('node:child_process');
const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const originalSpawn = cp.spawn;
const originalRead = fs.createReadStream;
function releaseRead(stream) {
  const timer = setInterval(() => {
    if (!fs.existsSync(process.env.TEST_RELEASE)) return;
    clearInterval(timer); stream.resume();
  }, 5);
  timer.unref();
}
cp.spawn = function(command, args, options) {
  const child = originalSpawn.apply(this, arguments);
  if (args[0] === process.env.TEST_GATE) {
    if (process.env.TEST_HOLD === 'stdout') {
      child.stdout.pause(); releaseRead(child.stdout);
    }
    child.once('exit', () => fs.writeFileSync(process.env.TEST_GATE_EXITED, ''));
    child.once('close', () => fs.writeFileSync(process.env.TEST_GATE_CLOSED, ''));
  }
  return child;
};
fs.createReadStream = function(path, options) {
  const stream = originalRead.apply(this, arguments);
  if (process.env.TEST_HOLD === 'replay' && path === process.env.TEST_SPOOL) {
    stream.pause(); fs.writeFileSync(process.env.TEST_REPLAY_HELD, ''); releaseRead(stream);
  }
  return stream;
};
syncBuiltinESMExports();
`)
  return { dir, released, gateExited, gateClosed, replayHeld, env: {
    PATH: process.env.PATH,
    NODE_OPTIONS: `--require=${probe}`,
    TEST_GATE: WORKER_GATE, TEST_HOLD: hold, TEST_RELEASE: released,
    TEST_GATE_EXITED: gateExited, TEST_GATE_CLOSED: gateClosed,
    TEST_SPOOL: join(dir, 'turn.spool'), TEST_REPLAY_HELD: replayHeld,
  } }
}

async function cleanup(peer: RelayConnection | undefined, proof: ReturnType<typeof fixture>) {
  writeFileSync(proof.released, '')
  try { await peer?.shutdown() } finally {
    peer?.detach()
    rmSync(proof.dir, { recursive: true, force: true })
  }
}

it('delivers the final successful response after gate exit and before stdout EOF', async () => {
  const proof = fixture('stdout')
  let peer: RelayConnection | undefined
  try {
    peer = await spawnRelay({ sessionId: 'final-stdout', dir: proof.dir,
      command: process.execPath, args: ['-e', AGENT], env: proof.env, cwd: proof.dir })
    const rpc = new StdioRpc(peer)
    await peer.go()
    let settled = false
    const result = rpc.request('test/final', {}, { timeoutMs: 5_000 }).then(value => { settled = true; return { value } },
      error => { settled = true; return { error } })
    await vi.waitFor(() => expect(existsSync(proof.gateExited)).toBe(true), { timeout: 5_000 })
    expect(peer.exitCode).toBeNull()
    expect(settled).toBe(false)
    writeFileSync(proof.released, '')
    expect(await result).toEqual({ value: { stopReason: 'end_turn' } })
    await vi.waitFor(() => expect(peer!.exitCode).toBe(0), { timeout: 5_000 })
  } finally { await cleanup(peer, proof) }
})

it('drains a held spool and the final live response before EXITED on reconnect', async () => {
  const proof = fixture('replay')
  let peer: RelayConnection | undefined
  try {
    peer = await spawnRelay({ sessionId: 'final-replay', dir: proof.dir,
      command: process.execPath, args: ['-e', AGENT], env: proof.env, cwd: proof.dir })
    await peer.go()
    peer.turnStart('turn-final')
    peer.stdin.write('prime\n')
    await vi.waitFor(() => expect(readFileSync(join(proof.dir, 'turn.spool'), 'utf8')).toBe(PRIME), { timeout: 5_000 })
    peer.detach()
    const first = peer
    ;({ connection: peer } = await attachRelay({ sessionId: 'final-replay', dir: proof.dir,
      socketPath: first.socketPath, relayPid: first.relayPid, relayIdent: first.ident }))
    const rpc = new StdioRpc(peer)
    let settled = false
    const result = rpc.request('test/final', {}, { timeoutMs: 5_000 }).then(value => { settled = true; return { value } },
      error => { settled = true; return { error } })
    await vi.waitFor(() => {
      expect(existsSync(proof.replayHeld)).toBe(true)
      expect(existsSync(proof.gateClosed) || peer!.exitCode !== null).toBe(true)
    }, { timeout: 5_000 })
    expect(peer.exitCode).toBeNull()
    expect(settled).toBe(false)
    writeFileSync(proof.released, '')
    expect(await result).toEqual({ value: { stopReason: 'end_turn' } })
    await peer.whenLive()
    await vi.waitFor(() => expect(peer!.exitCode).toBe(0), { timeout: 5_000 })
  } finally { await cleanup(peer, proof) }
})
