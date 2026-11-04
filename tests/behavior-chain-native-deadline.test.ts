// Actual subprocess deadline regression with an isolated transport stand-in.
// This executes no provider, GitHub command or behavior workflow.
import { existsSync, writeFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { nativeChainOperations } from '../server/behavior-chain-native'
import type { BehaviorChain, ChainInvocation } from '../server/behavior-chain-store'
import type { Organization } from '../server/organizations'

let root = ''
afterEach(async () => { vi.useRealTimers(); vi.unstubAllEnvs(); if (root) await rm(root, { recursive: true, force: true }) })

it('lets the physical Call return after 30 seconds of work plus wrapper overhead', async () => {
  root = await mkdtemp(join(tmpdir(), 'native-action-deadline-'))
  const bin = join(root, 'bin')
  await mkdir(bin)
  const started = join(root, 'started')
  const finish = join(root, 'finish')
  const result = { action: 'merge_if_ready', repository: 'example/repo', pull_number: 21,
    head_sha: 'a'.repeat(40), outcome: 'not_ready' }
  // The real process answers only after this process's clock has passed the
  // 31 seconds, so any shorter deadline has already killed it by then.
  await writeFile(join(bin, 'agent-interface'), `#!${process.execPath}\nconst fs = require('node:fs');\nif (process.argv[2] !== '--native-action') process.exit(2);\nfs.writeFileSync(${JSON.stringify(started)}, '');\nconst wait = setInterval(() => { if (!fs.existsSync(${JSON.stringify(finish)})) return; clearInterval(wait); process.stdout.write(${JSON.stringify(JSON.stringify({ id: 'b'.repeat(32), result }) + '\n')}); }, 5);\n`, { mode: 0o700 })
  vi.stubEnv('CALLER_BIN_ROOT', bin)
  const chain: BehaviorChain = { id: 'example/repo#7', repository: 'example/repo', issue: 7, branch: 'poise/issue-7',
    author: 'author', reviewer: 'reviewer', sequence: 1, held: null, waiting: null, resumedAfterSequence: 0,
    mergeSha: null, observation: null, invocations: [] }
  const invocation: ChainInvocation = { id: 'original-direct', behavior: 'merge-pr', basis: 'original-request', actor: 'reviewer',
    model: null, slot: null, admittedAt: Date.now(), admissionSequence: 2, state: 'started', callId: null, outcome: null, evidence: null,
    request: { command: 'github-interface', nativeResources: 2, cwd: '/logical/example/repo',
      argv: ['--merge-if-ready', '21', '--expected-head', 'a'.repeat(40), '--token-user', 'reviewer'] } }
  const forbidden = async (): Promise<never> => { throw new Error('transport test must not run another operation') }
  const operations = nativeChainOperations({ login: 'example', datastorePath: '/unused' } as Organization, {
    roster: forbidden, resolve: forbidden, prepare: forbidden, borrow: () => null, available: () => false, capacity: () => 1,
    permitted: () => false, note: () => '', severity: () => 'p2', received: () => {}, reviews: forbidden, existing: forbidden, wake: () => {},
  })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  const begun = Date.now()
  const performed = operations.perform(invocation, chain)
  while (!existsSync(started)) await new Promise(resolve => setImmediate(resolve))
  await vi.advanceTimersByTimeAsync(31_000)
  writeFileSync(finish, '')
  await expect(performed).resolves.toEqual({ ...result, nativeCallId: 'b'.repeat(32) })
  expect(Date.now() - begun).toBeGreaterThanOrEqual(31_000)
}, 60_000)
