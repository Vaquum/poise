// Executed as a bundled child with isolated HOME/CLI configuration and the preview's fixture databases.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { startLogging, loggingRuntime, stopLogging } from '../../../server/logging'
import { temporaryStorageMeasured, TEMPORARY_STORAGE_GB } from '../../../server/temporary-storage'
import { behaviorHeld } from '../../../server/alerts/producers'
import { retireClearedBehaviorAlerts } from '../../../server/alerts/notices'
import { db, getMeta, setMeta, recordBehaviorDeadLetter, retireBehaviorDeadLettersForTarget, type BehaviorLaunchClaim } from '../../../server/db'
import { normalize } from '../../../gateway/src/diagnostics/contract'
import { callerDiagnostic } from '../../../gateway/src/diagnostics/sources'
import { withNoticeDiagnosticIdentity } from '../../../server/logging-context'
import { behaviorErrorMessage } from '../../../server/behavior-diagnostics'
import { runFile } from '../../../server/process'

const mode = process.argv[2]
const repo = 'acme/notification-evidence', target = repo + '#901'
const fixture = join(process.env.POISE_NOTICE_FIXTURE_ROOT!, 'calls.json')
const cli = join(process.env.CALLER_BIN_ROOT!, 'agent-interface')
const backup = fixture + '.cli'
const before = fixture + '.meta'
const keys = ['me', 'agentAccount', 'behavior_review_new_prs_enabled', `behavior_review_new_prs_failure:${target}:check`]
if (!existsSync(before)) writeFileSync(before, JSON.stringify(Object.fromEntries(keys.map((key) => [key, getMeta(key)]))))
startLogging()
try {
  if (mode === 'storage' || mode === 'cross') {
    temporaryStorageMeasured(6 * TEMPORARY_STORAGE_GB)
    temporaryStorageMeasured(4.9 * TEMPORARY_STORAGE_GB)
  } else if (mode === 'recover') {
    temporaryStorageMeasured(6 * TEMPORARY_STORAGE_GB)
    retireBehaviorDeadLettersForTarget('review-new-prs', target)
    retireClearedBehaviorAlerts()
    const saved: Record<string, string | null> = JSON.parse(readFileSync(before, 'utf8'))
    for (const key of keys) setMeta(key, saved[key] ?? '')
    if (existsSync(backup)) writeFileSync(cli, readFileSync(backup), { mode: 0o700 })
  } else if (mode === 'prelaunch') {
    setMeta('me', 'fixture-user'); setMeta('agentAccount', 'review-bot'); setMeta('behavior_review_new_prs_enabled', '1')
    const correlationId = 'f'.repeat(32)
    try {
      await withNoticeDiagnosticIdentity({ correlationId, behavior: 'review-new-prs', repository: repo, target, account: 'review-bot' },
        () => runFile(process.execPath, ['-e', "process.stderr.write('error: prelaunch preparation unavailable');process.exit(7)"]))
    } catch (error) {
      console.error('[behaviors] preparation failed:', error)
      const now = Date.now()
      setMeta(`behavior_review_new_prs_failure:${target}:check`, JSON.stringify({ kind: 'operation', consecutiveFailures: 1,
        lastFailureAtMs: now, nextRetryAtMs: now + 60_000, error: behaviorErrorMessage(error), correlationId }))
    }
  } else {
    if (!existsSync(backup)) writeFileSync(backup, readFileSync(cli))
    const calls: Array<Record<string, unknown>> = existsSync(fixture) ? JSON.parse(readFileSync(fixture, 'utf8')) : []
    const callId = (mode === 'held-one' ? '1' : mode === 'held-two' ? '2' : '3').repeat(32)
    const correlationId = callId
    const error = mode === 'held-change' ? 'error: changed retained cause' : 'error: precise retained cause'
    const now = new Date().toISOString()
    const call = { id: callId, repo, pr_id: '901', actor: 'review-bot', behavior: 'pr_review', source: 'poise:review-new-prs', correlation_id: correlationId,
      started_at: now, completed_at: now, status: 'failed', outcome: 'preflight_failed', action: 'not_started', error, expected_head: 'a'.repeat(40), model: 'fixture',
      prompt: '', time_elapsed: '1ms', session_id: null, response: '' }
    calls.push(call); writeFileSync(fixture, JSON.stringify(calls))
    writeFileSync(cli, '#!' + process.execPath + '\nimport {readFileSync} from "node:fs"; if(process.argv[2]==="--logs") process.stdout.write(readFileSync(' + JSON.stringify(fixture) + ',"utf8"));\n', { mode: 0o700 })
    const event = normalize(callerDiagnostic(call, 'local')!)!
    loggingRuntime()!.ingest(event)
    if (mode === 'held-one') loggingRuntime()!.ingest(event) // Repeated delivery is one occurrence.
    const claim: BehaviorLaunchClaim = { key: 'review-new-prs', target, seenAt: now, claimId: correlationId, leaseUntil: null, launchBehavior: 'pr_review',
      launchRepo: repo, launchPr: 901, launchRequestedAt: now, launchExpectedHead: 'a'.repeat(40), launchActor: 'review-bot', launchSource: 'poise:review-new-prs',
      launchCorrelationId: correlationId, launchCallId: callId, launchError: null, launchQuarantine: null, launchQuarantineMayRun: false, launchCovers: [] }
    recordBehaviorDeadLetter(claim, error)
    behaviorHeld('review-new-prs', target, mode !== 'held-one', error)
  }
  loggingRuntime()!.flush()
} finally { await stopLogging(); db.close() }
