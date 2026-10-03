// Every test file runs with a home folder and agent-CLI configuration of its
// own, and with stand-ins first on PATH for the agent CLIs
// (fixtures/cli-isolation.ts): nothing a test starts can reach the
// developer's CLIs, their logins or their settings. A test that needs a CLI
// puts its fakes (fixtures/accounts/fake-clis.ts) ahead of the stand-ins.
//
// The variables are set on process.env itself, not stubbed, so a test that
// restores its own stubs comes back to these values, never the real ones.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'
import { isolatedEnvironment } from './fixtures/cli-isolation'

// The PATH this process started with, so a process that runs several test
// files does not stack their stand-ins.
process.env.POISE_TEST_BASE_PATH ??= process.env.PATH ?? ''
const root = mkdtempSync(join(tmpdir(), 'poise-home-isolation-'))
Object.assign(process.env, isolatedEnvironment(root, process.env.POISE_TEST_BASE_PATH))
afterAll(() => { rmSync(root, { recursive: true, force: true }) })
