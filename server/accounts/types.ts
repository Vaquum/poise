// Connected accounts (docs/Service-architecture.md, "Accounts, identities and
// the terminal"): what GET /api/accounts answers. Shared with the browser, so
// nothing here may depend on Node.

export const ACCOUNT_IDS = ['claude', 'codex', 'gh', 'grok', 'muse', 'antigravity'] as const
export type AccountId = typeof ACCOUNT_IDS[number]

export function isAccountId(value: unknown): value is AccountId {
  return typeof value === 'string' && (ACCOUNT_IDS as readonly string[]).includes(value)
}

/** The page that opens on Settings → Connected accounts. Sign-in alerts link
 *  here; Settings reads the query when the page loads. */
export const CONNECTED_ACCOUNTS_PATH = '/?settings=accounts'

/** Each CLI's own login as the person reads it, checked against the CLI's
 *  --help; a Connect terminal runs exactly this. agy has no login subcommand:
 *  it opens its sign-in screen when it starts signed out, and offers /login. */
export const ACCOUNT_LOGINS: Record<AccountId, readonly string[]> = {
  claude: ['claude', 'auth', 'login', '--claudeai'],
  codex: ['codex', 'login', '--device-auth'],
  gh: ['gh', 'auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web'],
  grok: ['grok', 'login', '--device-auth'],
  muse: ['muse', 'login'],
  antigravity: ['agy'],
}

/** One account gh holds for github.com, as `gh auth status` reports it. */
export interface GhAccount {
  login: string
  active: boolean
  signedIn: boolean
  /** Why gh cannot use it, in gh's words; null when it can. */
  detail: string | null
}

export interface ConnectedAccount {
  id: AccountId
  installed: boolean
  version: string | null
  /** null when the CLI has no way to tell. */
  signedIn: boolean | null
  /** The account name the status command prints, and nothing more. */
  identity: string | null
  detail: string | null
  /** The command a Connect terminal runs. */
  login: { label: string }
  /** gh only: every account it holds for github.com. */
  accounts?: GhAccount[]
}
