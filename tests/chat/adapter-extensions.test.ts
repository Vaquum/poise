// Extensions reach every agent through its own protocol: what each adapter
// sends for the same two servers, against the fakes (which record the
// requests they receive), and what an agent that cannot take one reports.

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClaudeAdapter } from '../../server/chat/adapters/claude'
import { createCodexAdapter } from '../../server/chat/adapters/codex'
import { createGrokAdapter } from '../../server/chat/adapters/grok'
import { createMuseAdapter } from '../../server/chat/adapters/muse'
import type { Adapter } from '../../server/chat/adapters/types'
import type { ResolvedServer } from '../../server/extensions/types'
import { FIXTURES, createFakeHost, type FakeHost } from './adapter-harness'

const SERVERS: ResolvedServer[] = [
  { id: 'a', name: 'probe', title: 'Probe', transport: 'stdio', command: 'node', args: ['probe.mjs'], env: { PROBE_TOKEN: 'local-secret-value' } },
  { id: 'b', name: 'ops', title: 'Ops', transport: 'http', url: 'https://ops.example.test/mcp', headers: { Authorization: 'Bearer remote-secret-value' } },
]
const SSE: ResolvedServer = { id: 'c', name: 'legacy', title: 'Legacy', transport: 'sse', url: 'https://legacy.example.test/sse', headers: {} }

