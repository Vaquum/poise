// What each terminal preset runs: a CLI's own login, or the person's login
// shell, in their home folder.

import { homedir, userInfo } from 'node:os'
import { ACCOUNT_CLIS } from '../accounts/clis'
import { MUSE_API_KEY_LOGIN } from '../accounts/types'
import { scrubbedChildEnvironment } from '../process'
import type { TerminalCommand } from './pty'
import type { TerminalPreset } from './protocol'
import { SSH_KEY_HELPER } from './ssh-key-helper'

// The browser draws the terminal with xterm.js.
const TERMINAL_ENV: NodeJS.ProcessEnv = { TERM: 'xterm-256color', COLORTERM: 'truecolor' }

export function presetCommand(preset: TerminalPreset): TerminalCommand {
  if (preset === 'shell') {
    const shell = userInfo().shell
    if (!shell) throw new Error('Poise cannot find your login shell: the user database names none.')
    return { command: shell, args: ['-l'], env: scrubbedChildEnvironment(shell, TERMINAL_ENV), cwd: homedir() }
  }
  if (preset === 'muse-api-key') {
    const [command, ...args] = MUSE_API_KEY_LOGIN
    return { command, args, env: scrubbedChildEnvironment(command, TERMINAL_ENV, args), cwd: homedir() }
  }
  if (preset === 'ssh-key') {
    return { command: 'python3', args: ['-I', '-c', SSH_KEY_HELPER], env: scrubbedChildEnvironment('python3', TERMINAL_ENV), cwd: homedir() }
  }
  const { login } = ACCOUNT_CLIS[preset]
  return {
    command: login.command,
    args: login.args,
    // The same allowlists as every other child, with the CLI's own overrides.
    env: scrubbedChildEnvironment(login.command, { ...login.env(), ...TERMINAL_ENV }, login.args),
    cwd: homedir(),
  }
}
