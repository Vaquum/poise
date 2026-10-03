// Stand-ins for the six agent CLIs, so no test ever runs a real one or a real
// login. Each answers from a script under $HOME/.fake-cli (keyed by its
// arguments) and records every call, and a login that asks for a line of input
// can rewrite its own script, the way a real login changes what status says.
//
// The answers are what the real CLIs printed (claude 2.1.288 through Poise's
// wrapper, codex-cli 0.160.0, gh 2.92.0, grok 1.0.46, Muse Code 1.4.2, agy
// 1.2.14), with fictional accounts. A bin directory from writeFakeClis holds
// these and links to node and python3, and nothing else: on a PATH of just
// that directory a missing fake is a missing command, never the real CLI.

import { execFileSync } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { chmod, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { delimiter, join, resolve } from 'node:path'
import type { AccountId } from '../../../server/accounts/types'

export const COMMANDS: Record<AccountId, string> = {
  claude: 'claude', codex: 'codex', gh: 'gh', grok: 'grok', muse: 'muse', antigravity: 'agy',
}

export interface Answer {
  stdout?: string
  stderr?: string
  code?: number
  /** Wait for a line on stdin (the terminal) before finishing. */
  prompt?: boolean
  /** Answers that replace this CLI's script once it finishes. */
  then?: Script
}

/** Answers keyed by the arguments, joined with single spaces. */
export type Script = Record<string, Answer>

export interface FakeCall {
  name: string
  args: string[]
  /** Called through Poise's Claude wrapper, which adds --settings. */
  settings: boolean
  ghToken: string | null
  museNoAutoUpdate: string | null
  term: string | null
  tty: boolean
}

// Shared by every fake. A .cjs file is CommonJS wherever it sits, including
// under this repository's "type": "module".
const FAKE = String.raw`const fs = require('node:fs')
const path = require('node:path')
const name = path.basename(process.argv[2])
let args = process.argv.slice(3)
const settings = args[0] === '--settings'
if (settings) args = args.slice(2)
const dir = path.join(process.env.HOME, '.fake-cli')
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({
  name, args, settings,
  ghToken: process.env.GH_TOKEN ?? null,
  museNoAutoUpdate: process.env.MUSE_NO_AUTO_UPDATE ?? null,
  term: process.env.TERM ?? null,
  tty: process.stdin.isTTY === true,
}) + '\n')
const file = path.join(dir, name + '.json')
const script = JSON.parse(fs.readFileSync(file, 'utf8'))
const answer = script[args.join(' ')]
if (!answer) {
  process.stderr.write(name + ': unexpected arguments: ' + args.join(' ') + '\n')
  process.exit(64)
}
const finish = () => {
  if (answer.then) fs.writeFileSync(file, JSON.stringify({ ...script, ...answer.then }))
  process.exitCode = answer.code ?? 0
}
if (answer.stdout) process.stdout.write(answer.stdout)
if (answer.stderr) process.stderr.write(answer.stderr)
if (answer.prompt) process.stdin.once('data', () => { process.stdin.destroy(); finish() })
else finish()
`

export const VERSIONS: Record<AccountId, Answer> = {
  claude: { stdout: '2.1.288 (Claude Code)\n' },
  codex: { stdout: 'codex-cli 0.160.0\n' },
  gh: { stdout: 'gh version 2.92.0 (2026-04-28)\nhttps://github.com/cli/cli/releases/tag/v2.92.0\n' },
  grok: { stdout: 'grok 1.0.46 (2765805b9442)\n' },
  muse: { stdout: 'Muse Code 1.4.2 (1.4.2-R4684.1)\n' },
  antigravity: { stdout: '1.2.14\n' },
}

const claudeStatus = (fields: Record<string, unknown>) => `${JSON.stringify({
  apiProvider: 'firstParty',
  analyticsDisabled: false,
  projectsDirectory: '/home/poise/.claude/projects',
  configDirectory: '/home/poise/.claude',
  ...fields,
}, null, 2)}\n`

const ghAccount = (login: string, active: boolean, failure?: string) => ({
  state: failure ? 'error' : 'success',
  ...(failure ? { error: failure } : {}),
  active,
  host: 'github.com',
  login,
  tokenSource: 'keyring',
  ...(failure ? {} : { scopes: 'gist, read:org, repo, workflow' }),
  gitProtocol: 'https',
})

/** `claude auth status --json` (through the wrapper), `codex login status`
 *  and `gh auth status --json hosts --hostname github.com`. */
export const STATUS = {
  claudeSubscription: { stdout: claudeStatus({ loggedIn: true, authMethod: 'claude.ai', email: 'octocat@example.com', orgId: '7a1c0f2e-5b8d-4c39-9e61-2f0d4b6a8c13', orgName: 'octocat@example.com\'s Organization', subscriptionType: 'max' }) },
  claudeConsole: { stdout: claudeStatus({ loggedIn: true, authMethod: 'console', email: 'octocat@example.com' }) },
  claudeSignedOut: { stdout: claudeStatus({ loggedIn: false, authMethod: 'none' }), code: 1 },
  codexChatGpt: { stderr: 'Logged in using ChatGPT\n' },
  codexApiKey: { stderr: 'Logged in using an API key - sk-proj-***E1234\n' },
  codexSignedOut: { stderr: 'Not logged in\n', code: 1 },
  ghTwoAccounts: { stdout: `${JSON.stringify({ hosts: { 'github.com': [ghAccount('octocat', true), ghAccount('octo-agent', false)] } })}\n` },
  ghExpiredAgent: { stdout: `${JSON.stringify({ hosts: { 'github.com': [ghAccount('octocat', true), ghAccount('octo-agent', false, 'HTTP 401: Bad credentials (https://api.github.com/)')] } })}\n` },
  ghSignedOut: { stdout: '{"hosts":{}}\n', stderr: 'You are not logged into any GitHub hosts. To log in, run: gh auth login\n' },
} satisfies Record<string, Answer>

const STATUS_ARGS: Partial<Record<AccountId, string>> = {
  claude: 'auth status --json',
  codex: 'login status',
  gh: 'auth status --json hosts --hostname github.com',
}

const LOGIN_ARGS: Record<AccountId, string> = {
  claude: 'auth login --claudeai',
  codex: 'login --device-auth',
  gh: 'auth login --hostname github.com --git-protocol https --web',
  grok: 'login --device-auth',
  muse: 'login',
  antigravity: '',
}

/** A CLI's script: its version, its status answer, and a login that prints
 *  `loginPrompt`, waits for Enter and leaves `afterLogin` as the status. */
export function script(id: AccountId, status?: Answer, login?: { prompt: string, afterLogin?: Answer }): Script {
  const answers: Script = { '--version': VERSIONS[id] }
  const statusArgs = STATUS_ARGS[id]
  if (statusArgs && status) answers[statusArgs] = status
  if (login) {
    answers[LOGIN_ARGS[id]] = {
      stdout: login.prompt,
      prompt: true,
      ...(statusArgs && login.afterLogin ? { then: { [statusArgs]: login.afterLogin } } : {}),
    }
  }
  return answers
}

// Found on the PATH the tests started with, before any narrows it.
const STARTING_PATH = process.env.PATH
let python: string | null = null

function absolutePython(): string {
  python ??= execFileSync('python3', ['-I', '-c', 'import sys; print(sys.executable)'], { encoding: 'utf8', env: { ...process.env, PATH: STARTING_PATH } }).trim()
  return python
}

/** Fake CLIs in `bin` (all six unless omitted) answering from scripts under
 *  `home`, plus node and python3, which the wrapper and the terminal need. */
export async function writeFakeClis(bin: string, home: string, scripts: Partial<Record<AccountId, Script>>): Promise<void> {
  await mkdir(bin, { recursive: true })
  await mkdir(join(home, '.fake-cli'), { recursive: true })
  await writeFile(join(home, '.fake-cli', 'calls.jsonl'), '')
  await symlink(process.execPath, join(bin, 'node'))
  await symlink(absolutePython(), join(bin, 'python3'))
  await writeFile(join(bin, 'fake-cli.cjs'), FAKE)
  for (const [id, answers] of Object.entries(scripts) as Array<[AccountId, Script]>) {
    const command = join(bin, COMMANDS[id])
    // Only shell builtins: on a PATH of just `bin` there is nothing else.
    await writeFile(command, '#!/bin/sh\nexec node "${0%/*}/fake-cli.cjs" "$0" "$@"\n')
    await chmod(command, 0o755)
    await writeFile(join(home, '.fake-cli', `${COMMANDS[id]}.json`), JSON.stringify(answers))
  }
}

/** Replace one CLI's answers. */
export async function setScript(home: string, id: AccountId, answers: Script): Promise<void> {
  await writeFile(join(home, '.fake-cli', `${COMMANDS[id]}.json`), JSON.stringify(answers))
}

export async function fakeCalls(home: string): Promise<FakeCall[]> {
  return (await readFile(join(home, '.fake-cli', 'calls.jsonl'), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line) as FakeCall)
}

export async function clearCalls(home: string): Promise<void> {
  await writeFile(join(home, '.fake-cli', 'calls.jsonl'), '')
}

/** Where `name` resolves on `path`, as execvp finds it, or null. */
export function resolveOnPath(name: string, path: string): string | null {
  for (const dir of path.split(delimiter)) {
    const candidate = resolve(dir || '.', name)
    try {
      accessSync(candidate, constants.X_OK)
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // Not in this directory: execvp looks in the next one.
    }
  }
  return null
}

/** Throws unless `name` resolves on `path` to its fake in `bin`. */
export function assertFake(bin: string, name: string, path: string = process.env.PATH ?? ''): void {
  const found = resolveOnPath(name, path)
  if (found !== resolve(bin, name)) throw new Error(`${name} resolves to ${found ?? 'nothing'}, not its fake in ${bin}`)
}

/** Throws unless every agent CLI resolves on `path` to its fake in `bin`:
 *  then no real CLI, and no real login, can run. */
export function assertFakeClis(bin: string, path: string = process.env.PATH ?? ''): void {
  for (const name of Object.values(COMMANDS)) assertFake(bin, name, path)
}
