import { buildSync } from 'esbuild'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

let dir: string, cli: string, probe: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'public-pages-cli-')); cli = join(dir, 'cli.mjs')
  probe = join(dir, 'probe.mjs')
  buildSync({ stdin: { contents: "import { loadPublicPages } from './public-pages.ts'; loadPublicPages(process.argv[2]);", resolveDir: fileURLToPath(new URL('../src/', import.meta.url)), sourcefile: 'probe.ts' }, outfile: probe, bundle: true, platform: 'node', format: 'esm', packages: 'external' })
  buildSync({ entryPoints: [fileURLToPath(new URL('../src/public-pages-cli.ts', import.meta.url))], outfile: cli, bundle: true, platform: 'node', format: 'esm', packages: 'external' })
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

it('validates without publishing, installs only explicit content, and does not require source changes for another deployment', () => {
  const input = JSON.stringify({ version: 1, appName: 'Other deployment', contactEmail: 'admin@example.org', description: 'Writing at {{domain}}', privacy: ['Our reviewed notice.'], terms: ['Our reviewed terms.'] })
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('POISE_') && key !== 'PORT'))
  const env = { ...inherited, POISE_DOMAIN: 'notes.example.org', POISE_GITHUB_CLIENT_ID: 'dummy', POISE_GITHUB_CLIENT_SECRET: 'dummy', POISE_ADMINS: 'root', POISE_RUNTIME_IMAGE: 'runtime:current', POISE_GATEWAY_CONTAINER: 'gateway', POISE_GATEWAY_DATA: dir }
  const validate = spawnSync(process.execPath, [cli, 'validate'], { input, encoding: 'utf8', env })
  expect(validate.status).toBe(0)
  expect(validate.stdout).toContain('Public pages are valid.')
  expect(() => readFileSync(join(dir, 'public-pages.json'))).toThrow()
  const install = spawnSync(process.execPath, [cli, 'install'], { input, encoding: 'utf8', env })
  expect(install.status).toBe(0)
  expect(install.stdout).toContain('https://notes.example.org/privacy')
  expect(JSON.parse(readFileSync(join(dir, 'public-pages.json'), 'utf8'))).toEqual(JSON.parse(input))
  const refused = spawnSync(process.execPath, [cli, 'install'], { input: '{"secret":"do-not-disclose"}', encoding: 'utf8', env })
  expect(refused.status).toBe(1)
  expect(refused.stderr).not.toContain('do-not-disclose')
  expect(JSON.parse(readFileSync(join(dir, 'public-pages.json'), 'utf8'))).toEqual(JSON.parse(input))
})

it('rejects FIFO and directory policy entries without blocking startup', () => {
  for (const kind of ['fifo', 'directory']) {
    const data = join(dir, kind), file = join(data, 'public-pages.json')
    mkdirSync(data)
    if (kind === 'fifo') expect(spawnSync('mkfifo', [file]).status).toBe(0)
    else mkdirSync(file)
    const result = spawnSync(process.execPath, [probe, data], { encoding: 'utf8', timeout: 3000 })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Invalid public-pages.json')
  }
})
