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
  turn finished) become native notifications. Clicking one opens its page.

It starts at login by itself; installing the app is the only setup. The
contract it is built against is the "Snippets and Poise Link" section of
[Service architecture](Service-architecture.md).

## Install

Installers are built by the **Poise Link** GitHub Actions workflow, on demand
(Run workflow) and for every `link-v*` tag. Open the run and download the
artifact for your system. They are not published as releases yet, and they
are not signed with a developer certificate (the macOS app carries only an
ad-hoc signature), so each system asks once whether you trust the app.

**macOS (Apple silicon and Intel).** Download `poise-link-macos-universal-dmg`,
open the `.dmg` inside it and drag Poise Link to Applications. The first time
you open it macOS says it cannot check the app for malicious software. Choose
Done, open System Settings → Privacy & Security, find the note that Poise Link
was blocked and choose Open Anyway, then confirm. On macOS 14 and earlier you can instead
Control-click the app in Applications and choose Open. Allow notifications
when macOS asks.

**Windows.** Download `poise-link-windows-x64-nsis` (a setup `.exe`) or
`poise-link-windows-x64-msi`, and run it. SmartScreen says "Windows
protected your PC": choose More info, then Run anyway. The installer adds
Microsoft's WebView2 runtime if it is missing.

**Linux.** Download `poise-link-linux-amd64-deb` and install the package in it
with `sudo apt install ./Poise*_amd64.deb`, or download
`poise-link-linux-amd64-appimage`, make the `.AppImage` executable and run it.
The tray icon needs a desktop with AppIndicator support; on GNOME that is the
"AppIndicator and KStatusNotifierItem Support" extension, which Ubuntu
includes. The device token goes to the Secret Service (GNOME Keyring or
KWallet) when one is running.

Install [Espanso](https://espanso.org/install/) and start it once so that its
match folder exists. Poise Link never creates that folder.

## Pair

1. Open Poise Link. The window asks for the Poise address you sign in at, for
   example `poise.example.com` (`https://` is assumed).
2. Choose Pair. Poise Link shows a code such as `WDJB-MJHT` and opens the
   confirmation page (`/link`) in your browser.
3. Sign in there if asked, check that the page shows the same code, and
   approve it.
4. Poise Link keeps the device token in the operating system's credential
   store, turns on Start at login, and steps aside to the tray. A notification
   confirms who it is paired as.

From then on it holds an event stream open to your workspace, reconnecting
with backoff (at most five minutes apart) when the connection drops. Snippets
are fetched when they change and checked every ten minutes. Alerts are shown
once, even across reconnects and restarts. Opening Poise Link again shows its
window with the pairing and sync status.

If the device is revoked in Poise (at `/link/devices`), Poise Link notices on
its next request, says so once in a notification, forgets the token and shows
the pairing window again. Espanso keeps the last snippets it received.

## The tray menu

- The first two lines show the connection (connected, reconnecting or signed
  out) and the last snippet sync.
- **Open Poise** opens your workspace in the browser.
- **Sync now** fetches the snippets again and brings `poise.yml` up to date.
- **Notifications** turns alert notifications on or off.
- **Start at login** turns the login item on or off.
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
| Start at login | `~/Library/LaunchAgents/Poise Link.plist` | `Poise Link` under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` | `~/.config/autostart/Poise Link.desktop` |
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
   entry by hand.
2. Revoke the device in Poise at `/link/devices`.
3. Remove the app: drag it from Applications to the Trash (macOS), use
   Settings → Apps → Installed apps (Windows), or `sudo apt remove poise-link`
   or delete the `.AppImage` (Linux).
4. Delete the settings folder and the log folder from the table above. If you
   quit without signing out, also delete the `com.vaquum.poise.link` entry in
   Keychain Access, Credential Manager or Seahorse.
5. Delete `poise.yml` from Espanso's match folder if you no longer want those
   snippets.

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
```

The core (pairing, the event stream and the duties) has no user interface, so
the integration test in `link/src-tauri/tests` drives it against a fake Poise.
A new local job is a new module under `src/duties` implementing the `Duty`
trait and one line in `duties::standard`.

Running a development build registers nothing until you pair it; pairing turns
on Start at login for that build.

## Not done yet

- Code signing with a developer certificate and notarization (macOS), and
  Authenticode signing (Windows), once signing keys exist. Until then the
  first-launch steps above apply.
- Automatic updates; install a newer build over the old one.
- On Windows, an alert opens its page when clicked while the notification is on
  screen, but not later from the notification center.