describe('Extensions delivery through the adapters', () => {
  const hosts: FakeHost[] = []
  const adapters: Adapter[] = []
  afterEach(async () => {
    await Promise.all(adapters.splice(0).map((adapter) => adapter.close().catch(() => {})))
    for (const host of hosts.splice(0)) host.dispose()
    delete process.env.FAKE_CLAUDE_STATE_FILE
  })

  function track<T extends Adapter>(host: FakeHost, adapter: T): T {
    hosts.push(host); adapters.push(adapter)
    return adapter
  }
  const recordFile = () => join(mkdtempSync(join(tmpdir(), 'poise-ext-record-')), 'requests.jsonl')
  const requests = (file: string) => existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { method: string, params: any }) : []
  const argv = (host: FakeHost) => host.spawns.flatMap((spawn) => [spawn.command, ...spawn.args]).join(' ')

  it('Claude registers the servers over the SDK control channel, never on the command line', async () => {
    const state = recordFile()
    process.env.FAKE_CLAUDE_STATE_FILE = state
    const host = createFakeHost('fake-claude.mjs')
    const adapter = track(host, createClaudeAdapter(host))
    const started = await adapter.start({ modelId: 'claude-opus-5', effort: 'high', mcpServers: [...SERVERS, SSE] })
    expect(started.mcpSkipped).toBeUndefined()
    const line = readFileSync(state, 'utf8').split('\n').find((entry) => entry.startsWith('mcp_set_servers '))!
    expect(JSON.parse(line.slice('mcp_set_servers '.length))).toEqual({
      probe: { type: 'stdio', command: 'node', args: ['probe.mjs'], env: { PROBE_TOKEN: 'local-secret-value' } },
      ops: { type: 'http', url: 'https://ops.example.test/mcp', headers: { Authorization: 'Bearer remote-secret-value' } },
      legacy: { type: 'sse', url: 'https://legacy.example.test/sse' },
    })
    expect(argv(host)).not.toContain('secret-value')
    expect(argv(host)).not.toContain('--mcp-config')
  })

  it('Claude reports a server its CLI could not connect to', async () => {
    const host = createFakeHost('fake-claude.mjs', ['--mcp-refuse', 'ops'])
    const adapter = track(host, createClaudeAdapter(host))
    const started = await adapter.start({ modelId: 'claude-opus-5', effort: 'high', mcpServers: SERVERS })
    expect(started.mcpSkipped).toEqual([{ name: 'Ops', reason: 'Claude Code could not connect to it (connection refused)' }])
  })

  it('Claude without servers sends no MCP request', async () => {
    const state = recordFile()
    process.env.FAKE_CLAUDE_STATE_FILE = state
    const host = createFakeHost('fake-claude.mjs')
    await track(host, createClaudeAdapter(host)).start({ modelId: 'claude-opus-5', effort: 'high' })
    expect(existsSync(state) ? readFileSync(state, 'utf8') : '').not.toContain('mcp_set_servers')
  })

  it('Codex gets one config override per server on start, resume and fork, and is told about SSE', async () => {
    for (const how of ['start', 'resume', 'fork'] as const) {
      const file = recordFile()
      const host = createFakeHost('fake-codex.mjs', ['--record', file])
      const adapter = track(host, createCodexAdapter(host))
      const started = await adapter.start({ modelId: 'gpt-6-astra', effort: 'high', mcpServers: [...SERVERS, SSE], ...(how === 'resume' ? { resume: 'thread-1' } : how === 'fork' ? { forkFrom: 'thread-1' } : {}) })
      const method = how === 'start' ? 'thread/start' : how === 'resume' ? 'thread/resume' : 'thread/fork'
      expect(requests(file).find((request) => request.method === method)?.params.config, method).toEqual({
        'mcp_servers.probe': { command: 'node', args: ['probe.mjs'], env: { PROBE_TOKEN: 'local-secret-value' }, startup_timeout_sec: 60 },
        'mcp_servers.ops': { url: 'https://ops.example.test/mcp', http_headers: { Authorization: 'Bearer remote-secret-value' } },
      })
      expect(started.mcpSkipped).toEqual([{ name: 'Legacy', reason: 'Codex takes local commands and Streamable HTTP servers, not SSE' }])
      expect(argv(host)).not.toContain('secret-value')
    }
  })

  it('Codex without servers starts plain', async () => {
    const file = recordFile()
    const host = createFakeHost('fake-codex.mjs', ['--record', file])
    await track(host, createCodexAdapter(host)).start({ modelId: 'gpt-6-astra', effort: 'high' })
    expect(requests(file).find((request) => request.method === 'thread/start')?.params).not.toHaveProperty('config')
  })

  it('Grok passes ACP mcpServers on session/new, as its initialize advertises', async () => {
    const file = recordFile()
    const host = createFakeHost('fake-grok.mjs', ['--replay', join(FIXTURES, 'grok-permission.trace.json'), '--record', file])
    const started = await track(host, createGrokAdapter(host)).start({ modelId: 'grok-4.6', effort: 'high', mcpServers: [...SERVERS, SSE] })
    expect(requests(file).find((request) => request.method === 'session/new')?.params.mcpServers).toEqual([
      { name: 'probe', command: 'node', args: ['probe.mjs'], env: [{ name: 'PROBE_TOKEN', value: 'local-secret-value' }] },
      { type: 'http', name: 'ops', url: 'https://ops.example.test/mcp', headers: [{ name: 'Authorization', value: 'Bearer remote-secret-value' }] },
      { type: 'sse', name: 'legacy', url: 'https://legacy.example.test/sse', headers: [] },
    ])
    expect(started.mcpSkipped).toBeUndefined()
  })

  it('Grok resumes with the servers', async () => {
    const file = recordFile()
    const host = createFakeHost('fake-grok.mjs', ['--replay', join(FIXTURES, 'grok-session-resume.trace.json'), '--record', file])
    const trace = JSON.parse(readFileSync(join(FIXTURES, 'grok-session-resume.trace.json'), 'utf8')) as Array<{ dir: string, msg: any }>
    const resume = trace.find((entry) => entry.dir === 'out' && entry.msg.method === 'session/resume')!.msg.params.sessionId as string
    await track(host, createGrokAdapter(host)).start({ modelId: 'grok-4.6', effort: 'high', resume, mcpServers: SERVERS })
    expect(requests(file).find((request) => request.method === 'session/resume')?.params.mcpServers).toHaveLength(2)
  })

  it('Muse asks for session MCP and passes config.mcpServers on start and resume', async () => {
    for (const how of ['start', 'resume'] as const) {
      const file = recordFile()
      const host = createFakeHost('fake-muse.mjs', ['--record', file])
      const started = await track(host, createMuseAdapter(host)).start({ modelId: 'muse-spark-1.3-contributor', effort: 'low', mcpServers: [...SERVERS, SSE], ...(how === 'resume' ? { resume: 'session-1' } : {}) })
      const sent = requests(file)
      expect(sent.find((request) => request.method === 'initialize')?.params.capabilities.requestedCapabilities).toEqual(['sessionMcp'])
      expect(sent.find((request) => request.method === `session/${how}`)?.params.config).toEqual({ mcpServers: {
        probe: { transport: 'stdio', command: 'node', args: ['probe.mjs'], env: { PROBE_TOKEN: 'local-secret-value' } },
        ops: { transport: 'streamableHttp', url: 'https://ops.example.test/mcp', headers: { Authorization: 'Bearer remote-secret-value' } },
      } })
      expect(started.mcpSkipped).toEqual([{ name: 'Legacy', reason: 'Muse takes local commands and Streamable HTTP servers, not SSE' }])
      expect(started.mcpPending).toBeUndefined()
    }
  })

  it('Muse reports the servers instead of dropping them when it does not grant session MCP', async () => {
    const file = recordFile()
    const host = createFakeHost('fake-muse.mjs', ['--record', file, '--no-session-mcp'])
    const started = await track(host, createMuseAdapter(host)).start({ modelId: 'muse-spark-1.3-contributor', effort: 'low', mcpServers: SERVERS })
    expect(requests(file).find((request) => request.method === 'session/start')?.params).not.toHaveProperty('config')
    expect(started.mcpSkipped).toEqual([
      { name: 'Probe', reason: 'this Muse did not grant session MCP servers' },
      { name: 'Ops', reason: 'this Muse did not grant session MCP servers' },
    ])
  })

  it('a Muse fork, which takes no configuration, asks the runtime to resume it with the servers', async () => {
    const host = createFakeHost('fake-muse.mjs')
    const started = await track(host, createMuseAdapter(host)).start({ modelId: 'muse-spark-1.3-contributor', effort: 'low', forkFrom: 'session-1', mcpServers: SERVERS })
    expect(started.mcpPending).toBe(true)
  })
})
