# Behavior ledger

The workspace exposes a compact, read-only view of individual firings of its
six existing Behaviors and their downstream attempts. Each retained instance
has a permanent 64-character hexadecimal hash. The ledger observes work; its
state never controls eligibility, claims, retries, locks, metrics or launches.
Capture does not wait for storage and adds no Caller reads.

## Read interface

Use the current workspace owner/loopback authority. There is no new public
machine token or gateway scope. All routes accept GET only:

| Route | Result |
| --- | --- |
| `/api/behavior-ledger?limit=50&cursor=...&parent=...` | Page of roots and attempts; optional parent restricts children |
| `/api/behavior-ledger/ID` | One retained instance |
| `/api/behavior-ledger/changes?cursor=...&limit=50` | Ordered upserts and removals |
| `/api/behavior-ledger/health` | Capture health, including unavailable storage |

Responses contain `version: 1` and `health`. Limits are integers from 1 to 100.
Start with a list request without a cursor. Its `watermark` is a changes cursor;
follow `nextCursor` until null, then consume changes from that watermark.
List pages freeze their creation boundary. Apply upserts by increasing record
`revision`; apply removals and retain their revisions. A changes response always
returns a usable `nextCursor`, even when empty. Save it after applying the page.
Concurrent writes can appear in both bootstrap and changes; revisions make
reapplication harmless.

Cursors are opaque, authenticated and workspace-store-specific. A malformed or
altered cursor returns 400; expired coverage or a replaced store returns 410 and
requires a new bootstrap. Unknown IDs return 404; a retained removal proves 410.
Normal restarts preserve cursors. Restoring an older identical backup requires
an operator-directed fresh bootstrap. Read saturation returns 429 with
`Retry-After`; unavailable or timed-out reads return 503. Health stays readable
with status 200 when storage is unavailable. Existing authentication and request
guards still apply.

The shipped command uses the same fixed GET routes:

```sh
node dist/behavior-ledger.js list --limit 50
node dist/behavior-ledger.js get HASH
node dist/behavior-ledger.js changes CURSOR
node dist/behavior-ledger.js health
```

`--base-url` accepts an HTTP numeric loopback origin, defaulting to
`http://127.0.0.1:${POISE_PORT:-5555}`. Redirects are refused; reads have a five
second deadline and 512 KiB response bound. Exit 0 means a successful reply with
complete health; 1 means HTTP/transport failure or incomplete/stale coverage;
2 means invalid arguments. The command emits server JSON unchanged.

## Meaning and evidence

A firing groups explicitly admitted work. PR review panels retain their native
scoped panel identity across head changes and retries. Approval requests use
their full native request identity. Issue panels freeze applicable configured
slots before temporary authentication/capacity filtering. Missing slots remain
pending. Disabling or shrinking a panel does not invent a completion.
Manual reviews and explicit replays create fresh firings; their ancestry is
unknown unless native replay adoption supplies evidence for the original work.
Each actual direct resolve, merge or CI-rerun invocation creates its own firing.

Records carry target, source, actor, times, state, activity and bounded native
references. A panel root has no single head; its children can have different
heads. Root state follows the latest attempt in each planned slot, with
running, held, unknown, pending, failed, superseded, completed precedence.
A superseded PR-review attempt leaves its panel pending for native relaunch.
Native settlement overrides passive Caller observations. `activity` separately
reports running, settled or unknown: held/failed never by itself proves idle.
Missing, duplicate, quarantined or stale evidence remains uncertain.

References identify existing Caller, GitHub or Logging evidence; they do not
archive it or promise permanent availability. Resolve details through existing
authorized readers. Service Logging still requires its owner session. Direct
raw mutation receipts are not archived by the ledger. Prompts, responses,
stdout, stderr, credentials and diagnostic prose are never stored here.

## Coverage and bounds

`health.status: ok` with zero pending/dropped captures and no gaps means complete
capture since `coverageStart`, within retained coverage. A fresh capture
heartbeat does not prove fresh Caller evidence. Relevant source evidence older
than 125 seconds becomes unknown/stale; no additional poll is performed.
The open/closed worker epoch and a separate bounded health journal preserve
unclean-restart and capture-loss gaps. Restarted direct work with no observed
native settlement remains unknown. The ledger has no historical backfill.

A separate worker owns `behavior-ledger.db` beside `POISE_DB` (by default
`~/.poise`); it never migrates the behavior cache. `POISE_DB=:memory:` also makes
the ledger ephemeral. Files use private permissions and SQLite rollback
journaling. Capture is bounded to 1,000 queued observations or 2 MiB, dropping
new arrivals explicitly on overflow. Reads allow 16 outstanding requests and a
two-second budget. Each completed capture permits one waiting read before
ordinary FIFO resumes. Reads can return a committed prefix with pending
captures reported in health. Startup yields after two seconds while the same
worker may still initialize; reads remain unavailable until valid readiness
arrives, then queued capture resumes. Actual worker failures remain unavailable.
Shutdown is bounded to two seconds.

Retention targets 30 days from meaningful updates, bounded by 10,000 instances,
30,000 changes, 32 MiB accounted metadata, a 64 MiB main database, at most
32 attempts per root and 4 KiB per record. Terminal direct no-write firings are
pruned first under pressure. Capacity can shorten history; uncertain-work
removal records a gap. Root eviction removes its children. The rollback journal
can add approximately 65 MiB; the independent health journal is at most 8 KiB.
Consumers must respect health, removals and 410 resync responses rather than
assuming a fixed retention period.

This contract is generic workspace functionality. Proxy delivery, public
coordinator credentials and any pilot deployment configuration are separate work.
