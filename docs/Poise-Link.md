# Poise Link

Poise Link is the desktop companion to a Poise workspace. It runs in the menu
bar (macOS) or system tray (Windows, Linux) and does two things while the
browser is closed:

- **Snippets.** It keeps Espanso's copy of your snippets equal to the ones you
  edit in Poise. Sync is one way: Poise is where snippets are edited, and
  Poise Link writes them to a single file, `poise.yml`, in Espanso's match
  folder.
- **Alerts.** Poise alerts (a sign-in is needed, a behavior failed and is held,
  datastore sync keeps failing, a Chat agent is waiting for you, a long Chat
  turn finished, a pull request of yours is ready to merge) become native
  notifications. Clicking one opens its page. With the browser open, Poise
  shows the same alerts at the top of the page; see
  [Notifications](Notifications.md).

One command installs it, with Espanso when Espanso is missing, and once it is
paired it starts at login by itself. The contract it is built against is the
"Snippets and Poise Link" section of
[Service architecture](Service-architecture.md).

## Install

On macOS, or on Debian 12+ and Ubuntu 24.04+ (amd64), run this in a terminal
as yourself:

```bash
curl -fsSL https://github.com/autonomio/poise/releases/latest/download/install.sh | sh
```

Debian and Ubuntu do not always come with curl; `wget` does the same:

```bash
wget -qO- https://github.com/autonomio/poise/releases/latest/download/install.sh | sh
```

The installer, [`link/install.sh`](../link/install.sh):

1. Downloads Poise Link from the newest release and, when Espanso is not
   installed yet, Espanso 2.4.1 from Espanso's own release. It checks Poise
   Link's files against the release's `SHA256SUMS` and Espanso's against
   checksums pinned in the script, and stops before changing anything when one
   does not match.
2. On **macOS** it copies Poise Link, and Espanso when it was missing, into
   `/Applications` (`~/Applications` when `/Applications` is not writable).
   Downloaded this way the apps carry no quarantine flag, so macOS opens Poise
   Link without the "cannot check it for malicious software" prompt that its
   ad-hoc signature would otherwise bring. On **Debian and Ubuntu** it installs
   Poise Link's package, and Espanso's X11 or Wayland package to match your
   session, in one `apt-get` call; `sudo` asks for your password. On Wayland
   it then grants Espanso the `cap_dac_override` capability, as Espanso's own
   instructions do.
3. Starts Espanso; on Linux it registers Espanso's systemd user service, so
   Espanso also starts at login. The first time, Espanso opens its setup
   window. On macOS, allow Accessibility when it asks: Espanso needs it to
   type your snippets. The installer waits up to 15 minutes for the setup to
   finish; Ctrl-C stops waiting.
