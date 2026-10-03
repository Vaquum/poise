import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

// The preview server needs a runnable Caller; these stand-ins never reach
// GitHub or a model.
const root = resolve('test-results/e2e')
const binRoot = resolve(root, 'caller/bin')
const agentRoot = resolve(root, 'caller/agent_interface')
await rm(root, { recursive: true, force: true })
await Promise.all([
  'chat-attachments',
  'editor',
  'espanso-match',
  'tmp',
].map((directory) => mkdir(resolve(root, directory), { recursive: true })))
await Promise.all([
  mkdir(binRoot, { recursive: true }),
  mkdir(agentRoot, { recursive: true }),
])

await Promise.all([
  'agent-interface',
  'github-datastore',
  'github-interface',
].map(async (command) => {
  const path = resolve(binRoot, command)
  await writeFile(path, '#!/bin/sh\nexit 0\n')
  await chmod(path, 0o700)
}))
