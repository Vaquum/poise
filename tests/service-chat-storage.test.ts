// In service mode Poise runs from an image, not from a git checkout of
// itself: Chat storage lives in the home volume and must not need the
// installation's checkout to ignore it.

import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { gatewayKeys, serviceEnvironment } from './service-fixture'

const commands = vi.hoisted(() => [] as string[][])
vi.mock('../server/process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/process')>()
  return {
    ...actual,
    runFile: (command: string, args: readonly string[], options?: import('../server/process').RunFileOptions) => {
      commands.push([command, ...args])
      return actual.runFile(command, args, options)
    },
  }
})

let root = ''
let home = ''

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-service-chat-'))
  home = join(root, 'home')
  await mkdir(join(home, '.poise'), { recursive: true })
  for (const [key, value] of Object.entries({ ...serviceEnvironment(gatewayKeys()), HOME: home, POISE_DB: join(root, 'cache.db'), POISE_LOCK_DIR: join(root, 'locks') })) {
    vi.stubEnv(key, value)
  }
  vi.stubEnv('POISE_CHAT_ROOT', undefined)
  vi.resetModules()
})

afterAll(async () => {
  ;(await import('../server/db')).closeDatabase()
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

it('creates Chat storage under ~/.poise/chat without consulting a Poise checkout', async () => {
  const { LOCAL_CHAT_ROOT, POISE_ROOT, ensureLocalWorkspace } = await import('../server/chat/local-workspace')
  expect(LOCAL_CHAT_ROOT).toBe(join(home, '.poise', 'chat'))
  const checkout = await ensureLocalWorkspace()
  expect(checkout).toBe(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: join(home, '.poise', 'chat', 'workspace'), encoding: 'utf8' }).trim())
  expect(await readFile(join(checkout, '.poise-workspace-owner'), 'utf8')).toBe('Poise local Chat workspace v1\n')
  expect(commands.some((command) => command.includes('check-ignore'))).toBe(false)
  expect(commands.every((command) => !command.includes(POISE_ROOT))).toBe(true)
})

it('keeps an explicit POISE_CHAT_ROOT', async () => {
  vi.stubEnv('POISE_CHAT_ROOT', join(root, 'explicit-chat'))
  vi.resetModules()
  expect((await import('../server/chat/local-workspace')).LOCAL_CHAT_ROOT).toBe(join(root, 'explicit-chat'))
})
