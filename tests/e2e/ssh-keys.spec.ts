import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { build } from 'esbuild'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeFakeClis } from '../fixtures/accounts/fake-clis'
import { cliHomes } from '../fixtures/cli-isolation'
import { CATALOG } from '../model-catalog-fixture'

// Settings → Connected accounts → SSH keys against the production server and
// its real terminal: a seeded ~/.ssh lists, and Add an SSH key imports a
// pasted private key through the terminal alone.

async function start(page: Page, info: TestInfo) {
  const root = info.outputPath('runtime')
  const bin = join(root, 'bin')
  const home = join(root, 'home')
  await mkdir(join(root, 'agent'), { recursive: true })
  // No agent CLIs: the SSH section is independent of them.
  await writeFakeClis(bin, home, {})
  await writeFile(join(bin, 'caller.cjs'), `process.stdout.write(process.argv.includes('--models') ? ${JSON.stringify(JSON.stringify(CATALOG))} : '[]')`)
  for (const command of ['agent-interface', 'github-interface', 'github-datastore']) {
    await writeFile(join(bin, command), '#!/bin/sh\nexec node "${0%/*}/caller.cjs" "$@"\n')
    await chmod(join(bin, command), 0o755)
  }
  // ssh-keygen is a local file utility, not a credentialed CLI: the fixture
  // links the runner's own, so the import derives a true public key.
  const keygen = execFileSync('sh', ['-c', 'command -v ssh-keygen'], { encoding: 'utf8' }).trim()
  if (!keygen) throw new Error('ssh-keygen is missing from the test runner PATH')
  await writeFile(join(bin, 'ssh-keygen'), `#!/bin/sh\nexec '${keygen}' "$@"\n`)
  await chmod(join(bin, 'ssh-keygen'), 0o755)
  // A seeded key pair the listing must report, and a private body line the
  // API must never return.
  execFileSync(keygen, ['-t', 'ed25519', '-N', '', '-C', 'poise-ssh-seed', '-f', join(root, 'seed')], { stdio: 'pipe' })
  await mkdir(join(home, '.ssh'), { recursive: true })
  const privateSeed = await readFile(join(root, 'seed'), 'utf8')
  await writeFile(join(home, '.ssh', 'id_seed'), privateSeed, { mode: 0o600 })
  await writeFile(join(home, '.ssh', 'id_seed.pub'), await readFile(join(root, 'seed.pub'), 'utf8'))
  const seedFingerprint = execFileSync(keygen, ['-lf', join(home, '.ssh', 'id_seed.pub')], { encoding: 'utf8' }).split(/\s+/)[1]
  execFileSync(keygen, ['-t', 'ed25519', '-N', '', '-C', 'poise-ssh-paste', '-f', join(root, 'paste')], { stdio: 'pipe' })
  const pastedPrivate = await readFile(join(root, 'paste'), 'utf8')
  const bundle = join(root, 'ssh-server.mjs')
  await build({
    entryPoints: ['tests/fixtures/accounts/accounts-server.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'esm', packages: 'external',
    define: { 'import.meta.url': JSON.stringify(pathToFileURL(resolve('server/process.ts')).href) },
    logLevel: 'silent',
  })
  const child = spawn(process.execPath, [bundle], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...cliHomes(join(root, 'homes')), HOME: home, PATH: bin, LANG: 'en_US.UTF-8', FAKE_CLI_BIN: bin, CALLER_BIN_ROOT: bin, AGENT_INTERFACE_ROOT: join(root, 'agent') },
  })
  let stderr = ''
  child.stderr!.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-4096) })
  const port = await new Promise<number>((done, reject) => {
    const timer = setTimeout(() => reject(new Error(`fixture startup deadline: ${stderr}`)), 30_000)
    let output = ''
    child.stdout!.on('data', (chunk) => {
      output += String(chunk)
      for (const line of output.split('\n')) {
        try { const value = JSON.parse(line); if (value.port) { clearTimeout(timer); done(value.port) } } catch { /* not the ready line */ }
      }
    })
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`fixture exited ${code}: ${stderr}`)) })
  })
  await page.addInitScript(() => { localStorage.clear(); localStorage.setItem('poise-view', 'main') })
  await page.route(/https:\/\/(?:rsms\.me|fonts\.googleapis\.com|fonts\.gstatic\.com)\//, (route) => route.abort())
  return { origin: `http://127.0.0.1:${port}`, child, home, seedFingerprint, pastedPrivate, privateBody: privateSeed.split('\n')[1] }
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((done) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
    child.once('exit', () => { clearTimeout(timer); done() })
    child.kill('SIGTERM')
  })
}

test('lists ~/.ssh and imports a pasted key through the terminal', async ({ page }, info) => {
  test.setTimeout(120_000)
  const fixture = await start(page, info)
  try {
    await expect.poll(async () => (await page.request.get(`${fixture.origin}/api/ssh-keys`)).ok(), { timeout: 30_000 }).toBe(true)
    await page.goto(`${fixture.origin}/?settings=accounts`)
    await expect(page.locator('#settings-panel')).toHaveClass(/open/)
    const section = page.locator('.st-ssh-keys')
    const row = section.locator('[data-ssh-key="id_seed"]')
    await expect(row.locator('.st-account-state')).toHaveText(fixture.seedFingerprint, { timeout: 20_000 })
    // Private material never crosses the API.
    expect(await (await page.request.get(`${fixture.origin}/api/ssh-keys`)).text()).not.toContain(fixture.privateBody)

    await section.getByRole('button', { name: 'Add an SSH key' }).click()
    const terminal = page.locator('.st-terminal[data-preset="ssh-key"]')
    await expect(terminal.locator('.st-terminal-title')).toHaveText('Add an SSH key')
    await expect(terminal.locator('.xterm-rows')).toContainText('Key name')
    // The terminal has the focus from opening, as with every Connect login.
    await page.keyboard.type('id_imported')
    await page.keyboard.press('Enter')
    await expect(terminal.locator('.xterm-rows')).toContainText('Paste the private key')
    // Echo is off for the paste: nothing of the key shows on screen.
    await page.keyboard.type(fixture.pastedPrivate)
    expect(await terminal.locator('.xterm-rows').innerText()).not.toContain(fixture.pastedPrivate.split('\n')[1])
    await page.keyboard.press('Control+d')
    await expect(terminal.locator('.xterm-rows')).toContainText('Saved ~/.ssh/id_imported (0600) and ~/.ssh/id_imported.pub.')
    await expect(terminal.locator('.st-terminal-status')).toHaveText('Exited with code 0.')
    const imported = section.locator('[data-ssh-key="id_imported"]')
    await expect(imported.locator('.st-account-state')).toHaveText(/^SHA256:/, { timeout: 20_000 })
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => { document.documentElement.dataset.theme = value }, theme)
      await section.screenshot({ path: info.outputPath(`ssh-keys-${theme}.png`), animations: 'disabled' })
    }
    await terminal.getByRole('button', { name: 'Close' }).click()
    await expect(terminal).toHaveCount(0)
  } finally {
    await stop(fixture.child)
  }
})
