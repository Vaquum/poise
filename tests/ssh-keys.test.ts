// SSH keys: the public inventory of ~/.ssh (server/ssh-keys.ts), the import
// terminal's helper (server/terminal/ssh-key-helper.ts) and the Settings
// section (src/views/ssh-keys.ts). Private key files are stated, never
// opened: no private material may appear in any answer.

import { execFileSync, spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { symlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setMeta } from '../server/db'
import { accountLogins, recordLogin } from '../server/accounts/logins'
import { listSshKeys, sshDir, sshFingerprint, type SshKey } from '../server/ssh-keys'
import { presetCommand } from '../server/terminal/presets'
import { SSH_KEY_HELPER } from '../server/terminal/ssh-key-helper'
import { TERMINAL_PRESETS, isTerminalPreset } from '../server/terminal/protocol'
import { sshKeysHtml } from '../src/views/ssh-keys'
import { resolveOnPath, writeFakeClis } from './fixtures/accounts/fake-clis'

// A real ed25519 public key (fictional test identity) and its fingerprint as
// ssh-keygen -lf prints it. Only public halves ever appear in this file.
const PUB = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHbWqoz+yPX2gX5/Dc57PIMiLDI8gZsVpUrQKDyhldQ/ poise-test'
const FINGERPRINT = 'SHA256:OW4n1oso6SdnyvT8ggbq/gLN9FINX2S1nTKFnQTWOrE'
// Stands in for private files the listing must stat but never open.
const PRIVATE_MARKER = 'PRIVATE-MATERIAL-MUST-NEVER-LEAVE-ITS-FILE-7f3a9c'

let root = ''
let bin = ''
let home = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-ssh-keys-'))
  bin = join(root, 'bin')
  home = join(root, 'home')
  // No agent CLIs: bin holds node and python3 only, like every fixture PATH.
  await writeFakeClis(bin, home, {})
  vi.stubEnv('PATH', bin)
  vi.stubEnv('HOME', home)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

async function seed(files: Record<string, string>, modes: Record<string, number> = {}): Promise<string> {
  const dir = join(home, '.ssh')
  await mkdir(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name)
    await writeFile(path, content)
    await chmod(path, modes[name] ?? 0o600)
  }
  return dir
}

describe('sshFingerprint', () => {
  it('matches ssh-keygen for a public key', () => {
    expect(sshFingerprint(PUB)).toBe(FINGERPRINT)
    expect(sshFingerprint(`  ${PUB}\n`)).toBe(FINGERPRINT)
  })

  it('accepts every public key type prefix', () => {
    const type = 'ecdsa-sha2-nistp256'
    const blob = Buffer.concat([Buffer.from([0, 0, 0, type.length]), Buffer.from(type, 'ascii'), Buffer.from(' Farbeyondtherest')])
    expect(sshFingerprint(`${type} ${blob.toString('base64')}`)).toMatch(/^SHA256:[A-Za-z0-9+/]+$/)
  })

  it('accepts FIDO security-key types', () => {
    for (const type of ['sk-ssh-ed25519@openssh.com', 'sk-ecdsa-sha2-nistp256@openssh.com']) {
      const blob = Buffer.concat([Buffer.from([0, 0, 0, type.length]), Buffer.from(type, 'ascii'), Buffer.from('fake-security-key-payload')])
      expect(sshFingerprint(`${type} ${blob.toString('base64')} security-key`)).toMatch(/^SHA256:[A-Za-z0-9+/]+$/)
    }
  })

  it('rejects what holds no public key', () => {
    expect(sshFingerprint('')).toBeNull()
    expect(sshFingerprint('not a key')).toBeNull()
    expect(sshFingerprint('ssh-ed25519')).toBeNull()
    expect(sshFingerprint('ssh-ed25519 !!!not-base64!!!')).toBeNull()
    // Valid base64, but no key on the wire.
    expect(sshFingerprint('ssh-ed25519 eA==')).toBeNull()
    // A blob of another type wearing this line's type.
    const impostor = Buffer.concat([Buffer.from([0, 0, 0, 3]), Buffer.from('foo', 'ascii')]).toString('base64')
    expect(sshFingerprint(`ssh-ed25519 ${impostor}`)).toBeNull()
    expect(sshFingerprint(`ssh-ed25519 ${'A'.repeat(5000)}`)).toBeNull()
  })
})

