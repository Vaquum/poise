// The legacy chat path is gone from the production server: its routes answer
// the production fallback 404, while the /content and /consensus command
// routes keep their handlers.
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { createAuthenticatedClaudeAuth } from './claude-auth-fixture'

let root = ''
let server: Server
let baseUrl = ''

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-legacy-routes-test-'))
  const staticDir = join(root, 'client')
  await mkdir(join(staticDir, 'assets'), { recursive: true })
  await writeFile(join(staticDir, 'index.html'), '<!doctype html><title>Poise test</title>')
  await writeFile(join(staticDir, 'assets', 'app.js'), 'export {}')
  process.env.POISE_DB = join(root, 'cache.db')
  process.env.POISE_EDITOR_DIR = join(root, 'editor')
  process.env.POISE_ESPANSO_MATCH_DIR = join(root, 'espanso')
  process.env.AGENT_INTERFACE_ROOT = join(root, 'agent')
  process.env.POISE_PRODUCTION_UPDATE_REPORT = join(root, 'production-update.json')
  // Stand-in Caller CLIs: startup only needs them runnable.
  const callerBin = join(root, 'caller-bin')
  await Promise.all([mkdir(callerBin), mkdir(join(root, 'agent'))])
  for (const command of ['agent-interface', 'github-datastore', 'github-interface']) {
    const path = join(callerBin, command)
    await writeFile(path, '#!/bin/sh\nexit 0\n')
    await chmod(path, 0o700)
  }
  vi.stubEnv('CALLER_BIN_ROOT', callerBin)
  vi.resetModules()
  const production = await import('../server/production')
  server = production.createProductionServer({
    staticDir,
    claudeAuth: createAuthenticatedClaudeAuth(),
    reviewAgentUsername: 'bit-mis',
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  const { shutdownProductionServer } = await import('../server/production')
  await shutdownProductionServer(server)
  for (const key of [
    'POISE_DB',
    'POISE_EDITOR_DIR',
    'POISE_ESPANSO_MATCH_DIR',
    'AGENT_INTERFACE_ROOT',
    'POISE_PRODUCTION_UPDATE_REPORT',
  ]) delete process.env[key]
  vi.unstubAllEnvs()
  vi.resetModules()
  await rm(root, { recursive: true, force: true })
})

it('answers 404 in production for every removed route and keeps the command routes', async () => {
  const post = (path: string, body: unknown) => fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  // Removed: no handler matches, so the production fallback answers.
  for (const answer of [
    await fetch(`${baseUrl}/api/chat`),
    await post('/api/chat', {}),
    await post('/api/chat-attachment', {}),
    await fetch(`${baseUrl}/api/editor/doc/draft/chat-session`),
  ]) {
    expect(answer.status).toBe(404)
    expect(((await answer.json()) as { error: string }).error).toBe('API route not found')
  }
  // Kept: the handlers answer. The probes fail before any agent launch: the
  // status route needs a call id, and an unknown chat session is refused
  // before /content launches or /consensus debates.
  const status = await fetch(`${baseUrl}/api/chat-content/status`)
  expect(status.status).toBe(400)
  expect(((await status.json()) as { error: string }).error).toBe('call_id is required')
  for (const answer of [
    await post('/api/chat-content', { chatSession: 'no-such-session' }),
    await post('/api/debate', { chatSession: 'no-such-session' }),
  ]) {
    expect(((await answer.json()) as { error: string }).error).not.toBe('API route not found')
  }
})
