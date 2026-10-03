// The agent CLIs a workspace signs in: the executable Poise finds on its PATH
// and the login a Connect terminal runs (ACCOUNT_LOGINS). Poise starts a login
// only in a terminal the person drives; nothing runs one on its own.

import { CLAUDE_SUBSCRIPTION_CLI, claudeSubscriptionEnvironment } from '../process'
import { ACCOUNT_LOGINS, type AccountId } from './types'

export interface LoginCommand {
  command: string
  args: readonly string[]
  /** Variables overlaid on the scrubbed environment, as runFile takes them. */
  env: () => NodeJS.ProcessEnv
  /** The command as the person reads it. */
  label: string
}

export interface AccountCli {
  id: AccountId
  /** The executable Poise finds on its PATH. */
  command: string
  login: LoginCommand
}

// gh prefers a token from the environment over the accounts it stores and
// refuses to log in while one is set. Connected accounts are the stored ones,
// so neither the status nor the login may see such a token.
export const GH_STORED_ACCOUNTS_ENV: NodeJS.ProcessEnv = {
  GH_TOKEN: undefined,
  GITHUB_TOKEN: undefined,
  GH_ENTERPRISE_TOKEN: undefined,
  GITHUB_ENTERPRISE_TOKEN: undefined,
  GH_HOST: undefined,
}

function cli(id: AccountId, env: () => NodeJS.ProcessEnv = () => ({}), runs?: string): AccountCli {
  const [command, ...args] = ACCOUNT_LOGINS[id]
  return { id, command, login: { command: runs ?? command, args, env, label: ACCOUNT_LOGINS[id].join(' ') } }
}

export const ACCOUNT_CLIS: Record<AccountId, AccountCli> = {
  // Through Poise's Claude wrapper, so the login gets the same subscription
  // isolation as every Claude launch.
  claude: cli('claude', claudeSubscriptionEnvironment, CLAUDE_SUBSCRIPTION_CLI),
  codex: cli('codex'),
  gh: cli('gh', () => ({ ...GH_STORED_ACCOUNTS_ENV })),
  grok: cli('grok'),
  muse: cli('muse'),
  antigravity: cli('antigravity'),
}