describe('listSshKeys', () => {
  it('answers empty when ~/.ssh is missing or empty', () => {
    expect(listSshKeys(join(home, '.ssh'))).toEqual([])
  })

  it('answers empty for an empty ~/.ssh', async () => {
    expect(listSshKeys(await seed({}))).toEqual([])
  })

  it('reports a key pair without opening the private file', async () => {
    const dir = await seed({ id_test: PRIVATE_MARKER, 'id_test.pub': `${PUB}\n` })
    const keys = listSshKeys(dir)
    expect(keys).toEqual([{
      name: 'id_test', hasPrivateKey: true, privateMode: '0600', privateBytes: PRIVATE_MARKER.length,
      publicKey: PUB, publicKeyInvalid: false, fingerprint: FINGERPRINT,
    } satisfies SshKey])
    expect(JSON.stringify(keys)).not.toContain('PRIVATE-MATERIAL')
  })

  it('reports a private key without a public key', async () => {
    const dir = await seed({ id_lonely: PRIVATE_MARKER })
    expect(listSshKeys(dir)).toEqual([{
      name: 'id_lonely', hasPrivateKey: true, privateMode: '0600', privateBytes: PRIVATE_MARKER.length,
      publicKey: null, publicKeyInvalid: false, fingerprint: null,
    }])
  })

  it('marks an unreadable public key', async () => {
    const dir = await seed({ id_bad: PRIVATE_MARKER, 'id_bad.pub': 'garbage, not a key\n' })
    expect(listSshKeys(dir)).toEqual([expect.objectContaining({
      name: 'id_bad', hasPrivateKey: true, publicKey: null, publicKeyInvalid: true, fingerprint: null,
    })])
  })

  it('marks a public key without a private file', async () => {
    const dir = await seed({ 'orphan.pub': `${PUB}\n` })
    expect(listSshKeys(dir)).toEqual([{
      name: 'orphan', hasPrivateKey: false, privateMode: null, privateBytes: null,
      publicKey: PUB, publicKeyInvalid: false, fingerprint: FINGERPRINT,
    }])
  })

  it('fingerprints a security-key public key', async () => {
    const type = 'sk-ssh-ed25519@openssh.com'
    const blob = Buffer.concat([Buffer.from([0, 0, 0, type.length]), Buffer.from(type, 'ascii'), Buffer.from('fake-security-key-payload')])
    const line = `${type} ${blob.toString('base64')}`
    const dir = await seed({ id_sk: PRIVATE_MARKER, 'id_sk.pub': `${line}\n` })
    expect(listSshKeys(dir)).toEqual([expect.objectContaining({
      name: 'id_sk', publicKey: line, publicKeyInvalid: false, fingerprint: sshFingerprint(line),
    })])
    expect(sshFingerprint(line)).toMatch(/^SHA256:/)
  })

  it('skips configuration, hidden files, directories and links', async () => {
    const dir = await seed({
      id_real: PRIVATE_MARKER,
      config: 'Host *\n', known_hosts: 'example.test ssh-ed25519 AAAA\n', 'known_hosts.old': '',
      authorized_keys: PUB, environment: '', rc: '', '.dotfile': 'x', 'config.pub': `${PUB}\n`,
    })
    await mkdir(join(dir, 'subdir'), { recursive: true })
    await writeFile(join(dir, 'subdir', 'key'), PRIVATE_MARKER)
    symlinkSync(join(dir, 'id_real'), join(dir, 'key-link'))
    symlinkSync(join(dir, 'nowhere'), join(dir, 'dangling-link'))
    expect(listSshKeys(dir).map((key) => key.name)).toEqual(['id_real'])
  })

  it('reports permissions as found and sorts by name', async () => {
    const dir = await seed({ b_key: PRIVATE_MARKER, a_key: PRIVATE_MARKER }, { b_key: 0o644 })
    expect(listSshKeys(dir).map((key) => [key.name, key.privateMode])).toEqual([['a_key', '0600'], ['b_key', '0644']])
  })

  it('ignores blank lines around a public key', async () => {
    const dir = await seed({ id_gap: PRIVATE_MARKER, 'id_gap.pub': `\n\n${PUB}\n` })
    expect(listSshKeys(dir)).toEqual([expect.objectContaining({ publicKey: PUB, fingerprint: FINGERPRINT })])
  })

  it('reads the default ~/.ssh under the stubbed home', async () => {
    await seed({ id_home: PRIVATE_MARKER, 'id_home.pub': `${PUB}\n` })
    expect(sshDir()).toBe(join(home, '.ssh'))
    expect(listSshKeys().map((key) => key.name)).toEqual(['id_home'])
  })

  it('fails loud when ~/.ssh is not a directory', async () => {
    await writeFile(join(home, '.ssh'), 'in the way')
    expect(() => listSshKeys(join(home, '.ssh'))).toThrow(/Could not read .*\.ssh/)
  })
})

