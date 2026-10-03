// The suite never reaches a real Caller. After `npm run caller:setup`,
// caller/.venv holds working CLIs and Poise resolves bare Caller commands
// there, so every test file starts with an empty CLI directory instead; a
// test that needs Caller CLIs points CALLER_BIN_ROOT at its own fakes.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'

const root = mkdtempSync(join(tmpdir(), 'poise-caller-isolation-'))
process.env.CALLER_BIN_ROOT = root
afterAll(() => { rmSync(root, { recursive: true, force: true }) })
