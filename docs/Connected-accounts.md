# Connected accounts

Settings → Accounts shows the agent CLIs Poise runs (Claude Code, Codex, gh,
Grok, Muse and Antigravity) as each CLI's own status command reports them,
and opens each one's login in a terminal inside Settings. In a workspace that
is how a person connects their own accounts; on a personal computer it works
the same way. [Service architecture](Service-architecture.md#accounts-identities-and-the-terminal)
is the contract.

## What each row shows

| CLI | Signed in, according to | Connect runs |
| --- | --- | --- |
| Claude | `claude auth status --json`, through Poise's Claude wrapper | `claude auth login --claudeai`, through the wrapper |
| Codex | `codex login status` | `codex login --device-auth` |
| GitHub | `gh auth status --json hosts --hostname github.com` | `gh auth login --hostname github.com --git-protocol https --web` |
| Grok | no status command | `grok login --device-auth` |
| Muse | no status command | `muse login` |
| Antigravity | no status command | `agy`, which shows its sign-in screen when it starts signed out (`/login` signs in again) |

The version comes from `<cli> --version`; a CLI Poise cannot find on its
`PATH` reads "Not installed". A status command that fails, or does not answer
within 10 seconds, is reported with the reason.

- **Claude** counts as signed in only on a Claude subscription, the only
  sign-in Poise runs Claude on. The row names the account's email.
- **GitHub** lists every account gh holds for github.com, marks the active one
  and the one that is you (Settings → General → Username), and names any
  account whose token gh can no longer use. It reads the stored accounts; a
  `GH_TOKEN` in Poise's environment is kept out of both the status and the
  login.
- **Grok, Muse and Antigravity** have no command that reports sign-in, so their
  rows say so rather than guess.

Poise never opens a CLI's credential files. It runs only the status commands
above and passes on only the account name one prints. Answers are kept for 15
seconds, so reopening Settings does not run every CLI again, and dropped
whenever a terminal exits.

## The terminal

Connect opens a terminal in Settings, running that CLI's login in your home
folder, with the same environment allowlists as every process Poise starts.
The device-code logins (Codex, gh, Grok, Muse) print a link and a code to enter
in your own browser; Claude prints a link and asks for the code the page gives
back. When the login exits, the terminal says with which code and the rows
refresh. After Claude's login Poise also verifies the Claude subscription at
once, so its sign-in banner clears without waiting for the next check.

Open a shell starts your login shell instead, for anything the logins do not
cover (for example `gh auth switch`).

- At most two terminals run at a time, across every open tab; a third is
  refused with a message saying so. Settings runs one login at a time.
- A terminal with neither input nor output for 15 minutes is closed.
- Close, a lost connection or Poise stopping hangs up the program's process
  group.
- Only the workspace owner's browser can open one: in service mode the
  gateway's `link` and `admin` scopes are refused, and locally the same host,
  origin and cross-site checks as every API request apply.

The browser draws the terminal with [xterm.js](https://xtermjs.org/). On the
server a small Python helper (standard library only) provides the
pseudo-terminal, so Poise needs `python3` on its `PATH`; without it the
terminal closes saying so.

In service mode the Claude sign-in banner's button opens Settings → Accounts
with Claude's login already running, in place of the local-browser sign-in a
workspace cannot offer.
