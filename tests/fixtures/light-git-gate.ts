// The worker gate is a node process, which around a mutating git command costs
// far more than the command. In test files that do not test the gate, a shell
// takes its place for git alone and keeps its protocol: nothing runs before `GO`
// on the control descriptor, and losing the descriptor ends it. Agents and all
// other commands keep the real gate, and tests/chat/local-workspace.test.ts and
// tests/chat/git-abort.test.ts keep it for git.
import { vi } from 'vitest'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const spawn = ((file: string, args: string[], options: object) => (args?.[0]?.endsWith('/chat-worker-gate.mjs') && args[4] === 'git'
    ? actual.spawn('/bin/sh', ['-c', 'IFS= read -r go <&3 && [ "$go" = GO ] && exec "$@" 3<&-', 'gate', ...args.slice(4)], options)
    : actual.spawn(file, args, options))) as typeof actual.spawn
  return { ...actual, spawn }
})
