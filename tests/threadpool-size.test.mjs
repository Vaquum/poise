import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'

// libuv sizes its file-system thread pool once, when the pool first starts:
// the launchers set the size before anything they import can start it.
const size = (env) => execFileSync(process.execPath, ['--input-type=module', '-e',
  "await import('./scripts/self-update/threadpool.mjs'); process.stdout.write(String(process.env.UV_THREADPOOL_SIZE))"],
{ env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' })

it('gives the server sixteen file-system threads unless its process was started with a size', () => {
  expect(size({})).toBe('16')
  expect(size({ UV_THREADPOOL_SIZE: '6' })).toBe('6')
})

it('is the first import of both in-process launchers', async () => {
  for (const [file, specifier] of [['scripts/self-update/launch.mjs', './threadpool.mjs'], ['scripts/start-production.mjs', './self-update/threadpool.mjs']]) {
    const source = await readFile(file, 'utf8')
    expect(source.match(/^import .*$/m)?.[0]).toBe(`import '${specifier}'`)
  }
})