describe('the ssh-key terminal preset', () => {
  it('is a known preset running the import helper on python3', () => {
    expect(TERMINAL_PRESETS).toContain('ssh-key')
    expect(isTerminalPreset('ssh-key')).toBe(true)
    expect(isTerminalPreset('ssh')).toBe(false)
    const command = presetCommand('ssh-key')
    expect(command.command).toBe('python3')
    expect(command.args.slice(0, 2)).toEqual(['-I', '-c'])
    expect(command.args[2]).toBe(SSH_KEY_HELPER)
    expect(command.args[2]).toContain('ssh-keygen')
    expect(command.cwd).toBe(homedir())
    expect(command.env.TERM).toBe('xterm-256color')
    expect(command.env.HOME).toBe(home)
    expect(command.env.PATH).toBe(bin)
  })

  it('records no login history when the import exits', () => {
    setMeta('account_logins', '{}')
    recordLogin('ssh-key', 0)
    recordLogin('ssh-key', 1)
    expect(accountLogins()).toEqual({})
  })
})

// Armor around an arbitrary body: the helper checks the shape, ssh-keygen the
// key. Never a real private key.
const PASTED_PRIVATE = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACB0ZXN0LW1hdGVyaWFsLWZvci10aGUtaW1wb3J0LWhlbHBlci10ZXN0LW9u
bHktdGVzdC1tYXRlcmlhbC1mb3ItdGhlLWltcG9ydC1oZWxwZXItdGVzdC1vbmx5AAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAdGVzdAECAwQF
-----END OPENSSH PRIVATE KEY-----
`

async function runHelper(input: string): Promise<{ code: number | null, stdout: string }> {
  const child = spawn(join(bin, 'python3'), ['-I', '-c', SSH_KEY_HELPER], {
    env: { HOME: home, PATH: bin },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  child.stdout.on('data', (chunk) => { stdout += String(chunk) })
  // A refusal exits before reading the whole paste; the write below must not
  // fail the test then.
  child.stdin.on('error', () => {})
  const closed = new Promise<number | null>((resolve) => child.on('close', resolve))
  child.stdin.write(input)
  child.stdin.end()
  const code = await closed
  return { code, stdout }
}

async function stubKeygen(script: string): Promise<void> {
  await writeFile(join(bin, 'ssh-keygen'), script)
  await chmod(join(bin, 'ssh-keygen'), 0o755)
}

async function modeOf(path: string): Promise<string> {
  return ((await stat(path)).mode & 0o777).toString(8).padStart(4, '0')
}

describe('the import helper', () => {
  it('saves a pasted key with 0600 and derives its public key', async () => {
    await stubKeygen(`#!/bin/sh\nprintf '%s\\n' '${PUB}'\n`)
    const { code, stdout } = await runHelper(`id_pasted\n${PASTED_PRIVATE}`)
    expect(code).toBe(0)
    expect(stdout).toContain('Saved ~/.ssh/id_pasted (0600) and ~/.ssh/id_pasted.pub.')
    expect(stdout).toContain(`SHA256 fingerprint: ${FINGERPRINT}`)
    const dir = join(home, '.ssh')
    expect(await modeOf(dir)).toBe('0700')
    expect(await modeOf(join(dir, 'id_pasted'))).toBe('0600')
    expect(await modeOf(join(dir, 'id_pasted.pub'))).toBe('0644')
    expect(await readFile(join(dir, 'id_pasted.pub'), 'utf8')).toBe(`${PUB}\n`)
    expect(listSshKeys(dir).map((key) => key.name)).toEqual(['id_pasted'])
  })

  it('defaults an empty name to id_ed25519', async () => {
    await stubKeygen(`#!/bin/sh\nprintf '%s\\n' '${PUB}'\n`)
    const { code, stdout } = await runHelper(`\n${PASTED_PRIVATE}`)
    expect(code).toBe(0)
    expect(stdout).toContain('Saved ~/.ssh/id_ed25519 (0600)')
    expect(await readFile(join(home, '.ssh', 'id_ed25519'), 'utf8')).toContain('BEGIN OPENSSH PRIVATE KEY')
  })

  it('refuses names that are not plain file names', async () => {
    await stubKeygen('#!/bin/sh\nexit 64\n')
    for (const name of ['../evil', 'a/b', '.hidden', 'key.pub', 'config', 'known_hosts', 'x'.repeat(65), 'has space']) {
      const { code, stdout } = await runHelper(`${name}\n${PASTED_PRIVATE}`)
      expect(code).toBe(1)
      expect(stdout).toContain('use a file name like id_ed25519')
    }
    expect(listSshKeys(join(home, '.ssh'))).toEqual([])
  })

  it('refuses to overwrite an existing file', async () => {
    await stubKeygen('#!/bin/sh\nexit 64\n')
    await seed({ id_kept: 'original' })
    const { code, stdout } = await runHelper(`id_kept\n${PASTED_PRIVATE}`)
    expect(code).toBe(1)
    expect(stdout).toContain('already exists')
    expect(await readFile(join(home, '.ssh', 'id_kept'), 'utf8')).toBe('original')
  })

  it('refuses when the public file already exists, however it exists', async () => {
    await stubKeygen('#!/bin/sh\nexit 64\n')
    const dir = await seed({ 'taken.pub': `${PUB}\n`, 'linked.pub': `${PUB}\n` })
    await rm(join(dir, 'linked.pub'))
    symlinkSync(join(dir, 'elsewhere'), join(dir, 'linked.pub'))
    await mkdir(join(dir, 'roomy.pub'), { recursive: true })
    for (const name of ['taken', 'linked', 'roomy']) {
      const { code, stdout } = await runHelper(`${name}\n${PASTED_PRIVATE}`)
      expect(code).toBe(1)
      expect(stdout).toContain(`~/.ssh/${name}.pub already exists`)
    }
    // The orphan public key is untouched, and no private file was created.
    expect(await readFile(join(dir, 'taken.pub'), 'utf8')).toBe(`${PUB}\n`)
    expect(listSshKeys(dir).filter((key) => key.hasPrivateKey)).toEqual([])
  })

  it('refuses what is not a private key', async () => {
    await stubKeygen('#!/bin/sh\nexit 64\n')
    const header = await runHelper('id_x\nhello, not a key\n')
    expect(header.code).toBe(1)
    expect(header.stdout).toContain('not a private key')
    const incomplete = await runHelper('id_x\n-----BEGIN OPENSSH PRIVATE KEY-----\nbody\n')
    expect(incomplete.code).toBe(1)
    expect(incomplete.stdout).toContain('incomplete')
    const empty = await runHelper('id_x\n')
    expect(empty.code).toBe(1)
    expect(empty.stdout).toContain('no key was pasted')
    const oversize = await runHelper(`id_x\n${'A'.repeat(70000)}\n`)
    expect(oversize.code).toBe(1)
    expect(oversize.stdout).toContain('larger than 64 KiB')
    expect(listSshKeys(join(home, '.ssh'))).toEqual([])
  })

  it('removes the key ssh-keygen refuses', async () => {
    await stubKeygen('#!/bin/sh\necho "invalid format" >&2\nexit 1\n')
    const { code, stdout } = await runHelper(`id_rejected\n${PASTED_PRIVATE}`)
    expect(code).toBe(1)
    expect(stdout).toContain('ssh-keygen refused the key: invalid format')
    expect(listSshKeys(join(home, '.ssh'))).toEqual([])
  })

  it('keeps the private key when ssh-keygen is missing', async () => {
    const { code, stdout } = await runHelper(`id_nokeygen\n${PASTED_PRIVATE}`)
    expect(code).toBe(0)
    expect(stdout).toContain('Saved ~/.ssh/id_nokeygen (0600), but ssh-keygen was not found')
    expect(listSshKeys(join(home, '.ssh'))).toEqual([expect.objectContaining({
      name: 'id_nokeygen', hasPrivateKey: true, publicKey: null,
    })])
  })

  it('derives the true public key with the real ssh-keygen', async () => {
    const keygen = resolveOnPath('ssh-keygen', process.env.POISE_TEST_BASE_PATH ?? '')
    if (!keygen) throw new Error('ssh-keygen is missing from the test runner PATH')
    await symlink(keygen, join(bin, 'ssh-keygen'))
    execFileSync(keygen, ['-t', 'ed25519', '-N', '', '-C', 'poise-ssh-helper', '-f', join(root, 'gen')], { stdio: 'pipe' })
    const privateKey = await readFile(join(root, 'gen'), 'utf8')
    const { code, stdout } = await runHelper(`id_real\n${privateKey}`)
    expect(code).toBe(0)
    const dir = join(home, '.ssh')
    const derived = execFileSync(keygen, ['-y', '-f', join(dir, 'id_real')], { encoding: 'utf8' })
    expect(await readFile(join(dir, 'id_real.pub'), 'utf8')).toBe(derived)
    const listed = execFileSync(keygen, ['-lf', join(dir, 'id_real.pub')], { encoding: 'utf8' }).split(/\s+/)[1]
    expect(stdout).toContain(`SHA256 fingerprint: ${listed}`)
    expect(listSshKeys(dir)).toEqual([expect.objectContaining({ name: 'id_real', fingerprint: listed })])
  }, 30_000)
})