4. Opens Poise Link and checks that it is still running a few seconds later;
   the installer fails, saying so, when it is not. The first time, Poise Link
   asks for your Poise address (see [Pair](#pair)).

An Espanso that is already installed is used as it is: the installer never
replaces, upgrades or reconfigures it.

**Update** by running the same command again. It installs the newest release
first and only then quits the running Poise Link and opens the new one, so a
failed update leaves Poise Link running as it was. On macOS, while launchd
runs Poise Link (see [Start at login](#the-tray-menu)), launchd restarts it
on the new version instead. On Linux, over a connection without a display,
such as SSH, the running Poise Link keeps the previous version until you quit
it and open it again. The pairing stays. On macOS, Keychain may
ask once whether the new Poise Link may use its saved pairing, because each
build carries a new ad-hoc signature: choose Always Allow.

**Elsewhere.** The installer stops before changing anything when it runs as
root, on Linux without apt, or on Linux on anything but x86_64: Espanso
builds for Linux on x86_64 only, as Debian packages and an X11 AppImage, and
Espanso 2.4.1's packages need Debian 12 or Ubuntu 24.04 or newer. Install by
hand there, from the [release page](https://github.com/autonomio/poise/releases/latest):

- **Linux:** make `Poise-Link-linux-amd64.AppImage` executable and run it, and
  install [Espanso](https://espanso.org/install/) for your distribution. Start
  Espanso once so that its match folder exists; Poise Link never creates that
  folder.
- **Windows:** run `Poise-Link-windows-x64-setup.exe` (or the `.msi`).
  SmartScreen says "Windows protected your PC": choose More info, then Run
  anyway. The installer adds Microsoft's WebView2 runtime if it is missing.
  Install [Espanso](https://espanso.org/install/) as well.
- **macOS, from a browser download:** open `Poise-Link-macos-universal.dmg` and
  drag Poise Link to Applications. The first time you open it, macOS says it
  cannot check the app for malicious software: choose Done, open System
  Settings → Privacy & Security, find the note that Poise Link was blocked and
  choose Open Anyway. On macOS 14 and earlier you can instead Control-click
  the app in Applications and choose Open.

Allow notifications when the system asks. On Linux the tray icon needs a
desktop with AppIndicator support; on GNOME that is the "AppIndicator and
KStatusNotifierItem Support" extension, which Ubuntu includes. The device
token goes to the Secret Service (GNOME Keyring or KWallet) when one is
running.

These settings change what the installer does, given as
`curl -fsSL … | POISE_LINK_SESSION=wayland sh`:

| Variable | Effect |
| --- | --- |
| `POISE_LINK_DOWNLOAD_BASE` | Where Poise Link's files and `SHA256SUMS` are; by default the newest release |
| `POISE_LINK_APP_DIR` | macOS: the folder the apps go to, and the only folder Espanso is looked for in |
| `POISE_LINK_ESPANSO_WAIT` | Seconds to wait for Espanso's setup: 900 by default, `0` does not wait |
| `POISE_LINK_SESSION` | Linux: `x11` or `wayland`, when the terminal is not part of your desktop session |

### Releases

A `link-v*` tag that names the version in `link/src-tauri/Cargo.toml` makes
the **Poise Link** workflow build the installers for macOS (universal), Linux
and Windows, run the installer with them for real on fresh macOS (Apple
silicon and Intel), Ubuntu 24.04 and 26.04, and Debian 12 and 13 machines, and
only then publish the GitHub release. It holds
`Poise-Link-macos-universal.dmg`, `Poise-Link-linux-amd64.deb`,
`Poise-Link-linux-amd64.AppImage`, `Poise-Link-windows-x64-setup.exe`,
`Poise-Link-windows-x64.msi`, `install.sh` and `SHA256SUMS`. The names carry no
version, so `releases/latest/download/<name>` always reaches the newest
release. Pull requests and pushes to `main` that touch `link/` run the same
builds and installs without publishing anything.

## Pair

1. Open Poise Link. The window asks for the Poise address you sign in at, for
   example `poise.example.com` (`https://` is assumed).
2. Choose Pair. Poise Link shows a code such as `WDJB-MJHT` and opens
   `/link` in your browser, which takes you to Settings → Accounts → Poise
   Link in your workspace.
3. Sign in there if asked, enter the code Poise Link shows, and approve it.
4. Poise Link keeps the device token in the operating system's credential
   store, turns on Start at login, and steps aside to the tray. A notification
   confirms who it is paired as. On macOS it then hands over to launchd, which
   from then on starts it again if it stops: its icon leaves the menu bar for
   a moment and comes back.

From then on it holds an event stream open to your workspace, reconnecting
with backoff (at most five minutes apart) when the connection drops. Snippets
are fetched when they change and checked every ten minutes. Alerts are shown
once, even across reconnects and restarts. Opening Poise Link again shows its
window with the pairing and sync status.

Paired is not the same as running. Settings → Accounts → Poise Link shows a
paired computer as **Connected** while its Poise Link holds that event stream
open. Otherwise it shows **Not connected**, with when it was last seen: Poise
Link is not running on that computer, or it cannot reach Poise. Snippets and
alerts reach it once it connects again. The list follows computers connecting
and going away while it is on screen. The Snippets view says the same in one
line: whether a change made there reaches your computer in seconds, or waits
for Poise Link.

If the device is revoked in Poise (Settings → Accounts → Poise Link), Poise Link notices on
its next request, says so once in a notification, forgets the token and shows
the pairing window again. Espanso keeps the last snippets it received.

## The tray menu

- The first two lines show the connection (connected, reconnecting or signed
  out) and the last snippet sync.
- **Open Poise** opens your workspace in the browser.
- **Sync now** fetches the snippets again and brings `poise.yml` up to date.
- **Notifications** turns alert notifications on or off.
- **Start at login** turns the login item on or off. On macOS it is a launch
  agent that also keeps Poise Link running: when Poise Link crashes or is
  stopped any way but Quit, for example with `kill`, launchd starts it again
  within seconds. While it is on, launchd's copy is the one that runs: opening
  Poise Link from the Finder has launchd start it, or has the copy launchd
  runs show its window, and launchd's copy asks any other copy to quit. A Poise Link opened from another folder than before,
  because it was moved or installed elsewhere, takes the agent over. Turning it off leaves the running copy as it is; it is
  not started at the next login.
- **Sign out** forgets the pairing on this computer. Revoke the device in Poise
  as well to invalidate its token.
- **Quit** stops Poise Link until you open it again (or until the next login).

## What reaches Espanso

Espanso can run commands from a match file (shell and script variables, forms,
imports of other files), so Poise Link writes only plain snippets. The
workspace's YAML is accepted only when it is a mapping whose single key,
`matches`, lists entries with exactly a string `trigger` and a string
`replace`, plus an optional string `label`. Anything else (another key, a
number where text belongs, YAML aliases, merge keys, tags, duplicate keys or a
second document) rejects the whole update: the previous `poise.yml` stays, the
tray says "Snippets rejected", and the log names the problem. Poise Link never
copies the workspace's YAML as it arrived; it writes its own rendering of the
accepted snippets, with every value double-quoted.

Espanso still fills `{{name}}` placeholders in a replacement from variables
defined in your own Espanso configuration (`global_vars`), so a snippet from
Poise can use only the variables you defined yourself.

Writes are atomic: the new content goes to `.poise.yml.tmp` in the same folder,
is flushed to disk, and is then renamed over `poise.yml`. No other file in the
folder is touched. If Espanso is not installed, the tray says "Espanso not
found" and nothing is written.

## Where it writes

| What | macOS | Windows | Linux |
| --- | --- | --- | --- |
| Snippets (`poise.yml`), by default | `~/Library/Application Support/espanso/match` | `%APPDATA%\espanso\match` | `$XDG_CONFIG_HOME/espanso/match` (default `~/.config`) |
| Settings (`state.json`) | `~/Library/Application Support/com.vaquum.poise.link/` | `%APPDATA%\com.vaquum.poise.link\` | `$XDG_CONFIG_HOME/com.vaquum.poise.link/` |
| Device token | Keychain, service `com.vaquum.poise.link`, account `device-token` | Credential Manager, same names | Secret Service, same names |
| Start at login | `~/Library/LaunchAgents/com.vaquum.poise.link.plist` | `Poise Link` under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` | `~/.config/autostart/Poise Link.desktop` |
| Log | `~/Library/Logs/com.vaquum.poise.link/` | `%LOCALAPPDATA%\com.vaquum.poise.link\logs\` | `~/.local/share/com.vaquum.poise.link/logs/` |

When the `espanso` command is on PATH, the snippets go to the `match` folder
inside the folder `espanso path config` names instead of the default. Apps
opened from the Finder or at login do not see your shell's PATH, so on macOS
the default is normally the one used; an Espanso configuration moved elsewhere
shows up as "Espanso not found".

When no credential store is available (for example a Linux session without a
Secret Service), the token is kept in `device-token` in the settings folder,
readable only by you (mode 0600), and the log says so.

The first time Poise Link replaces a `poise.yml` it did not write (for example
one that single-user Poise wrote), it first saves a copy as
`poise.yml.before-poise-link-<date>` in the settings folder and says so in a
notification. Import that file in Poise under Snippets to keep those snippets.

## Uninstall

1. In the tray menu, turn off **Start at login**, then choose **Sign out** and
   **Quit**. Turning off Start at login removes the LaunchAgent, Run key value
   or autostart entry listed above; if the app is already gone, delete that
   entry by hand. On macOS, also run
   `launchctl bootout gui/$(id -u)/com.vaquum.poise.link` then, or launchd
   keeps the agent it loaded until you log out.
2. Revoke the device in Poise under Settings → Accounts → Poise Link.
3. Remove the app: drag it from Applications to the Trash (macOS), use
   Settings → Apps → Installed apps (Windows), or `sudo apt remove poise-link`
   or delete the `.AppImage` (Linux).
4. Delete the settings folder and the log folder from the table above. If you
   quit without signing out, also delete the `com.vaquum.poise.link` entry in
   Keychain Access, Credential Manager or Seahorse.
5. Delete `poise.yml` from Espanso's match folder if you no longer want those
   snippets. Espanso stays installed, also when the installer installed it;
   remove it as [Espanso's documentation](https://espanso.org/docs/) describes.

## The workspace side

Poise serves the Link API from `server/link/` and records alerts in
`server/alerts/`.

**Who reaches it.** In a workspace a request needs the gateway's identity
assertion with a scope that reaches `/api/link/*`: a paired device's `link`
scope, or the owner's `browser` scope. The `admin` scope gets 403. A missing,
expired or forged assertion gets 401, the only status Poise Link signs out on;
nothing in the Link API answers 401 for any other reason. Outside service mode
it is a loopback API like every other route.

**`GET /api/link/hello`** returns `{ login, version }`: the workspace owner
(outside service mode the GitHub username from Settings, or `null`) and the
commit the running bundle was built from (`null` for a development build).

**`GET /api/link/snippets`** returns `{ version, yaml }`.

- The YAML holds the library's plain pairs: an entry is sent only when it has
  exactly a text `trigger`, a text `replace` and, optionally, a text `label`.
  Variables of every type (shell and script included), forms, regex
  triggers, `word`, `propagate_case` and every other match option, top-level
  `global_vars` and `imports`, and the library's own metadata comment stay
  out. A trigger belongs to its first entry, as in the Snippets view, and a
  blank trigger is dropped.
- Every value is double-quoted and escaped exactly as Poise Link renders its
  own copy, so the file on the desktop equals what was sent, byte for byte.
- `version` is the SHA-256 of that YAML and the `ETag` is `"<version>"`. A
  request whose `If-None-Match` names it gets 304; one without
  `If-None-Match` always gets 200.
- `?wait=<version>` holds the request while that version is current, for up
  to 25 seconds, and then answers as a plain request would. A change answers
  at once. At most 32 requests wait at a time; more get 503.

**`GET /api/link/events`** is a Server-Sent Events stream.

- It opens with `retry: 3000`, then `event: snippets` with
  `data: {"version":"…"}`, then the alerts recorded after `Last-Event-ID`.
- An alert is `id: <alert id>`, `event: alert` and
  `data: {"id","kind","title","body","url","created_at"}`. Alert ids look like
  `3f9c0a1b2c4d-17`: the prefix belongs to the workspace's database, so a
  replaced database never reuses an id a device has already shown.
- A reconnect resumes after the last alert received: the newest 50 alerts
  recorded since are replayed, oldest first. With no `Last-Event-ID`, or an
  id the workspace did not issue, only alerts recorded from then on follow.
- After that, a `snippets` event for each new version, an `alert` event for
  each new alert, and `event: ping` with `data: {}` every 20 seconds.
- A device that stops reading is cut off once a megabyte is queued for it; it
  reconnects and resumes. At most 32 streams are open at a time.
- When Poise stops, it ends every stream and answers every waiting long poll
  with 503, so a restart never waits on a device.

**Alerts** are kept in the workspace database for 30 days. Each condition
alerts once and again only after it has cleared:

| Kind | Recorded when | Cleared when |
| --- | --- | --- |
| `sign_in_needed` | Claude's sign-in check finds that a new sign-in is required | Claude is signed in again |
| `behavior_held` | a behavior gives up on a pull request or issue (a dead letter) where Behaviors showed no incident | Behaviors no longer shows the incident |
| `datastore_sync_failing` | syncing a GitHub account's datastore has been failing for 15 minutes | a sync succeeds |
| `chat_waiting` | a Chat agent asks for a permission or an answer | the session has nothing pending |
| `chat_turn_finished` | a Chat turn that ran longer than two minutes finishes, unless the person stopped it | (one alert per turn) |
| `pr_ready` | one of the person's own open pull requests becomes ready to merge, by Current's rule, checked every two minutes while notifications are on; not while the person has silenced it | it is merged or closed, or stops being ready |

An alert's `url` is absolute: `POISE_PUBLIC_ORIGIN` in a workspace, the
address the request came to otherwise. The browser client has no per-view
addresses yet, so every alert opens the workspace's front page.

**Snippets → Import** takes an Espanso match file, pasted or chosen (a chosen
file is loaded to check first), and adds its plain pairs through the same
compare-and-swap as every other snippet write. It applies the judgement above,
so everything it imports reaches the desktop. It never replaces a trigger
already in the library and never takes an entry that runs a command; it lists
every entry it skipped with the reason: a duplicate trigger, not a plain
snippet, or invalid. Labels are not kept. After importing a file from the
desktop, delete those snippets from it, so that Espanso does not find each
trigger twice.

## Develop

The app lives in `link/`: Rust in `link/src-tauri` (Tauri 2) and the window's
plain HTML, CSS and JavaScript in `link/ui`. The Rust toolchain is pinned in
`link/rust-toolchain.toml`; rustup installs it on first use. On Linux, install
Tauri's system libraries first:
`sudo apt install libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev patchelf`.

```bash
cd link/src-tauri
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test                      # unit tests and the fake-Poise integration test
cargo build                     # a debug build

cd ..
npm ci && npm run tauri build   # installers for this system

cd ..
shellcheck link/install.sh
python3 -m unittest discover --start-directory link/tests --pattern 'test_*.py'
```

The installer's tests run `link/install.sh` with stand-ins for every system
command it could change the computer with, so they install, start and stop
nothing. The real installs happen in CI, on fresh machines (see
[Releases](#releases)).

The core (pairing, the event stream and the duties) has no user interface, so
the integration test in `link/src-tauri/tests` drives it against a fake Poise.
A new local job is a new module under `src/duties` implementing the `Duty`
trait and one line in `duties::standard`.

Running a development build registers nothing until you pair it; pairing turns
on Start at login for that build. On macOS launchd then runs that build in
place of the installed one; turn Start at login off in its tray menu and quit
it, or pair the installed Poise Link again, to go back.

Poise Link 0.1 wrote its login item as `Poise Link.plist`, which started it
at login only. Poise Link 0.1.2 and later replace it with the launch agent
when they start, so start at login stays as it was.

## Not done yet

- Code signing with a developer certificate and notarization (macOS), and
  Authenticode signing (Windows), once signing keys exist. Until then a
  browser download needs the first-launch steps above.
- Automatic updates; run the install command again to update.
- On Windows, an alert opens its page when clicked while the notification is on
  screen, but not later from the notification center.
