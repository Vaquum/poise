# Provider CLI and model freshness

Poise updates installed provider CLIs before model discovery and checks the
selected provider before native Chat startup and each subsequent turn. A
running answer is never restarted for an update. At the next turn boundary,
a changed CLI version resumes the same native conversation on the new binary.
Steering and permission answers do not start another update.

The policy is to use the latest release, not a version pinned when Poise was
built. The Claude SDK remains a tested protocol dependency; its bundled CLI is
not used. Poise's subscription wrapper launches the standalone Claude executable.

## Updating and discovery

Settings → Models → **Check now** and the existing scheduled model check run
`scripts/refresh-models.mjs`. Both perform the same sequence:

1. Update installed Claude, Codex, Grok, Antigravity and Muse CLIs concurrently.
2. Read the actual launcher's version again, detecting duplicate-install issues.
3. Ask Caller's release-managed `agent-interface --refresh-models` for models.
4. Atomically record the CLI results and per-provider discovery results, then
   invalidate Poise's model cache.

Discovery uses the parent server's resolved `CALLER_BIN_ROOT` (default
`caller/.venv/bin`), passed explicitly to the refresh child. This is the same
Caller installation `/api/health` checks, including a workspace release's
separate `venv/bin` directory. A missing configured executable fails without
trying another installation or PATH. The receipt records `caller_executable`
on success and failure, with bounded failure diagnostics when spawning fails.
Direct script runs, including the personal-install launchd job, resolve the
same setting themselves.

Discovery never runs inference. Claude reads its local model cache, Codex and
Grok read their model caches, Antigravity lists its models, and Muse reads the
quality levels straight from its free model list. A family whose free source is
unavailable keeps its current rows and reports the cause; nothing is dropped.

Muse discovery considers only explicit `muse-…-contributor` selectors. An ordinary
Muse default is never admitted. No contributor model means discovery
fails for Muse and retains its existing contributor choices. Caller rejects
ordinary Muse selectors in persisted catalogs; Poise rejects them on catalog
import and native Chat startup, model changes and subsequent turns.

Every Muse process also receives `--contributor-mode on`; a CLI that cannot
enforce contributor mode fails instead of falling back to ordinary billing.

Claude uses `claude install latest`. npm-installed Codex checks the latest registry version first and, when needed,
updates `@openai/codex@latest` in its existing global prefix, including optional
native packages; other Codex installations use `codex update`. Grok and Antigravity
use their update commands. Muse's launcher performs a synchronous update; its
release build is checked as well as its semantic version.

Overlapping requests share a check. Separate Poise processes serialize updates
for each launcher and discovery for the shared report. A subsequent launch
checks again rather than trusting a time-to-live cache. Updaters receive only
installation/network environment variables, not model prompts or API tokens.
Only the selected provider is maintained on a native Chat turn. Caller-backed
card/editor chat, reviews, approvals, content and debate maintain their selected
providers before launch too. No unrelated packages or IDE bundles are upgraded.

## Failure and recovery

A CLI check has a two-minute total budget, including lock acquisition and
version probes. Discovery has a ten-minute deadline. The enclosing manual check
and browser request also have deadlines; Checking cannot remain disabled
indefinitely. A terminated standalone refresh runner kills its updater groups.

Offline, authentication, permissions or installation failures are not reported
as a verified latest version. Existing installed CLIs remain usable with a
visible Chat warning, and a later turn retries. A failed model check preserves
existing choices and reports the affected CLI/provider instead of claiming
“nothing new.” Missing providers are not installed implicitly.

The Settings view shows elapsed time in neutral text while checking, clearing
any previous failure message and error color. A failed check is red; a successful
check restores the neutral catalog status. It then shows versions and the
completed result. Refreshing the catalogue updates an untouched fresh console
to the re-resolved Chat default. Explicit model selections and
existing conversations are not silently moved to another model.

## Verification

Tests use isolated executables and version files, never the user's installations.
They cover updater ordering, shared checks, npm prefixes, Muse release builds,
failed discovery receipts, retry, cancellation/cleanup, native resume between
turns, catalogue invalidation, new-model defaults and browser timeout recovery.

Upgrade compatibility: older pages stored the fixed `opus-5-high` fresh-console
default without recording whether it was explicitly chosen. That legacy value
now restores as automatic, showing the saved Chat default, with draft text
preserved. New snapshots record automatic versus explicit selection, so future
reloads preserve a person's intentional model choice. Sessions whose model left
the catalog are deleted on startup, so a retired identity can never be resumed,
forked, or copied into a `/poise` change; every other session keeps its
selected model.