describe('the SSH keys section', () => {
  const key = (overrides: Partial<SshKey> = {}): SshKey => ({
    name: 'id_test', hasPrivateKey: true, privateMode: '0600', privateBytes: 411,
    publicKey: PUB, publicKeyInvalid: false, fingerprint: FINGERPRINT, ...overrides,
  })

  it('invites the first key and opens the import terminal', () => {
    const html = sshKeysHtml([], null, false)
    expect(html).toContain('No SSH keys yet')
    expect(html).toContain('data-connect="ssh-key"')
    expect(html).toContain('Add an SSH key')
    expect(html).not.toContain('disabled')
    expect(sshKeysHtml(null, null, false)).toContain('Checking for SSH keys…')
  })

  it('disables the import while a terminal runs and shows read errors', () => {
    expect(sshKeysHtml([], null, true)).toContain('disabled')
    const html = sshKeysHtml([], 'Could not check SSH keys: boom.', false)
    expect(html).toContain('Could not check SSH keys: boom.')
  })

  it('shows each key by its fingerprint', () => {
    const html = sshKeysHtml([key()], null, false)
    expect(html).toContain('data-ssh-key="id_test"')
    expect(html).toContain(FINGERPRINT)
    expect(html).toContain('st-account-state-on')
    expect(html).not.toContain('chmod 600')
  })

  it('says how a key without a public key gets one', () => {
    const html = sshKeysHtml([key({ publicKey: null, fingerprint: null })], null, false)
    expect(html).toContain('No public key')
    expect(html).toContain('ssh-keygen -y -f ~/.ssh/id_test')
  })

  it('marks an unreadable public key and a public key without a private file', () => {
    expect(sshKeysHtml([key({ publicKey: null, publicKeyInvalid: true, fingerprint: null })], null, false))
      .toContain('holds no readable public key')
    const orphan = sshKeysHtml([key({ hasPrivateKey: false, privateMode: null, privateBytes: null })], null, false)
    expect(orphan).toContain('Public key only')
    expect(orphan).toContain('no private file')
  })

  it('warns when permissions are too open for ssh', () => {
    for (const mode of ['0600', '0400']) {
      expect(sshKeysHtml([key({ privateMode: mode })], null, false)).not.toContain('too open')
    }
    for (const mode of ['0644', '0666', '0604']) {
      const html = sshKeysHtml([key({ privateMode: mode })], null, false)
      expect(html).toContain(`Permissions ${mode} are too open`)
      expect(html).toContain('chmod 600 ~/.ssh/id_test')
    }
  })

  it('escapes file names from the disk', () => {
    const html = sshKeysHtml([key({ name: '<img src=x onerror=alert(1)>' })], null, false)
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })
})
