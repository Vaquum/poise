// Every workspace under the installation's default chat root requires the
// `/.poise-chat/` ignore rule — worker workspaces included. Without it, new
// workspaces would show up as untracked files inside Poise's own repository.
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../server/process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/process')>()
  return {
    ...actual,
    runFile: (command: string, args: readonly string[], options?: import('../../server/process').RunFileOptions) => {
      if (command === 'git' && args.includes('check-ignore')) return Promise.reject(new Error('mocked: nothing ignored'))
      return actual.runFile(command, args, options)
    },
  }
})

const { ensureWorkerWorkspace, needsIgnoreCheck, POISE_ROOT } = await import('../../server/chat/local-workspace')
const DEFAULT_ROOT = join(POISE_ROOT, '.poise-chat')

describe('the /.poise-chat/ ignore check', () => {
  it('covers the default root and every workspace under it, nothing else', () => {
    expect(needsIgnoreCheck(DEFAULT_ROOT)).toBe(true)
    expect(needsIgnoreCheck(join(DEFAULT_ROOT, 'workspace'))).toBe(true)
    expect(needsIgnoreCheck(join(DEFAULT_ROOT, 'workers', randomUUID()))).toBe(true)
    expect(needsIgnoreCheck(POISE_ROOT)).toBe(false)
    expect(needsIgnoreCheck(join(POISE_ROOT, '.other'))).toBe(false)
    expect(needsIgnoreCheck(join(POISE_ROOT, '..', '.poise-chat'))).toBe(false)
    expect(needsIgnoreCheck('/tmp/poise-explicit-chat')).toBe(false)
  })

  it('refuses a worker workspace when the checkout does not ignore it', async () => {
    // The check runs before anything is created, so this touches nothing.
    await expect(ensureWorkerWorkspace(DEFAULT_ROOT, randomUUID(), 'test'))
      .rejects.toThrow('Poise must ignore /.poise-chat/ before local Chat storage can be created')
  })
})
