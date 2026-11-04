// Initializing a chat's private workspace runs six git commands, each under
// its own real worker gate, and most chat tests create chats that never look
// at how their workspace came to be. Imported first by the test files that
// create many: only the file's first worker workspace is initialized for real,
// and later ones start as a copy of it and still pass the real readiness check.
// One recreated under a held lease is always initialized for real.
//
// A setup file could not do this for every test: vi.resetModules does not reset
// a mock's factory, so a test re-importing this module would get a stale one.
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, vi } from 'vitest'

let template: string | undefined

vi.mock('../../server/chat/local-workspace', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/chat/local-workspace')>()
  const ensureWorkerWorkspace: typeof actual.ensureWorkerWorkspace = async (root, id, instance, heldLease) => {
    const checkout = await actual.ensureWorkerWorkspaceDirectory(root, id)
    if (template && !heldLease && readdirSync(checkout).length === 0) cpSync(template, checkout, { recursive: true })
    const ready = await actual.ensureWorkerWorkspace(root, id, instance, heldLease)
    if (!template && !heldLease) {
      template = mkdtempSync(join(tmpdir(), 'poise-workspace-template-'))
      cpSync(ready, template, { recursive: true })
    }
    return ready
  }
  return { ...actual, ensureWorkerWorkspace }
})

afterAll(() => { if (template) rmSync(template, { recursive: true, force: true }) })
