import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { gatewayKeys, serviceEnvironment } from './service-fixture'

let root = '', compiled = '', bundle = ''
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'poise-cpu-startup-'))
  const cache = resolve('node_modules/.cache/poise')
  mkdirSync(cache, { recursive: true })
  compiled = mkdtempSync(join(cache, 'cpu-startup-'))
  bundle = join(compiled, 'server.mjs')
  await build({ entryPoints: ['server/production.ts'], outfile: bundle, bundle: true,
    platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent',
    define: { __POISE_BUILD_SHA__: JSON.stringify('b'.repeat(40)) },
    plugins: [{ name: 'owned-startup-boundary', setup(builder) {
      // Exercise the real entrypoint and secure dotenv loader. Stop exactly
      // at startLogging, before the runtime or any agent CLI can be started.
      builder.onResolve({ filter: /^\.\/(logging|runtime-config)$/ }, args => {
        if (args.importer === resolve('server/production.ts')) return { path: args.path, namespace: 'startup-fixture' }
      })
      builder.onLoad({ filter: /.*/, namespace: 'startup-fixture' }, args => ({
        resolveDir: process.cwd(), loader: 'ts', contents: args.path === './logging' ? `
export function startLogging() {
  console.log(JSON.stringify({ phase: 'configured', handlers: process.listenerCount('SIGUSR2'), mode: process.env.POISE_MODE ?? null }))
  throw new Error('owned fixture stops before runtime')
}` : `
import { loadSecureDotenv as load } from ${JSON.stringify(resolve('server/runtime-config.ts'))}
export { assertSecureDotenv, validateConfabUrl } from ${JSON.stringify(resolve('server/runtime-config.ts'))}
export async function loadSecureDotenv() {
  console.log(JSON.stringify({ phase: 'before-dotenv', handlers: process.listenerCount('SIGUSR2') }))
  await load()
}`,
      }))
    } }],
  })
}, 60_000)
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  if (compiled) rmSync(compiled, { recursive: true, force: true })
})

it.each(['environment', 'dotenv', 'local', 'import'] as const)('arms only a direct configured service process (%s)', async (mode) => {
  const home = mkdtempSync(join(root, 'home-'))
  const config = serviceEnvironment(gatewayKeys())
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, POISE_ENV_ROOT: home, NODE_OPTIONS: '' }
  for (const key of Object.keys(config)) delete env[key]
  if (mode === 'environment') Object.assign(env, config)
  else if (mode === 'dotenv' || mode === 'import') {
    writeFileSync(join(home, '.env'), Object.entries(config).map(([key, value]) => `${key}=${value}`).join('\n'), { mode: 0o600 })
  }
  const child = spawn(process.execPath, mode === 'import'
    ? ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(bundle).href)})`]
    : [bundle], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', (data: Buffer) => { stdout += data.toString() })
  child.stderr.on('data', (data: Buffer) => { stderr += data.toString() })
  const result = await new Promise<{ code: number | null, signal: NodeJS.Signals | null }>((accept, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => accept({ code, signal }))
  })
  expect(result).toEqual({ code: 1, signal: null })
  expect(stderr).toContain('owned fixture stops before runtime')
  const snapshots = stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))
  expect(snapshots).toEqual([
    { phase: 'before-dotenv', handlers: mode === 'environment' ? 1 : 0 },
    { phase: 'configured', handlers: mode === 'environment' || mode === 'dotenv' ? 1 : 0, mode: mode === 'local' ? null : 'service' },
  ])
  expect((stderr.match(/CPU capture availability/g) ?? []).length).toBe(mode === 'environment' || mode === 'dotenv' ? 1 : 0)
})
