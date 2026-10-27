import Database from 'better-sqlite3'
import { randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'os'
import { join, dirname } from 'path'

// Poise's local SQLite holds:
//   meta          — small key-value store for org / me / timezone settings
//   current_cards  — the manual Idea / Concept / Plan kanban cards
//   behavior_seen  — atomic automation dedupe claims
//   content_jobs   — durable /content finalization state and worker leases
//   content_launches — pre-spawn /content intent and call correlation
//   alerts         — what Poise Link shows as desktop notifications, and Poise
//                    as notices at the top of the page (server/alerts)
//   alert_silences — the alerts the person silenced, until their subject is gone
//
// Everything else (issues, PRs, reviews, files) lives in the user's external
// /github service. Older Poise versions kept a full mirror of GitHub data
// here in `prs` / `reviews` / `pr_files`. They are no longer read, but remain
// untouched so an upgrade never destroys user data.

const DEFAULT_DB_PATH = join(homedir(), '.poise', 'cache.db')
const DB_PATH = process.env.POISE_DB || DEFAULT_DB_PATH

function ensureDbDir() {
  if (DB_PATH === ':memory:') return
  const dir = dirname(DB_PATH)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  // Tighten the application-owned default directory. Never chmod an
  // arbitrary POISE_DB parent: it may intentionally be shared (for example
  // /tmp in a test environment).
  if (DB_PATH === DEFAULT_DB_PATH) chmodSync(dir, 0o700)
}

ensureDbDir()

export const db = new Database(DB_PATH)
if (DB_PATH !== ':memory:') chmodSync(DB_PATH, 0o600)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')
db.pragma('busy_timeout = 5000')
// Deleted credential bytes must be overwritten rather than left on SQLite's
// freelist. Set this before the migration that removes the retired PAT row.
db.pragma('secure_delete = ON')

db.exec(`
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS current_cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    lane TEXT NOT NULL,
    position INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_current_cards_lane ON current_cards(lane, position);

  -- Per-behavior dedupe ledger. Each row is "behavior <key> has already
  -- claimed <target> at <seen_at>". Used by the server-side behavior
  -- runtime (server/behaviors.ts) so concurrent runtimes — multiple
  -- vite processes, accidental tick re-entry, datastore returning a
  -- duplicate row, etc. — can't fire the same review twice. INSERT OR
  -- IGNORE makes both claims and snapshots idempotent.
  CREATE TABLE IF NOT EXISTS behavior_seen (
    key TEXT NOT NULL,
    target TEXT NOT NULL,
    seen_at TEXT NOT NULL,
    claim_id TEXT NOT NULL DEFAULT '',
    lease_until INTEGER,
    launch_behavior TEXT,
    launch_repo TEXT,
    launch_pr INTEGER,
    launch_requested_at TEXT,
    launch_call_id TEXT,
    launch_error TEXT,
    launch_quarantine TEXT,
    launch_quarantine_may_run INTEGER NOT NULL DEFAULT 1,
    launch_outcome TEXT,
    launch_completed_at TEXT,
    launch_head_sha TEXT,
    launch_expected_head TEXT,
    launch_actor TEXT,
    launch_source TEXT,
    launch_correlation_id TEXT,
    launch_action TEXT,
    launch_covers TEXT,
    PRIMARY KEY (key, target)
  );

  CREATE TABLE IF NOT EXISTS behavior_runs (
    id TEXT PRIMARY KEY,
    behavior TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    note TEXT,
    outcome TEXT
  );
  CREATE INDEX IF NOT EXISTS behavior_runs_started
    ON behavior_runs(unixepoch(started_at, 'subsec'));
  CREATE INDEX IF NOT EXISTS behavior_runs_running
    ON behavior_runs(unixepoch(started_at, 'subsec')) WHERE status = 'running';
  CREATE TABLE IF NOT EXISTS behavior_runs_revision (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    revision INTEGER NOT NULL
  );
  INSERT OR IGNORE INTO behavior_runs_revision VALUES (1, 0);
  CREATE TRIGGER IF NOT EXISTS behavior_runs_insert AFTER INSERT ON behavior_runs BEGIN
    UPDATE behavior_runs_revision SET revision = revision + 1 WHERE id = 1;
  END;
  CREATE TRIGGER IF NOT EXISTS behavior_runs_update AFTER UPDATE ON behavior_runs BEGIN
    UPDATE behavior_runs_revision SET revision = revision + 1 WHERE id = 1;
  END;
  CREATE TRIGGER IF NOT EXISTS behavior_runs_delete AFTER DELETE ON behavior_runs BEGIN
    UPDATE behavior_runs_revision SET revision = revision + 1 WHERE id = 1;
  END;

  CREATE TABLE IF NOT EXISTS behavior_dead_letters (
    id TEXT PRIMARY KEY,
    behavior TEXT NOT NULL,
    target TEXT NOT NULL,
    repo TEXT,
    pr INTEGER,
    actor TEXT,
    source TEXT,
    correlation_id TEXT,
    call_id TEXT,
    error TEXT NOT NULL,
    created_at TEXT NOT NULL,
    retired_at TEXT,
    resolution TEXT,
    resolution_evidence TEXT,
    resolved_at TEXT
  );

  -- Short replay reservations, one per reviewed target and behavior: two
  -- concurrent replays of one target cannot both pass admission and post
  -- duplicate reviews. Rows are replaced, never accumulate; expiry clears
  -- a reservation whose replay crashed before spawning.
  CREATE TABLE IF NOT EXISTS behavior_replay_reservations (
    repo TEXT NOT NULL,
    pr INTEGER NOT NULL,
    behavior TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    PRIMARY KEY (repo, pr, behavior)
  );

  CREATE TABLE IF NOT EXISTS content_jobs (
    call_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    topic TEXT NOT NULL,
    started_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
    slug TEXT NOT NULL,
    response_hash TEXT,
    error TEXT,
    article_created INTEGER NOT NULL DEFAULT 0,
    lease_owner TEXT,
    lease_expires_at INTEGER,
    next_attempt_at INTEGER NOT NULL DEFAULT 0,
    error_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS content_launches (
    launch_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    topic TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    registration_deadline_at INTEGER NOT NULL DEFAULT 0,
    recovery_eligible INTEGER NOT NULL DEFAULT 0,
    evidence_unreadable INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK (status IN ('pending', 'linked', 'failed')),
    call_id TEXT UNIQUE,
    error TEXT,
    updated_at TEXT NOT NULL
  );

  -- Alerts for Poise Link (server/alerts). AUTOINCREMENT never hands out an
  -- id again after pruning, so a device's resume point stays meaningful.
  -- One alert per condition while it is unresolved: see the unique index below.
  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    url TEXT NOT NULL,
    created_at TEXT NOT NULL,
    dedupe_key TEXT NOT NULL,
    resolved_at TEXT
  );

  -- Conditions the person asked to hear no more about, by alert dedupe key
  -- (server/alerts/notices.ts): kept apart from alerts, which are pruned after
  -- 30 days, until the condition's subject is gone.
  CREATE TABLE IF NOT EXISTS alert_silences (
    dedupe_key TEXT PRIMARY KEY,
    silenced_at TEXT NOT NULL
  );

  -- The handling log (server/alerts/handling.ts): append-only. Every row is
  -- one handled action — a notice dismissed, silenced or resolved, a
  -- behavior firing finished, a Caller-reported run completed — with its
  -- authoritative actor and timestamp, independent of any continuing alert.
  CREATE TABLE IF NOT EXISTS handling_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('notice', 'behavior-firing', 'caller-update')),
    source TEXT NOT NULL,
    title TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT NOT NULL,
    outcome TEXT NOT NULL,
    error TEXT,
    actor TEXT NOT NULL,
    ref TEXT NOT NULL UNIQUE
  );
  CREATE INDEX IF NOT EXISTS handling_log_at ON handling_log(at);
`)

// One-time migrations: the kanban table has been renamed twice.
//   pipe_cards   (when the view was called Pipe)
//   stream_cards (when it was Stream)
//   current_cards (now)
// Copying is idempotent and deliberately non-destructive: legacy tables stay
// in place as a recovery source. INSERT OR IGNORE means a restart cannot
// duplicate rows already copied into current_cards.
function migrateKanbanTable(legacy: string) {
  const exists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(legacy) as { name: string } | undefined
  if (!exists) return
  db.exec(`
    INSERT OR IGNORE INTO current_cards (id, text, lane, position, created_at, updated_at)
    SELECT id, text, lane, position, created_at, updated_at FROM ${legacy};
  `)
}

const LEGACY_KANBAN_MIGRATION_KEY = 'schema_migration_legacy_kanban_v1'

function migrateLegacyKanbanOnce() {
  const migrated = db.prepare('SELECT 1 AS x FROM meta WHERE key = ?').get(
    LEGACY_KANBAN_MIGRATION_KEY,
  ) as { x: number } | undefined
  if (migrated) return

  migrateKanbanTable('pipe_cards')
  migrateKanbanTable('stream_cards')
  db.prepare('INSERT INTO meta(key, value) VALUES(?, ?)').run(
    LEGACY_KANBAN_MIGRATION_KEY,
    new Date().toISOString(),
  )
}

// Add the `repo` column if it's not there yet — manual cards can be
// linked to a repo (full owner/name, e.g. "acme/foo") so the meta
// row reads consistently with the live PR/Issue lanes.
function ensureColumn(table: string, column: string, ddl: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (cols.some((c) => c.name === column)) return false
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
  return true
}

export const CONTENT_LAUNCH_RECOVERY_WATERMARK_KEY = 'content_launch_recovery_watermark_v1'
export const CONTENT_LEGACY_MAPPING_KEY = 'content_legacy_short_slug_mapping_v1'
export const CONTENT_LAUNCH_REGISTRATION_TIMEOUT_MS = 2 * 60 * 1_000
export const ALERT_ID_EPOCH_KEY = 'alert_id_epoch_v1'
const BEHAVIOR_LAUNCH_TRACKING_MIGRATION_KEY = 'behavior_launch_tracking_v1'

// Serialize the read-before-write migration checks across server processes.
// The immediate transaction avoids a race where two fresh processes both
// observe a missing column and then issue the same ALTER TABLE.
const migrateSchema = db.transaction(() => {
  migrateLegacyKanbanOnce()
  ensureColumn('current_cards', 'repo', 'repo TEXT')
  ensureColumn('behavior_seen', 'claim_id', "claim_id TEXT NOT NULL DEFAULT ''")
  ensureColumn('behavior_seen', 'lease_until', 'lease_until INTEGER')
  ensureColumn('behavior_seen', 'launch_behavior', 'launch_behavior TEXT')
  ensureColumn('behavior_seen', 'launch_repo', 'launch_repo TEXT')
  ensureColumn('behavior_seen', 'launch_pr', 'launch_pr INTEGER')
  ensureColumn('behavior_seen', 'launch_requested_at', 'launch_requested_at TEXT')
  ensureColumn('behavior_seen', 'launch_call_id', 'launch_call_id TEXT')
  ensureColumn('behavior_seen', 'launch_error', 'launch_error TEXT')
  ensureColumn('behavior_seen', 'launch_quarantine', 'launch_quarantine TEXT')
  ensureColumn('behavior_seen', 'launch_quarantine_may_run', 'launch_quarantine_may_run INTEGER NOT NULL DEFAULT 1')
  ensureColumn('behavior_seen', 'launch_outcome', 'launch_outcome TEXT')
  ensureColumn('behavior_seen', 'launch_completed_at', 'launch_completed_at TEXT')
  ensureColumn('behavior_seen', 'launch_head_sha', 'launch_head_sha TEXT')
  ensureColumn('behavior_seen', 'launch_expected_head', 'launch_expected_head TEXT')
  ensureColumn('behavior_seen', 'launch_actor', 'launch_actor TEXT')
  ensureColumn('behavior_seen', 'launch_source', 'launch_source TEXT')
  ensureColumn('behavior_seen', 'launch_correlation_id', 'launch_correlation_id TEXT')
  ensureColumn('behavior_seen', 'launch_action', 'launch_action TEXT')
  ensureColumn('behavior_seen', 'launch_covers', 'launch_covers TEXT')
  ensureColumn('behavior_dead_letters', 'retired_at', 'retired_at TEXT')
  ensureColumn('behavior_dead_letters', 'resolution', 'resolution TEXT')
  ensureColumn('behavior_dead_letters', 'resolution_evidence', 'resolution_evidence TEXT')
  ensureColumn('behavior_dead_letters', 'resolved_at', 'resolved_at TEXT')
  ensureColumn('behavior_runs', 'note', 'note TEXT')
  // The ledger-aligned disposition (merged, not_ready, resolved, ...), so a
  // run stays classifiable after its firing leaves bounded ledger retention.
  // Observation only: nothing reads it to decide, retry or replay work.
  ensureColumn('behavior_runs', 'outcome', 'outcome TEXT')
  // What a notice in the page needs on top of an alert (server/alerts/notices.ts):
  // where it opens, and when the person dismissed or silenced it.
  ensureColumn('alerts', 'target', 'target TEXT')
  ensureColumn('alerts', 'dismissed_at', 'dismissed_at TEXT')
  ensureColumn('alerts', 'cause', 'cause TEXT')
  ensureColumn('alerts', 'silenced_at', 'silenced_at TEXT')
  const behaviorLaunchTrackingMigrated = db.prepare(
    'SELECT 1 FROM meta WHERE key = ?',
  ).get(BEHAVIOR_LAUNCH_TRACKING_MIGRATION_KEY)
  if (!behaviorLaunchTrackingMigrated) {
    // Earlier builds could persist an accepted detached worker only as an
    // expiring claim, without enough identity to reconcile it after restart.
    // Terminalize that uncertain generation once: skipping a retry is safer
    // than launching a duplicate review or approval.
    db.prepare(`
      UPDATE behavior_seen
      SET claim_id = '', lease_until = NULL,
          launch_error = 'legacy in-flight claim retained to prevent duplicate launch'
      WHERE claim_id <> '' AND launch_requested_at IS NULL
    `).run()
    db.prepare('INSERT INTO meta(key, value) VALUES(?, ?)').run(
      BEHAVIOR_LAUNCH_TRACKING_MIGRATION_KEY,
      new Date().toISOString(),
    )
  }
  // CREATE TABLE IF NOT EXISTS does not evolve installs that already ran an
  // earlier production-readiness build. Keep every post-v1 job field additive
  // so those databases remain bootable and retryable.
  ensureColumn('content_jobs', 'session_id', "session_id TEXT NOT NULL DEFAULT ''")
  ensureColumn('content_jobs', 'topic', "topic TEXT NOT NULL DEFAULT ''")
  ensureColumn('content_jobs', 'started_at', "started_at TEXT NOT NULL DEFAULT ''")
  ensureColumn('content_jobs', 'status', "status TEXT NOT NULL DEFAULT 'pending'")
  ensureColumn('content_jobs', 'slug', "slug TEXT NOT NULL DEFAULT ''")
  ensureColumn('content_jobs', 'response_hash', 'response_hash TEXT')
  ensureColumn('content_jobs', 'error', 'error TEXT')
  ensureColumn('content_jobs', 'article_created', 'article_created INTEGER NOT NULL DEFAULT 0')
  ensureColumn('content_jobs', 'lease_owner', 'lease_owner TEXT')
  ensureColumn('content_jobs', 'lease_expires_at', 'lease_expires_at INTEGER')
  ensureColumn('content_jobs', 'next_attempt_at', 'next_attempt_at INTEGER NOT NULL DEFAULT 0')
  ensureColumn('content_jobs', 'error_count', 'error_count INTEGER NOT NULL DEFAULT 0')
  ensureColumn('content_jobs', 'created_at', "created_at TEXT NOT NULL DEFAULT ''")
  ensureColumn('content_jobs', 'updated_at', "updated_at TEXT NOT NULL DEFAULT ''")
  ensureColumn('content_jobs', 'completed_at', 'completed_at TEXT')
  ensureColumn(
    'content_launches',
    'registration_deadline_at',
    'registration_deadline_at INTEGER NOT NULL DEFAULT 0',
  )
  ensureColumn('content_launches', 'evidence_unreadable', 'evidence_unreadable INTEGER NOT NULL DEFAULT 0')
  const addedRecoveryEligibility = ensureColumn(
    'content_launches',
    'recovery_eligible',
    'recovery_eligible INTEGER NOT NULL DEFAULT 0',
  )
  const migrationNow = Date.now()
  db.prepare(`
    UPDATE content_launches
    SET registration_deadline_at = CASE
      WHEN CAST(strftime('%s', requested_at) AS INTEGER) > 0
        THEN (CAST(strftime('%s', requested_at) AS INTEGER) * 1000) + ?
      ELSE ?
    END
    WHERE registration_deadline_at <= 0
  `).run(
    CONTENT_LAUNCH_REGISTRATION_TIMEOUT_MS,
    migrationNow + CONTENT_LAUNCH_REGISTRATION_TIMEOUT_MS,
  )
  // A pending row from a pre-deadline build was persisted only after Poise
  // committed to spawning the worker, so it remains eligible for exact log
  // correlation. New rows opt in immediately before their spawn attempt.
  if (addedRecoveryEligibility) {
    db.prepare(`
      UPDATE content_launches
      SET recovery_eligible = 1
      WHERE status = 'pending'
    `).run()
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_content_jobs_reconcile
      ON content_jobs(status, next_attempt_at, lease_expires_at);
    CREATE INDEX IF NOT EXISTS idx_content_launches_recovery
      ON content_launches(status, requested_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_content_launches_one_pending_session
      ON content_launches(session_id) WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS idx_behavior_seen_launch_claims
      ON behavior_seen(key, launch_requested_at)
      WHERE claim_id <> '' AND launch_requested_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_behavior_seen_target
      ON behavior_seen(launch_repo, launch_pr);
    CREATE INDEX IF NOT EXISTS idx_behavior_dead_letters_created
      ON behavior_dead_letters(created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_one_unresolved
      ON alerts(dedupe_key) WHERE resolved_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_alerts_created
      ON alerts(created_at);
  `)
  // Recovery may inspect agent-interface logs, but it must never claim calls
  // predating the feature installation. The first migration timestamp is a
  // permanent lower bound in addition to each intent's requested_at value.
  db.prepare('INSERT OR IGNORE INTO meta(key, value) VALUES(?, ?)').run(
    CONTENT_LAUNCH_RECOVERY_WATERMARK_KEY,
    new Date().toISOString(),
  )
  // Alert ids carry this database's own prefix. A device remembers the ids it
  // has shown; were this database ever replaced, its new alerts must not reuse
  // those ids and be taken for alerts already shown.
  db.prepare('INSERT OR IGNORE INTO meta(key, value) VALUES(?, ?)').run(
    ALERT_ID_EPOCH_KEY,
    randomBytes(6).toString('hex'),
  )
  // Old releases persisted a classic GitHub PAT in plaintext. It is no
  // longer read, and retaining it would keep an unnecessary credential on
  // disk forever. Content tables remain non-destructive; this retired secret
  // is the deliberate exception.
  db.prepare("DELETE FROM meta WHERE key = 'github_token'").run()
})
migrateSchema.immediate()

// Earlier builds (and earlier runs of this migration branch) may already
// have logically deleted github_token while its bytes remained in free
// pages. Rebuild the database once, outside any transaction, then truncate
// the WAL before recording completion. No retired credential value is read.
const SECURE_DELETE_REBUILD_KEY = 'schema_secure_delete_rebuild_v1'
const secureDeleteRebuilt = db.prepare(
  'SELECT value FROM meta WHERE key = ?',
).pluck().get(SECURE_DELETE_REBUILD_KEY)
if (secureDeleteRebuilt !== 'complete') {
  db.exec('VACUUM')
  db.pragma('wal_checkpoint(TRUNCATE)')
  db.prepare(
    'INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(SECURE_DELETE_REBUILD_KEY, 'complete')
  db.pragma('wal_checkpoint(TRUNCATE)')
}

// Older mirror tables are ignored, not dropped. Keeping dormant content is
// cheap and makes schema initialization safe to repeat.

export function getMeta(key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
  return row ? row.value : null
}

export function setMeta(key: string, value: string): void {
  db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}

// ── Behavior dedupe (atomic across runtimes) ──────────────────────────
// These functions are tiny wrappers around behavior_seen so any
// server module that needs the ledger can use them without re-deriving
// the schema or the locking semantics.

// Atomically claim a (key, target) pair. Returns true if this caller
// inserted a new row (i.e. nobody had claimed it yet — caller should
// proceed with the side effect). Returns false if the row already
// existed (caller must skip). Race-safe: SQLite serializes concurrent
// INSERT OR IGNORE statements, so out of N callers exactly ONE gets
// `true` for any given (key, target).
export function claimSeen(key: string, target: string): boolean {
  const info = db.prepare(
    'INSERT OR IGNORE INTO behavior_seen(key, target, seen_at) VALUES(?, ?, ?)'
  ).run(key, target, new Date().toISOString())
  return info.changes === 1
}

// Claim with a unique owner token. Detached workers retain the token so a
// late failure can only release the exact generation it launched. This
// prevents an old worker from deleting a newer claim after disable/re-enable.
const DEFAULT_CLAIM_LEASE_MS = 2 * 60 * 60 * 1000

export type BehaviorAgentLaunch = 'pr_review' | 'pr_approve' | 'issue_review'

export interface BehaviorLaunchClaim {
  key: string
  target: string
  seenAt: string
  claimId: string
  leaseUntil: number | null
  launchBehavior: BehaviorAgentLaunch
  launchRepo: string
  launchPr: number
  launchRequestedAt: string
  launchCallId: string | null
  launchError: string | null
  launchQuarantine: 'invalid_result' | 'unreadable' | null
  launchQuarantineMayRun: boolean
  // A pull-request launch pins the head it reviews; an issue review has none
  // and stores the empty string.
  launchExpectedHead: string
  launchActor: string
  launchSource: string
  launchCorrelationId: string
  // The sub-issues an issue review also comments on, as they stood at its
  // launch; empty for every other launch.
  launchCovers: string[]
}

const MAX_LAUNCH_COVERS = 1_000
const ISSUE_REFERENCE_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}#[1-9][0-9]{0,9}$/

function parseLaunchCovers(value: string | null): string[] {
  if (!value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed)
      ? parsed.filter((issue): issue is string => typeof issue === 'string' && ISSUE_REFERENCE_PATTERN.test(issue))
      : []
  } catch {
    return []
  }
}

export function claimSeenOwned(
  key: string,
  target: string,
  leaseMs: number = DEFAULT_CLAIM_LEASE_MS,
): string | null {
  return claimSeenOwnedAs(key, target, randomUUID(), leaseMs)
}

export function claimSeenOwnedAs(
  key: string,
  target: string,
  claimId: string,
  leaseMs: number = DEFAULT_CLAIM_LEASE_MS,
): string | null {
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new Error('leaseMs must be a positive integer')
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(claimId)) {
    throw new Error('claimId must be a stable operation identifier')
  }
  const now = Date.now()
  const info = db.prepare(
    `INSERT INTO behavior_seen(key, target, seen_at, claim_id, lease_until)
     VALUES(?, ?, ?, ?, ?)
     ON CONFLICT(key, target) DO UPDATE SET
       seen_at = excluded.seen_at,
       claim_id = excluded.claim_id,
       lease_until = excluded.lease_until,
       launch_behavior = NULL,
       launch_repo = NULL,
       launch_pr = NULL,
       launch_requested_at = NULL,
       launch_call_id = NULL,
       launch_error = NULL,
       launch_quarantine = NULL,
       launch_quarantine_may_run = 1,
       launch_outcome = NULL,
       launch_completed_at = NULL,
       launch_head_sha = NULL,
       launch_expected_head = NULL,
       launch_actor = NULL,
       launch_source = NULL,
       launch_correlation_id = NULL,
       launch_action = NULL,
       launch_covers = NULL
     WHERE behavior_seen.claim_id <> ''
       AND behavior_seen.lease_until IS NOT NULL
       AND behavior_seen.lease_until <= ?
       AND behavior_seen.launch_requested_at IS NULL`
  ).run(key, target, new Date(now).toISOString(), claimId, now + leaseMs, now)
  return info.changes === 1 ? claimId : null
}

export function claimPrOperationOwned(target: string, leaseMs: number): string | null {
  return claimSeenOwned('pr-operation', target, leaseMs)
}

export function renewPrOperationOwned(claimId: string, leaseMs: number): boolean {
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new Error('leaseMs must be a positive integer')
  const info = db.prepare(`
    UPDATE behavior_seen
    SET lease_until = ?
    WHERE key = 'pr-operation' AND claim_id = ? AND claim_id <> ''
  `).run(Date.now() + leaseMs, claimId)
  return info.changes === 1
}

export function releasePrOperationOwned(claimId: string): boolean {
  const info = db.prepare(`
    DELETE FROM behavior_seen
    WHERE key = 'pr-operation' AND claim_id = ? AND claim_id <> ''
  `).run(claimId)
  return info.changes === 1
}

export function markBehaviorLaunchIntentOwned(input: {
  key: string
  target: string
  claimId: string
  launchBehavior: BehaviorAgentLaunch
  repo: string
  pr: number
  requestedAt: string
  expectedHead: string
  actor: string
  source: string
  correlationId: string
  replacesFailedCallId?: string
  // Issue reviews only: the sub-issues this launch also comments on.
  covers?: readonly string[]
  leaseMs?: number
}): boolean {
  const leaseMs = input.leaseMs ?? DEFAULT_CLAIM_LEASE_MS
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new Error('leaseMs must be a positive integer')
  if (!['pr_review', 'pr_approve', 'issue_review'].includes(input.launchBehavior)) {
    throw new Error('invalid behavior launch type')
  }
  if (!input.repo || input.repo.length > 512) throw new Error('invalid behavior launch repo')
  if (!Number.isSafeInteger(input.pr) || input.pr <= 0) throw new Error('invalid behavior launch PR')
  if (!Number.isFinite(Date.parse(input.requestedAt))) throw new Error('invalid behavior launch timestamp')
  if (input.launchBehavior === 'issue_review' ? input.expectedHead !== '' : !/^[0-9a-f]{40}$/.test(input.expectedHead)) {
    throw new Error('invalid behavior expected head')
  }
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?$/.test(input.actor)) {
    throw new Error('invalid behavior actor')
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(input.source)) {
    throw new Error('invalid behavior source')
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.correlationId)) {
    throw new Error('invalid behavior correlation id')
  }
  if (input.replacesFailedCallId !== undefined
    && (input.key !== 'approve-prs' || input.launchBehavior !== 'pr_approve' || input.source !== 'poise:approve-prs'
      || !/^[0-9a-f]{32}$/.test(input.replacesFailedCallId) || input.claimId !== input.correlationId)) {
    throw new Error('invalid failed approval replacement')
  }
  if ((input.covers?.length ?? 0) > 0 && input.launchBehavior !== 'issue_review') {
    throw new Error('only an issue review covers sub-issues')
  }
  // What a launch covers only holds other launches back, so a malformed entry
  // is dropped rather than failing the launch.
  const covers = [...new Set((input.covers ?? []).filter((issue) => ISSUE_REFERENCE_PATTERN.test(issue)))]
    .slice(0, MAX_LAUNCH_COVERS)
  const info = db.prepare(`
    UPDATE behavior_seen
    SET claim_id = ?, launch_behavior = ?, launch_repo = ?, launch_pr = ?,
        launch_requested_at = ?, launch_call_id = NULL, launch_error = NULL, launch_quarantine = NULL,
        launch_quarantine_may_run = 1,
        launch_outcome = NULL, launch_completed_at = NULL, launch_head_sha = NULL,
        launch_expected_head = ?, launch_actor = ?, launch_source = ?,
        launch_correlation_id = ?, launch_action = NULL, launch_covers = ?,
        lease_until = ?
    WHERE key = ? AND target = ? AND (
      (? IS NULL AND claim_id = ? AND claim_id <> '')
      OR (? IS NOT NULL AND key = 'approve-prs' AND claim_id = ''
        AND launch_call_id = ? AND launch_expected_head = ?
        AND launch_behavior = 'pr_approve' AND launch_repo = ? AND launch_pr = ?
        AND lower(launch_actor) = lower(?) AND launch_source = 'poise:approve-prs'
        AND launch_error IS NOT NULL AND launch_outcome IS NULL AND launch_quarantine IS NULL)
    )
    -- A live replay reservation fences this target atomically with the
    -- claim: an admitted replay is preparing to spawn, and a scheduler
    -- worker now would duplicate it. Issue reviews never reserve, so the
    -- predicate passes them through.
    AND NOT EXISTS (
      SELECT 1 FROM behavior_replay_reservations AS reservation
      WHERE reservation.repo = ? AND reservation.pr = ?
        AND reservation.behavior = ? AND reservation.expires_at >= ?
    )
  `).run(
    input.claimId,
    input.launchBehavior,
    input.repo,
    input.pr,
    input.requestedAt,
    input.expectedHead,
    input.actor,
    input.source,
    input.correlationId,
    covers.length > 0 ? JSON.stringify(covers) : null,
    Date.now() + leaseMs,
    input.key,
    input.target,
    input.replacesFailedCallId ?? null,
    input.claimId,
    input.replacesFailedCallId ?? null,
    input.replacesFailedCallId ?? null,
    input.expectedHead,
    input.repo,
    input.pr,
    input.actor,
    input.repo,
    input.pr,
    input.launchBehavior,
    new Date().toISOString(),
  )
  return info.changes === 1
}

export function listBehaviorLaunchClaims(key: string): BehaviorLaunchClaim[] {
  const rows = db.prepare(`
    SELECT key, target, seen_at, claim_id, lease_until, launch_behavior,
           launch_repo, launch_pr, launch_requested_at, launch_call_id, launch_error, launch_quarantine, launch_quarantine_may_run,
           launch_expected_head, launch_actor, launch_source, launch_correlation_id,
           launch_covers
    FROM behavior_seen
    WHERE key = ? AND claim_id <> '' AND launch_requested_at IS NOT NULL
    ORDER BY launch_requested_at, target
  `).all(key) as Array<{
    key: string
    target: string
    seen_at: string
    claim_id: string
    lease_until: number | null
    launch_behavior: BehaviorAgentLaunch
    launch_repo: string
    launch_pr: number
    launch_requested_at: string
    launch_call_id: string | null
    launch_error: string | null
    launch_quarantine: BehaviorLaunchClaim['launchQuarantine']
    launch_quarantine_may_run: number
    launch_expected_head: string
    launch_actor: string
    launch_source: string
    launch_correlation_id: string
    launch_covers: string | null
  }>
  return rows.map((row) => ({
    key: row.key,
    target: row.target,
    seenAt: row.seen_at,
    claimId: row.claim_id,
    leaseUntil: row.lease_until,
    launchBehavior: row.launch_behavior,
    launchRepo: row.launch_repo,
    launchPr: row.launch_pr,
    launchRequestedAt: row.launch_requested_at,
    launchCallId: row.launch_call_id,
    launchError: row.launch_error,
    launchQuarantine: row.launch_quarantine,
    launchQuarantineMayRun: row.launch_quarantine_may_run !== 0,
    launchExpectedHead: row.launch_expected_head,
    launchActor: row.launch_actor,
    launchSource: row.launch_source,
    launchCorrelationId: row.launch_correlation_id,
    launchCovers: parseLaunchCovers(row.launch_covers),
  }))
}

export function getFailedBehaviorLaunch(
  key: string,
  target: string,
): BehaviorLaunchClaim | null {
  const row = db.prepare(`
    SELECT key, target, seen_at, claim_id, lease_until, launch_behavior,
           launch_repo, launch_pr, launch_requested_at, launch_call_id, launch_error, launch_quarantine, launch_quarantine_may_run,
           launch_expected_head, launch_actor, launch_source, launch_correlation_id,
           launch_covers
    FROM behavior_seen
    WHERE key = ? AND target = ? AND claim_id = ''
      AND launch_requested_at IS NOT NULL
      AND launch_call_id IS NOT NULL
      AND launch_error IS NOT NULL
      AND launch_outcome IS NULL
  `).get(key, target) as {
    key: string
    target: string
    seen_at: string
    claim_id: string
    lease_until: number | null
    launch_behavior: BehaviorAgentLaunch
    launch_repo: string
    launch_pr: number
    launch_requested_at: string
    launch_call_id: string
    launch_error: string
    launch_quarantine: BehaviorLaunchClaim['launchQuarantine']
    launch_quarantine_may_run: number
    launch_expected_head: string
    launch_actor: string
    launch_source: string
    launch_correlation_id: string
    launch_covers: string | null
  } | undefined
  return row ? {
    key: row.key,
    target: row.target,
    seenAt: row.seen_at,
    claimId: row.claim_id,
    leaseUntil: row.lease_until,
    launchBehavior: row.launch_behavior,
    launchRepo: row.launch_repo,
    launchPr: row.launch_pr,
    launchRequestedAt: row.launch_requested_at,
    launchCallId: row.launch_call_id,
    launchError: row.launch_error,
    launchQuarantine: row.launch_quarantine,
    launchQuarantineMayRun: row.launch_quarantine_may_run !== 0,
    launchExpectedHead: row.launch_expected_head,
    launchActor: row.launch_actor,
    launchSource: row.launch_source,
    launchCorrelationId: row.launch_correlation_id,
    launchCovers: parseLaunchCovers(row.launch_covers),
  } : null
}

export function releaseFailedBehaviorLaunch(
  key: string,
  target: string,
  callId: string,
  expectedHead: string,
): boolean {
  const info = db.prepare(`
    DELETE FROM behavior_seen
    WHERE key = ? AND target = ? AND claim_id = ''
      AND launch_call_id = ? AND launch_expected_head = ?
      AND launch_error IS NOT NULL AND launch_outcome IS NULL
  `).run(key, target, callId, expectedHead)
  return info.changes === 1
}

export function completeFailedBehaviorReplay(input: {
  key: string, target: string, failedCallId: string, headSha: string,
  callId: string, correlationId: string, startedAt: string, completedAt: string,
  action: BehaviorLaunchAction, outcome: BehaviorLaunchOutcome,
}): boolean {
  return db.prepare(`
    UPDATE behavior_seen
    SET seen_at = ?, launch_error = NULL, launch_call_id = ?,
        launch_source = 'poise:replay', launch_correlation_id = ?,
        launch_requested_at = ?, launch_completed_at = ?, launch_head_sha = ?,
        launch_action = ?, launch_outcome = ?
    WHERE key = ? AND target = ? AND claim_id = ''
      AND launch_call_id = ? AND launch_expected_head = ?
      AND launch_error IS NOT NULL AND launch_outcome IS NULL
      AND launch_quarantine IS NULL
      AND NOT EXISTS (SELECT 1 FROM behavior_seen WHERE launch_call_id = ?)
  `).run(new Date().toISOString(), input.callId, input.correlationId,
    input.startedAt, input.completedAt, input.headSha, input.action, input.outcome,
    input.key, input.target, input.failedCallId, input.headSha, input.callId).changes === 1
}

export function linkBehaviorLaunchCallOwned(
  key: string,
  target: string,
  claimId: string,
  callId: string,
): boolean {
  if (!/^[0-9a-fA-F]{32}$/.test(callId)) throw new Error('invalid behavior launch call id')
  const normalizedCallId = callId.toLowerCase()
  const info = db.prepare(`
    UPDATE behavior_seen
    SET launch_call_id = ?,
        launch_error = CASE WHEN launch_quarantine = 'invalid_result' THEN launch_error ELSE NULL END
    WHERE key = ? AND target = ? AND claim_id = ? AND claim_id <> ''
      AND (launch_call_id IS NULL OR launch_call_id = ?)
  `).run(normalizedCallId, key, target, claimId, normalizedCallId)
  return info.changes === 1
}

// Quarantine is evidence, separate from the current diagnostic message. A
// stronger invalid-result hold cannot be weakened by a later unreadable feed.
export function quarantineBehaviorLaunchOwned(
  key: string,
  target: string,
  claimId: string,
  kind: 'invalid_result' | 'unreadable',
  error: string,
  mayRun = true,
): boolean {
  const info = db.prepare(`
    UPDATE behavior_seen
    SET launch_quarantine_may_run = CASE WHEN launch_quarantine IS NULL THEN ? ELSE MAX(launch_quarantine_may_run, ?) END,
        launch_quarantine = CASE WHEN launch_quarantine = 'invalid_result' THEN launch_quarantine ELSE ? END,
        launch_error = CASE WHEN launch_quarantine = 'invalid_result' THEN launch_error ELSE ? END
    WHERE key = ? AND target = ? AND claim_id = ? AND claim_id <> ''
      AND launch_requested_at IS NOT NULL
  `).run(Number(mayRun), Number(mayRun), kind, error.slice(0, 4_000), key, target, claimId)
  return info.changes === 1
}

// Only a readable record linked to this exact launch may restore ordinary
// reconciliation. Proven invalid terminal evidence is never cleared here.
export function clearUnreadableBehaviorLaunchOwned(
  key: string,
  target: string,
  claimId: string,
  callId: string,
): boolean {
  const info = db.prepare(`
    UPDATE behavior_seen
    SET launch_quarantine = NULL, launch_error = NULL, launch_quarantine_may_run = 1
    WHERE key = ? AND target = ? AND claim_id = ? AND claim_id <> ''
      AND launch_call_id = ? AND launch_quarantine = 'unreadable'
  `).run(key, target, claimId, callId)
  return info.changes === 1
}

export function setBehaviorLaunchErrorOwned(
  key: string,
  target: string,
  claimId: string,
  error: string | null,
): boolean {
  const info = db.prepare(`
    UPDATE behavior_seen
    SET launch_error = CASE WHEN launch_quarantine = 'invalid_result' THEN launch_error ELSE ? END
    WHERE key = ? AND target = ? AND claim_id = ? AND claim_id <> ''
  `).run(error ? error.slice(0, 4_000) : null, key, target, claimId)
  return info.changes === 1
}

export function renewSeenOwned(
  key: string,
  target: string,
  claimId: string,
  leaseMs: number = DEFAULT_CLAIM_LEASE_MS,
): boolean {
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new Error('leaseMs must be a positive integer')
  const info = db.prepare(`
    UPDATE behavior_seen
    SET lease_until = ?
    WHERE key = ? AND target = ? AND claim_id = ? AND claim_id <> ''
  `).run(Date.now() + leaseMs, key, target, claimId)
  return info.changes === 1
}

// Mark a target as seen WITHOUT signalling "newly claimed" — used by
// the snapshot path where we just want to populate the ledger with
// current state so subsequent ticks don't fire on existing items.
export function recordSeen(key: string, target: string): void {
  db.prepare(
    'INSERT OR IGNORE INTO behavior_seen(key, target, seen_at) VALUES(?, ?, ?)'
  ).run(key, target, new Date().toISOString())
}

// Release a claim when its side effect could not be launched. The exact
// target predicate prevents one failed worker from clearing another target.
export function releaseSeen(key: string, target: string): void {
  db.prepare('DELETE FROM behavior_seen WHERE key = ? AND target = ?').run(key, target)
}

export function releaseSeenOwned(key: string, target: string, claimId: string): boolean {
  return db.transaction(() => {
    const info = db.prepare(
      'DELETE FROM behavior_seen WHERE key = ? AND target = ? AND claim_id = ?'
    ).run(key, target, claimId)
    if (info.changes === 1) releasePrOperationOwned(claimId)
    return info.changes === 1
  })()
}

// Convert an in-flight owned claim into the durable terminal seen marker.
// The owner predicate makes a late callback harmless after lease recovery.
export function completeSeenOwned(key: string, target: string, claimId: string): boolean {
  return db.transaction(() => {
    const info = db.prepare(
      `UPDATE behavior_seen
       SET claim_id = '', lease_until = NULL, seen_at = ?
       WHERE key = ? AND target = ? AND claim_id = ?`
    ).run(new Date().toISOString(), key, target, claimId)
    if (info.changes === 1) releasePrOperationOwned(claimId)
    return info.changes === 1
  })()
}

export type ReviewLaunchOutcome = 'clean' | 'changes_requested'
export type BehaviorLaunchOutcome = ReviewLaunchOutcome | 'approved'
export type BehaviorLaunchAction = 'reviewed_clean' | 'requested_changes' | 'approved'

export function completeBehaviorLaunchOwned(input: {
  key: string
  target: string
  claimId: string
  outcome: BehaviorLaunchOutcome
  action: BehaviorLaunchAction
  completedAt: string
  headSha: string
}): boolean {
  if (!Number.isFinite(Date.parse(input.completedAt))) {
    throw new Error('invalid review completion timestamp')
  }
  if (!/^[0-9a-f]{40}$/.test(input.headSha)) {
    throw new Error('invalid review completion head SHA')
  }
  const expectedPair: Record<BehaviorLaunchAction, BehaviorLaunchOutcome> = {
    reviewed_clean: 'clean',
    requested_changes: 'changes_requested',
    approved: 'approved',
  }
  if (expectedPair[input.action] !== input.outcome) {
    throw new Error('behavior completion action/outcome mismatch')
  }
  return db.transaction(() => {
    const info = db.prepare(`
      UPDATE behavior_seen
      SET claim_id = '', lease_until = NULL, seen_at = ?, launch_error = NULL, launch_quarantine = NULL,
          launch_outcome = ?, launch_completed_at = ?, launch_head_sha = ?,
          launch_action = ?
      WHERE key = ? AND target = ? AND claim_id = ? AND claim_id <> ''
        AND launch_expected_head = ? AND COALESCE(launch_quarantine, '') <> 'invalid_result'
    `).run(
      new Date().toISOString(),
      input.outcome,
      input.completedAt,
      input.headSha,
      input.action,
      input.key,
      input.target,
      input.claimId,
      input.headSha,
    )
    if (info.changes === 1) releasePrOperationOwned(input.claimId)
    return info.changes === 1
  })()
}

/** A review or approval a behavior completed on a pull request. */
export interface CompletedBehaviorAction {
  repo: string
  pr: number
  action: BehaviorLaunchAction
  completedAt: string
}

// Only launches whose agent reported the typed result count: a launch that
// failed, never finished, or was superseded without posting did nothing on
// GitHub. A superseded run that posted is quarantined, never counted.
export function listCompletedBehaviorActions(): CompletedBehaviorAction[] {
  return (db.prepare(`
    SELECT launch_repo AS repo, launch_pr AS pr, launch_action AS action, launch_completed_at AS completedAt
    FROM behavior_seen
    WHERE launch_behavior IN ('pr_review', 'pr_approve')
      AND launch_completed_at IS NOT NULL
      AND (launch_action, launch_outcome) IN (
        VALUES ('reviewed_clean', 'clean'), ('requested_changes', 'changes_requested'), ('approved', 'approved'))
  `).all() as CompletedBehaviorAction[])
}

// How many change-request rounds a pull request has completed: the initial
// review counts once however wide its panel, and every approve-prs follow-up
// counts — including follow-ups on an unchanged head, which author replies
// re-arm without a new commit. Only launches that reconciled cleanly count:
// failed, held and quarantined runs never completed, and neither do manual
// reviews nor superseded runs that posted nothing. A superseded run that
// posted is quarantined for a person instead of being silently released. The
// review-round cap reads this at launch time.
export function countReviewRounds(repo: string, pr: number): number {
  const row = db.prepare(`
    SELECT
      COUNT(DISTINCT CASE WHEN key = 'review-new-prs' THEN launch_head_sha END)
      + COUNT(CASE WHEN key = 'approve-prs' THEN 1 END) AS n
    FROM behavior_seen
    WHERE claim_id = '' AND launch_error IS NULL AND launch_quarantine IS NULL
      AND launch_repo = ? AND launch_pr = ?
      AND launch_action = 'requested_changes' AND launch_outcome = 'changes_requested'
      AND (
        (key = 'review-new-prs' AND launch_behavior = 'pr_review'
          AND launch_source IN ('poise:review-new-prs', 'poise:replay'))
        OR (key = 'approve-prs' AND launch_behavior = 'pr_approve'
          AND launch_source IN ('poise:approve-prs', 'poise:replay'))
      )
      AND launch_requested_at IS NOT NULL
      AND launch_call_id IS NOT NULL AND launch_call_id <> ''
      AND launch_completed_at IS NOT NULL AND launch_expected_head = launch_head_sha
  `).get(repo, pr) as { n: number }
  return row.n
}

// An issue review ends in comments rather than a review on a head.
export function completeIssueReviewLaunchOwned(input: {
  key: string
  target: string
  claimId: string
  completedAt: string
}): boolean {
  if (!Number.isFinite(Date.parse(input.completedAt))) {
    throw new Error('invalid issue review completion timestamp')
  }
  const info = db.prepare(`
    UPDATE behavior_seen
    SET claim_id = '', lease_until = NULL, seen_at = ?, launch_error = NULL, launch_quarantine = NULL,
        launch_outcome = 'commented', launch_completed_at = ?, launch_head_sha = NULL,
        launch_action = 'commented'
    WHERE key = ? AND target = ? AND claim_id = ? AND claim_id <> ''
      AND launch_behavior = 'issue_review' AND COALESCE(launch_quarantine, '') <> 'invalid_result'
  `).run(new Date().toISOString(), input.completedAt, input.key, input.target, input.claimId)
  return info.changes === 1
}

// A claim taken but never launched — its process died before recording the
// launch — whose lease has run out, so a new claim may take the target over.
export function hasExpiredPreLaunchClaim(key: string, target: string): boolean {
  return !!db.prepare(`
    SELECT 1 FROM behavior_seen
    WHERE key = ? AND target = ? AND claim_id <> ''
      AND launch_requested_at IS NULL
      AND lease_until IS NOT NULL AND lease_until <= ?
  `).get(key, target, Date.now())
}

// Count launch attempts, not multiple diagnostics about the same attempt.
export function countBehaviorDeadLetters(behavior: string, target: string): number {
  const row = db.prepare(
    'SELECT COUNT(DISTINCT COALESCE(correlation_id, id)) AS n FROM behavior_dead_letters WHERE behavior = ? AND target = ?',
  ).get(behavior, target) as { n: number }
  return row.n
}

export function completeReviewLaunchOwned(input: {
  key: string
  target: string
  claimId: string
  outcome: ReviewLaunchOutcome
  completedAt: string
  headSha: string
}): boolean {
  return completeBehaviorLaunchOwned({
    ...input,
    headSha: input.headSha.toLowerCase(),
    action: input.outcome === 'clean' ? 'reviewed_clean' : 'requested_changes',
  })
}

export type DeadLetterDisposition = 'resolved' | 'superseded' | 'held'

export interface BehaviorDeadLetter {
  id: string
  behavior: string
  target: string
  repo: string | null
  pr: number | null
  actor: string | null
  source: string | null
  correlationId: string | null
  callId: string | null
  error: string
  createdAt: string
  resolution: DeadLetterDisposition | null
  resolutionEvidence: string | null
  resolvedAt: string | null
  attemptCount?: number
}

export function recordBehaviorDeadLetter(
  claim: BehaviorLaunchClaim,
  error: string,
  callId: string | null = claim.launchCallId,
): string {
  const id = randomUUID()
  const createdAt = new Date().toISOString()
  db.prepare(`
    INSERT INTO behavior_dead_letters(
      id, behavior, target, repo, pr, actor, source, correlation_id,
      call_id, error, created_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    claim.key,
    claim.target,
    claim.launchRepo || null,
    claim.launchPr || null,
    claim.launchActor || null,
    claim.launchSource || null,
    claim.launchCorrelationId || null,
    callId,
    String(error).slice(-4_000),
    createdAt,
  )
  return id
}

export function retireBehaviorDeadLettersForTarget(behavior: string, target: string): number {
  return db.prepare(`
    UPDATE behavior_dead_letters
    SET retired_at = ?
    WHERE behavior = ? AND target = ? AND retired_at IS NULL
  `).run(new Date().toISOString(), behavior, target).changes
}

export function retireBehaviorDeadLetter(id: string): boolean {
  return db.prepare(`
    UPDATE behavior_dead_letters
    SET retired_at = ?
    WHERE id = ? AND retired_at IS NULL
  `).run(new Date().toISOString(), id).changes === 1
}

// Retires the dead letters of the given behaviors whose target is no longer
// open. Each behavior passes only what it lists: an open pull request says
// nothing about an issue, and the reverse.
export function retireBehaviorDeadLettersForClosedPrs(
  openTargets: ReadonlySet<string>,
  behaviors: readonly string[] = ['review-new-prs', 'approve-prs'],
  organization?: string,
  unreadRepositories?: ReadonlySet<string>,
): number {
  const rows = (db.prepare(`
    SELECT id, behavior, repo, pr
    FROM behavior_dead_letters AS dead
    WHERE retired_at IS NULL AND repo IS NOT NULL AND pr IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM behavior_seen AS held
        WHERE held.key = dead.behavior AND held.target = dead.target
          AND held.launch_quarantine IS NOT NULL
      )
  `).all() as Array<{ id: string, behavior: string, repo: string, pr: number }>)
    .filter((row) => behaviors.includes(row.behavior)
      && !unreadRepositories?.has(row.repo)
      && (organization === undefined || row.repo.split('/')[0].toLowerCase() === organization.toLowerCase()))
  const retire = db.prepare(`
    UPDATE behavior_dead_letters SET retired_at = ?
    WHERE id = ? AND retired_at IS NULL
  `)
  const retiredAt = new Date().toISOString()
  return db.transaction(() => rows.reduce((count, row) => {
    if (openTargets.has(`${row.repo}#${row.pr}`)) return count
    return count + retire.run(retiredAt, row.id).changes
  }, 0))()
}

export interface DeadLetterReplacement {
  correlationId: string | null
  target: string
  expectedHead: string | null
  requestedAt: string | null
  callId: string | null
  outcome: string | null
  completedAt: string | null
  headSha: string | null
}

export interface DeadLetterReconcileResult {
  id: string
  behavior: string
  target: string
  correlationId: string | null
  disposition: DeadLetterDisposition
  reason: string
  replacement?: DeadLetterReplacement
}

// One reconcile pass over the raw dead-letter inventory. Each open row is
// resolved (a later completion settled its own request), superseded (its
// pull request or issue closed, or a replacement request took over), or
// explicitly held with the reason recorded. Nothing is deleted: resolved
// and superseded rows retire with their evidence, held rows stay open.
// Unseen rows first, then least-recently rechecked, in bounded batches, so
// a capped pass resumes where the previous one stopped and re-expired holds
// cannot starve newer rows; a hold is re-recorded at most hourly so repeats
// stay quiet.
export function reconcileBehaviorDeadLetters(
  openTargets: ReadonlySet<string>,
  behaviors: readonly string[] = ['review-new-prs', 'approve-prs'],
  organization?: string,
  unreadRepositories?: ReadonlySet<string>,
  limit = 200,
  nowMs = Date.now(),
): DeadLetterReconcileResult[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new Error('reconcile limit must be between 1 and 500')
  }
  if (behaviors.length === 0) return []
  const now = new Date(nowMs).toISOString()
  const holdCutoff = new Date(nowMs - 60 * 60_000).toISOString()
  // The behavior scope is part of the query: filtering after LIMIT would
  // let old rows for other behaviors starve this pass forever.
  const rows = db.prepare(`
    SELECT id, behavior, target, repo, pr, correlation_id, call_id, error, created_at
    FROM behavior_dead_letters AS dead
    WHERE dead.retired_at IS NULL
      AND (? IS NULL OR lower(substr(COALESCE(dead.repo, dead.target), 1, instr(COALESCE(dead.repo, dead.target), '/') - 1)) = ?)
      AND dead.behavior IN (${behaviors.map(() => '?').join(', ')})
      AND (dead.resolution IS NULL OR dead.resolved_at IS NULL OR dead.resolved_at < ?)
    ORDER BY CASE WHEN dead.resolution IS NULL THEN 0 ELSE 1 END ASC,
      dead.resolved_at ASC, dead.created_at ASC, dead.id ASC
    LIMIT ?
  `).all(organization ?? null, organization?.toLowerCase() ?? null, ...behaviors, holdCutoff, limit) as Array<{
    id: string, behavior: string, target: string, repo: string | null, pr: number | null,
    correlation_id: string | null, call_id: string | null, error: string, created_at: string,
  }>
  const quarantined = db.prepare(`
    SELECT 1 FROM behavior_seen AS held
    WHERE held.key = ? AND held.target = ? AND held.launch_quarantine IS NOT NULL
  `)
  // The incident view hides a failure once its target later succeeds; the
  // pass retires exactly what that rule already hides, with the evidence
  // cited. For pull requests any completion on the PR settles the row —
  // whether a sibling slot's success may settle a required slot stays open.
  const recovered = db.prepare(`
    SELECT launch_completed_at, launch_call_id
    FROM behavior_seen AS recovered
    WHERE recovered.key = ? AND recovered.launch_repo = ? AND recovered.launch_pr = ?
      AND recovered.launch_outcome IS NOT NULL
      AND julianday(recovered.launch_completed_at) > julianday(?)
      AND (? <> 'review-new-issues' OR recovered.target = ?)
    ORDER BY recovered.launch_completed_at DESC
    LIMIT 1
  `)
  // Approval targets carry their request, so only the same request's own
  // completion resolves the row: another head's approval proves the request
  // was replaced, never that it succeeded.
  const recoveredSameRequest = db.prepare(`
    SELECT launch_completed_at, launch_call_id
    FROM behavior_seen AS recovered
    WHERE recovered.key = ? AND recovered.target = ?
      AND recovered.launch_outcome IS NOT NULL
      AND julianday(recovered.launch_completed_at) > julianday(?)
    ORDER BY recovered.launch_completed_at DESC
    LIMIT 1
  `)
  // A confirmed replacement: a newer approval request for the same pull
  // request on a different target. The obsolete firing can never complete
  // — its input is gone — so the replacement settles it as superseded,
  // whether or not the replacement itself has finished.
  const replacementRequest = db.prepare(`
    SELECT target, launch_correlation_id, launch_expected_head, launch_requested_at,
      launch_call_id, launch_outcome, launch_completed_at, launch_head_sha
    FROM behavior_seen AS replacement
    WHERE replacement.key = ? AND replacement.launch_repo = ? AND replacement.launch_pr = ?
      AND replacement.target <> ?
      AND replacement.launch_requested_at IS NOT NULL
      AND julianday(replacement.launch_requested_at) > julianday(?)
    ORDER BY replacement.launch_requested_at DESC, replacement.target ASC
    LIMIT 1
  `)
  const obsoleteRequestedAt = db.prepare(`
    SELECT launch_requested_at FROM behavior_seen
    WHERE key = ? AND target = ? AND claim_id = ''
      AND launch_requested_at IS NOT NULL AND launch_error IS NOT NULL AND launch_outcome IS NULL
  `)
  const retire = db.prepare(`
    UPDATE behavior_dead_letters
    SET retired_at = ?, resolution = ?, resolution_evidence = ?, resolved_at = ?
    WHERE id = ? AND retired_at IS NULL
  `)
  const hold = db.prepare(`
    UPDATE behavior_dead_letters
    SET resolution = 'held', resolution_evidence = ?, resolved_at = ?
    WHERE id = ? AND retired_at IS NULL
  `)
  return db.transaction(() => rows.map((row): DeadLetterReconcileResult => {
    const settle = (disposition: DeadLetterDisposition, reason: string, evidence: Record<string, unknown>,
      replacement?: DeadLetterReplacement) => {
      const encoded = JSON.stringify({ ...evidence, checkedAt: now })
      if (disposition === 'held') hold.run(encoded, now, row.id)
      else retire.run(now, disposition, encoded, now, row.id)
      return { id: row.id, behavior: row.behavior, target: row.target, correlationId: row.correlation_id,
        disposition, reason, ...(replacement ? { replacement } : {}) }
    }
    if (quarantined.get(row.behavior, row.target)) {
      return settle('held', 'quarantined claim outstanding', { callId: row.call_id })
    }
    if (row.repo !== null && row.pr !== null) {
      if (row.behavior === 'approve-prs') {
        const own = recoveredSameRequest.get(row.behavior, row.target, row.created_at) as
          { launch_completed_at: string, launch_call_id: string | null } | undefined
        if (own) {
          return settle('resolved', `later completion at ${own.launch_completed_at}`,
            { completedAt: own.launch_completed_at, callId: own.launch_call_id })
        }
        // The replacement must postdate the obsolete request; when its row
        // is gone (released or retried in place), the recorded failure stands
        // in, so only a strictly newer request settles the row.
        const obsolete = obsoleteRequestedAt.get(row.behavior, row.target) as
          { launch_requested_at: string } | undefined
        const next = replacementRequest.get(row.behavior, row.repo, row.pr, row.target,
          obsolete?.launch_requested_at ?? row.created_at) as {
          target: string, launch_correlation_id: string | null, launch_expected_head: string | null,
          launch_requested_at: string | null, launch_call_id: string | null, launch_outcome: string | null,
          launch_completed_at: string | null, launch_head_sha: string | null,
        } | undefined
        if (next) {
          const link: DeadLetterReplacement = {
            correlationId: next.launch_correlation_id, target: next.target, expectedHead: next.launch_expected_head,
            requestedAt: next.launch_requested_at, callId: next.launch_call_id, outcome: next.launch_outcome,
            completedAt: next.launch_completed_at, headSha: next.launch_head_sha,
          }
          const open = unreadRepositories?.has(row.repo) ? null : openTargets.has(`${row.repo}#${row.pr}`)
          return settle('superseded',
            `replaced by request ${next.launch_correlation_id ?? next.target}`
            + ` on head ${next.launch_expected_head ?? 'unknown'} at ${next.launch_requested_at}`,
            { callId: row.call_id, open, replacedBy: link }, link)
        }
      } else {
        const completion = recovered.get(row.behavior, row.repo, row.pr, row.created_at, row.behavior, row.target) as
          { launch_completed_at: string, launch_call_id: string | null } | undefined
        if (completion) {
          return settle('resolved', `later completion at ${completion.launch_completed_at}`,
            { completedAt: completion.launch_completed_at, callId: completion.launch_call_id })
        }
      }
      if (!unreadRepositories?.has(row.repo) && !openTargets.has(`${row.repo}#${row.pr}`)) {
        return settle('superseded', `${row.repo}#${row.pr} is no longer open`, { open: false })
      }
      if (unreadRepositories?.has(row.repo)) {
        return settle('held', `${row.repo} could not be listed; target state unknown`,
          { callId: row.call_id, open: null })
      }
      return settle('held', 'no later completion; target still open', { callId: row.call_id, open: true })
    }
    return settle('held', 'row carries no repository identity; cannot verify its target',
      { callId: row.call_id })
  }))()
}

// How long an admitted replay owns its target: preparation plus spawn plus
// worker registration, with margin. Only the same behavior on the same
// target is fenced; a review and an approval replay never block each other.
export const REPLAY_RESERVATION_MS = 10 * 60_000

// Whether an admitted replay still owns its target. The scheduler checks
// this before launching, so a tick during replay preparation cannot start
// a duplicate worker for the same target.
export function replayReservationActive(repo: string, pr: number, behavior: string, nowMs = Date.now()): boolean {
  return !!db.prepare(`
    SELECT 1 FROM behavior_replay_reservations
    WHERE repo = ? AND pr = ? AND behavior = ? AND expires_at >= ?
    LIMIT 1
  `).get(repo, pr, behavior, new Date(nowMs).toISOString())
}

// Atomically reserve one replay: insert, or replace only an expired
// reservation. One statement, so concurrent admissions cannot both win.
export function reserveBehaviorReplay(repo: string, pr: number, behavior: string, nowMs = Date.now()): boolean {
  const now = new Date(nowMs).toISOString()
  const expires = new Date(nowMs + REPLAY_RESERVATION_MS).toISOString()
  const info = db.prepare(`
    INSERT INTO behavior_replay_reservations(repo, pr, behavior, created_at, expires_at)
    VALUES(?, ?, ?, ?, ?)
    ON CONFLICT(repo, pr, behavior) DO UPDATE
    SET created_at = excluded.created_at, expires_at = excluded.expires_at
    WHERE behavior_replay_reservations.expires_at < excluded.created_at
  `).run(repo, pr, behavior, now, expires)
  return info.changes === 1
}

// Release a reservation this caller holds, identified by its own stamp so
// a replacement reservation cannot be deleted by mistake.
export function releaseBehaviorReplay(
  repo: string,
  pr: number,
  behavior: string,
  createdAt: string,
): void {
  db.prepare(`
    DELETE FROM behavior_replay_reservations
    WHERE repo = ? AND pr = ? AND behavior = ? AND created_at = ?
  `).run(repo, pr, behavior, createdAt)
}

export function listBehaviorDeadLetters(limit = 50, organization?: string): BehaviorDeadLetter[] {
  return readBehaviorDeadLetters(limit, false, organization)
}

export function listBehaviorIncidents(limit = 50, organization?: string): BehaviorDeadLetter[] {
  return readBehaviorDeadLetters(limit, true, organization)
}

/** The current incident for one behavior target, independent of list limits. */
export function getBehaviorIncident(behavior: string, target: string): BehaviorDeadLetter | null {
  return readBehaviorDeadLetters(1, true, undefined, { behavior, target })[0] ?? null
}

function readBehaviorDeadLetters(
  limit: number, grouped: boolean, organization?: string,
  incident?: { behavior: string, target: string },
): BehaviorDeadLetter[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new Error('dead-letter limit must be between 1 and 500')
  }
  const rows = db.prepare(`
    WITH active AS (
    SELECT dead.*
    FROM behavior_dead_letters AS dead
    WHERE dead.retired_at IS NULL
      AND (? IS NULL OR lower(substr(COALESCE(dead.repo, dead.target), 1, instr(COALESCE(dead.repo, dead.target), '/') - 1)) = ?)
      AND (? IS NULL OR (dead.behavior = ? AND COALESCE(dead.repo || '#' || dead.pr, dead.target) = ?))
      AND NOT EXISTS (
      SELECT 1
      FROM behavior_seen AS recovered
      WHERE recovered.key = dead.behavior
        AND recovered.launch_repo = dead.repo
        AND recovered.launch_pr = dead.pr
        AND recovered.launch_outcome IS NOT NULL
        AND julianday(recovered.launch_completed_at) > julianday(dead.created_at)
        -- Each issue reviewer is its own launch: another reviewer of the same
        -- issue finishing does not settle this one's incident.
        AND (dead.behavior <> 'review-new-issues' OR recovered.target = dead.target)
        -- A completed sibling does not resolve durable uncertain evidence.
        AND NOT EXISTS (
          SELECT 1 FROM behavior_seen AS held
          WHERE held.key = dead.behavior AND held.target = dead.target
            AND held.launch_quarantine IS NOT NULL
        )
    )
    ), ranked AS (
      SELECT *,
        COUNT(*) OVER (PARTITION BY behavior, COALESCE(repo || '#' || pr, target)) AS attempt_count,
        ROW_NUMBER() OVER (
          PARTITION BY behavior, COALESCE(repo || '#' || pr, target)
          ORDER BY created_at DESC, id DESC
        ) AS rank
      FROM active
    )
    SELECT * FROM ranked WHERE ? = 0 OR rank = 1
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(organization ?? null, organization?.toLowerCase() ?? null,
    incident?.behavior ?? null, incident?.behavior ?? null, incident?.target ?? null,
    Number(grouped), limit) as Array<{
    id: string
    behavior: string
    target: string
    repo: string | null
    pr: number | null
    actor: string | null
    source: string | null
    correlation_id: string | null
    call_id: string | null
    error: string
    created_at: string
    resolution: DeadLetterDisposition | null
    resolution_evidence: string | null
    resolved_at: string | null
    attempt_count: number
  }>
  return rows.map((row) => ({
    id: row.id,
    behavior: row.behavior,
    target: row.target,
    repo: row.repo,
    pr: row.pr,
    actor: row.actor,
    source: row.source,
    correlationId: row.correlation_id,
    callId: row.call_id,
    error: row.error,
    createdAt: row.created_at,
    resolution: row.resolution,
    resolutionEvidence: row.resolution_evidence,
    resolvedAt: row.resolved_at,
    ...(grouped ? { target: row.repo && row.pr ? `${row.repo}#${row.pr}` : row.target, attemptCount: row.attempt_count } : {}),
  }))
}

// Whether any rows exist for this behavior — proxy for "snapshot has
// been taken at least once". Used to differentiate a fresh enable
// (no rows yet → take snapshot, don't fire on first tick) from a
// running behavior (rows exist → fire on net-new targets).
export function hasSeenAny(key: string): boolean {
  const row = db.prepare(
    'SELECT 1 AS x FROM behavior_seen WHERE key = ? LIMIT 1'
  ).get(key) as { x: number } | undefined
  return !!row
}

export function hasSeen(key: string, target: string): boolean {
  const row = db.prepare(
    'SELECT 1 AS x FROM behavior_seen WHERE key = ? AND target = ?',
  ).get(key, target) as { x: number } | undefined
  return !!row
}

export function listSeenTargets(key: string): string[] {
  return (db.prepare(
    'SELECT target FROM behavior_seen WHERE key = ? ORDER BY target',
  ).all(key) as Array<{ target: string }>).map((row) => row.target)
}

export function listSnapshotOnlySeen(key: string): Array<{ target: string, seenAt: string }> {
  return (db.prepare(`
    SELECT target, seen_at
    FROM behavior_seen
    WHERE key = ?
      AND claim_id = ''
      AND launch_requested_at IS NULL
    ORDER BY target
  `).all(key) as Array<{ target: string, seen_at: string }>).map((row) => ({
    target: row.target,
    seenAt: row.seen_at,
  }))
}

export interface CompletedApprovalBasisLaunch {
  callId: string
  completedAt: string
  headSha: string
}

export function latestApprovalBasisLaunch(
  repo: string,
  pr: number,
  actor?: string,
): CompletedApprovalBasisLaunch | null {
  const row = db.prepare(`
    SELECT launch_call_id, launch_completed_at, launch_head_sha
    FROM behavior_seen
    WHERE claim_id = ''
      AND launch_repo = ?
      AND launch_pr = ?
      AND (? IS NULL OR lower(launch_actor) = lower(?))
      AND launch_error IS NULL
      AND (
        (key = 'review-new-prs'
          AND launch_behavior = 'pr_review'
          AND launch_action = 'reviewed_clean'
          AND launch_outcome = 'clean')
        OR
        (key = 'approve-prs'
          AND launch_behavior = 'pr_approve'
          AND launch_action = 'approved'
          AND launch_outcome = 'approved')
      )
      AND launch_call_id IS NOT NULL
      AND launch_completed_at IS NOT NULL
      AND launch_head_sha IS NOT NULL
    ORDER BY launch_completed_at DESC
    LIMIT 1
  `).get(repo, pr, actor ?? null, actor ?? null) as {
    launch_call_id: string
    launch_completed_at: string
    launch_head_sha: string
  } | undefined
  return row ? {
    callId: row.launch_call_id,
    completedAt: row.launch_completed_at,
    headSha: row.launch_head_sha,
  } : null
}

// A completed negative review proves prior inspection, never approval.
export function latestCompletedChangeRequestLaunch(
  repo: string,
  pr: number,
  actor: string,
): CompletedApprovalBasisLaunch | null {
  const row = db.prepare(`
    SELECT launch_call_id AS callId, launch_completed_at AS completedAt, launch_head_sha AS headSha
    FROM behavior_seen
    WHERE claim_id = '' AND launch_error IS NULL AND launch_quarantine IS NULL
      AND launch_repo = ? AND launch_pr = ? AND lower(launch_actor) = lower(?)
      AND launch_action = 'requested_changes' AND launch_outcome = 'changes_requested'
      AND (
        (key = 'review-new-prs' AND launch_behavior = 'pr_review'
          AND launch_source IN ('poise:review-new-prs', 'poise:replay'))
        OR (key = 'approve-prs' AND launch_behavior = 'pr_approve'
          AND launch_source IN ('poise:approve-prs', 'poise:replay'))
      )
      AND launch_requested_at IS NOT NULL
      AND launch_call_id IS NOT NULL AND launch_call_id <> ''
      AND launch_completed_at IS NOT NULL AND launch_expected_head = launch_head_sha
    ORDER BY launch_completed_at DESC LIMIT 1
  `).get(repo, pr, actor) as CompletedApprovalBasisLaunch | undefined
  return row && /^[0-9a-f]{40}$/.test(row.headSha)
    && Number.isFinite(Date.parse(row.completedAt)) ? row : null
}

// Wipe the ledger for a key — used when the user disables the
// behavior. Re-enabling will trigger a fresh snapshot.
export function clearSeen(key: string): void {
  db.prepare('DELETE FROM behavior_seen WHERE key = ?').run(key)
}

// Disabling removes snapshots/skips but retains every accepted detached launch.
// Otherwise disable/re-enable could duplicate completed work or erase the proof
// that approval must wait for a successful initial review.
export function clearSeenExceptLaunched(key: string, organization?: string): void {
  db.prepare(`
    DELETE FROM behavior_seen
    WHERE key = ?
      AND launch_requested_at IS NULL
      AND (? IS NULL OR lower(substr(target, 1, instr(target, '/') - 1)) = ?)
  `).run(key, organization ?? null, organization?.toLowerCase() ?? null)
}

// Production servers call this during graceful shutdown. Kept explicit
// rather than installing process-level signal handlers in a data module.
export function closeDatabase(): void {
  if (!db.open) return
  try {
    db.pragma('wal_checkpoint(TRUNCATE)')
  } finally {
    db.close()
  }
}
