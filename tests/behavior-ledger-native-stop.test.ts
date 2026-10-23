import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

const execute = promisify(execFile)

it('keeps a real SQLite capture alive past the stop budget and closes with durable loss accounting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ledger-native-stop-'))
  const sqliteModule = createRequire(import.meta.url).resolve('better-sqlite3')
  const observerBundle = join(root, 'observer.cjs')
  const workerBundle = join(root, 'worker.cjs')
  try {
    await Promise.all([
      build({ entryPoints: ['server/behavior-ledger.ts'], outfile: observerBundle, bundle: true,
        platform: 'node', format: 'cjs', packages: 'external', alias: { 'better-sqlite3': sqliteModule }, external: [sqliteModule], logLevel: 'silent' }),
      build({ entryPoints: ['server/behavior-ledger-worker.ts'], outfile: workerBundle, bundle: true,
        platform: 'node', format: 'cjs', packages: 'external', alias: { 'better-sqlite3': sqliteModule }, external: [sqliteModule], logLevel: 'silent' }),
    ])
    // The child contains a native abort on the old shutdown path, so failure
    // becomes this assertion instead of killing the Vitest process itself.
    const result = await execute(process.execPath, [resolve('tests/fixtures/behavior-ledger-native-stop.mjs'),
      JSON.stringify({ root, observerBundle, workerBundle, sqliteModule })], { timeout: 15_000, maxBuffer: 1024 * 1024 })
    expect(JSON.parse(result.stdout)).toMatchObject({ naturalExit: true, trackedUntilExit: true, dropped: 2 })
    expect(result.stderr).toBe('')
  } finally { await rm(root, { recursive: true, force: true }) }
}, 20_000)
