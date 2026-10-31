# Connected accounts

Menu → Settings → Accounts separates AI provider sign-ins (Claude Code, Codex, Grok,
Muse and Antigravity) from GitHub sign-ins. Each row shows the CLI's status
or a recorded sign-in, and opens its login in a terminal inside Settings. In a workspace that
is how a person connects their own accounts; on a personal computer it works
the same way. [Service architecture](Service-architecture.md#accounts-identities-and-the-terminal)
is the contract.

GitHub sign-ins appear in their own section below AI provider accounts. The
automation identity is called the GitHub automation account in sign-in alerts.
Login commands appear as contextual help on Connect, after half a second or
on keyboard focus. See [Menu and Settings](Menu.md).

## What each row shows

| CLI | Signed in, according to | Connect runs |
| --- | --- | --- |
| Claude | `claude auth status --json`, through Poise's Claude wrapper | `claude auth login --claudeai`, through the wrapper |
| Codex | `codex login status` | `codex login --device-auth` |
| GitHub | `gh auth status --json hosts --hostname github.com` | `gh auth login --hostname github.com --git-protocol https --web` |
| Grok | no status command | `grok login --device-auth` |
| Muse | its auth file's non-secret fields: API key or account login | `muse login`; `muse auth set --api-key-stdin` stores an API key |
| Antigravity | no status command | `agy`, which shows its sign-in screen when it starts signed out (`/login` signs in again) |

The version comes from `<cli> --version`; a CLI Poise cannot find on its
`PATH` reads "Not installed". A status command that fails, or does not answer
within 10 seconds, is reported with the reason.

- **Claude** counts as signed in only on a Claude subscription, the only
  sign-in Poise runs Claude on. The row names the account's email.
- **GitHub** lists every account gh holds for github.com and marks the active
  one, your GitHub account and the agent account (Settings → General). It says
  when either of those two is not signed in to gh, and names any account whose
  token gh can no longer use. It reads the stored accounts; a `GH_TOKEN` in
  Poise's environment is kept out of both the status and the login.
- **Grok and Muse** show **Signed in here** and Reconnect once their Connect
  login exits successfully. This records history in Poise, survives reopening
  Settings and server restarts, and does not verify the session is still valid.
- **Muse** also shows which credential its auth file holds: **API key**, or
  **Account login (device code)**. Its Connect warns that `muse login`
  switches Muse to the account login and its subscription quota; **Use an API
  key** runs `muse auth set --api-key-stdin` in a terminal instead, where the
  person pastes the key. A Muse turn that fails on subscription quota says
  Muse is running on the account login, not an API key.
- **Antigravity** requires confirmation in setup: closing its app cannot prove
  a sign-in. Existing confirmations remain available, including older entries
  whose manual/automatic origin cannot be distinguished.
- Setup can confirm or withdraw these three providers; Accounts reflects that
  immediately. Without a record their rows say **Sign-in not reported**.
  Failed reconnects preserve earlier history; failed/signaled logins and shell
  exits never create a confirmation. Missing CLIs or failed version probes
  display their problem even when history exists. Claude, Codex and GitHub
  always use their own status, including errors, regardless of saved history.

Poise never opens a CLI's credential files, except Muse's auth file, which it
reads for its non-secret fields only: which credential it holds, never a key
or token. Otherwise it runs only the status commands above and passes on only
the account name one prints. Answers are kept for 15 seconds, so reopening
Settings does not run every CLI again, and dropped whenever a terminal exits.

## Which providers a model check maintains

A model check maintains only participating providers: a provider participates
when Poise has a durable record that it was configured, or when its live
status positively verifies a usable sign-in.

- The record is the existing `account_logins` history: a Connect login that
  finished, a setup confirmation, or a Claude/Codex sign-in the server
  observed, including one made outside Poise. History proves configuration,
  never current credential validity.
- Grok, Muse and Antigravity have no live status command, so their history
  is their only participation signal. Claude and Codex participate on history
  or a verified live sign-in.
- A recorded provider whose CLI is now missing, signed out, broken or
  unreadable stays participating and reports the failure. A provider with
  neither history nor a verified sign-in is skipped when the evidence
  establishes it as unconfigured. A failed eligibility read is unknown and
  fails the check; it never reads as unconfigured. A corrupt record fails
  closed the same way: checks fail and alerts stay as they are.
- Status reads use each CLI's default credential store. The Codex probe does
  not follow CODEX_HOME, like Connect and the server probes, so a sign-in
  held only there reads as signed out; connecting Codex through Poise
  records it and brings it into the checks.
- Deliberate withdrawal is setup's withdrawal for Grok, Muse and Antigravity,
  which removes the record. Claude and Codex have no Disconnect in Poise, so
  a previously configured one stays participating and reports a lost sign-in.

The manual server route, the service daily scheduler and the personal
launchd job resolve the same rule from the same database. Connecting a
provider does not refresh the catalogue at once; its rows wait for the next
check.

## Alerts

Each read also records a sign-in alert, which Poise Link shows on the desktop:
for an installed, configured CLI that says it is not signed in (Codex, today),
and for your GitHub account or the GitHub automation account while gh does not
hold it signed in. A provider that was never configured raises no sign-in
demand, and a stale demand clears once the provider reads as unconfigured.
An alert comes once and again only after it has cleared, which happens when
the CLI or the account is signed in again; a CLI that cannot say changes
nothing. Claude's alert comes from Poise's own Claude sign-in check instead,
gated on the same participation. In service mode Poise reads the accounts
every 15 minutes as well, so the alerts come while no browser is open. Each
one opens the workspace on Settings → Accounts (`/?settings=accounts`).

## The terminal

Connect opens a terminal in Settings, running that CLI's login in your home
folder, with the same environment allowlists as every process Poise starts.
The device-code logins (Codex, gh, Grok, Muse) print a link and a code to enter
in your own browser; Claude prints a link and asks for the code the page gives
back. Muse's Use an API key instead runs `muse auth set --api-key-stdin`: the
person pastes the key into that terminal, and it travels on stdin straight to
Muse, so Poise never sees or stores it. When the login exits, the terminal
says with which code and the rows refresh. After Claude's login Poise also
verifies the Claude subscription at once, so its sign-in banner clears without
waiting for the next check.

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

## Google accounts

Google connections use the same account rows and compact status text below the
CLI accounts. Connect Google opens ordinary browser account selection and consent;
Add Google account connects another email. Reconnect verifies the same stable
Google identity. Disconnect forgets that owner's grant and retains its documents.
The operator configures the integration once; users enter no client IDs or secrets.
[Google connections](Google-connections.md) describes the flow, saved-draft return,
status, configuration and old-file authorization limits.
