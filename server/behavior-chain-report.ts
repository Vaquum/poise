import type { Database } from 'better-sqlite3'
import { CHAIN_OBSERVATION_MAX_AGE_MS, decideBehaviorChain, type ChainObservation } from './behavior-chain-decision'
import { chainBasis, chainIdentity, type BehaviorChain, type BehaviorChainJournal } from './behavior-chain-store'
import { resourceReleaseProven } from './behavior-resource-receipt'
import { handleGhBody, reconcileRepairReport } from './gh'
import { getBehaviorChainSettings, getSettings } from './settings'

const CAUSES = ['repair_incomplete_replies', 'repair_execution_budget_exhausted'] as const
const PREFIX = 'behavior_chain_repair_report:'
const INCOMPLETE_REPLIES = /^repair did not answer every unresolved review finding(?:: missing_root_comment_ids=\[[0-9, ]*\]; missing_count=[1-9][0-9]*; required_count=[1-9][0-9]*)?$/
const REPORT_MARKER = /<!-- poise-repair-exhaustion:[a-f0-9]{64} -->/

interface RepairReport {
  key: string
  source: string
  pull: number
  holdSequence: number
  heldAt: number
  head: string
  basis: string
  slot: string | null
  attempts: Array<{ invocation: string, call: string, completedAt: number }>
  issueNumber: number | null
}

function enabled(repository: string): boolean {
  const configured = process.env.POISE_REPAIR_EXHAUSTION_REPOSITORIES
  if (!configured?.trim()) return false
  const repositories = configured.split(',').map(value => value.trim())
  for (const value of repositories) {
    const [owner, repo, extra] = value.split('/')
    if (!owner || !repo || extra !== undefined) throw new Error('POISE_REPAIR_EXHAUSTION_REPOSITORIES requires comma-separated owner/repo names')
    chainIdentity(value, 1)
  }
  return repositories.some(value => value.toLowerCase() === repository.toLowerCase())
}

/** The normal decision still has to request repair on precisely this basis.
 * Ignore failed repairs only to ask what would be needed without exhaustion. */
function qualifyingAttempts(chain: BehaviorChain, observation: ChainObservation, now: number) {
  if (!chain.held || chain.mergeSha || !observation.issue.open || !observation.pull
    || !Number.isFinite(observation.checkedAt) || observation.checkedAt > now
    || now - observation.checkedAt > CHAIN_OBSERVATION_MAX_AGE_MS
    || !/^[a-f0-9]{64}$/.test(observation.pull.reviewRevision)
    || observation.pull.reviewRevision === chainBasis(['datastore-not-yet-indexed', chain.repository, observation.pull.number])
    || chain.invocations.some(invocation => invocation.state !== 'settled')) return null
  const decision = decideBehaviorChain({ ...chain, held: null,
    invocations: chain.invocations.filter(invocation => invocation.behavior !== 'repair-pr' || invocation.evidence?.status === 'completed'),
  }, observation, now)
  if (decision.kind !== 'invoke' || decision.behavior !== 'repair-pr') return null
  const attempts = chain.invocations.filter(invocation => invocation.behavior === 'repair-pr'
    && invocation.basis === decision.basis && invocation.slot === decision.reviewer?.slot
    && invocation.admissionSequence > chain.resumedAfterSequence && invocation.evidence?.status !== 'deferred')
  if (attempts.length < 3 || attempts.some(invocation => {
    const evidence = invocation.evidence
    const artifact = evidence?.artifact as Record<string, unknown> | null | undefined
    const argv = invocation.request.argv
    return !invocation.callId || invocation.state !== 'settled' || invocation.actor !== chain.author
      || invocation.request.context?.head !== observation.pull!.head
      || invocation.request.context.reviewRevision !== observation.pull!.reviewRevision
      || !argv.includes('--expected-issue-revision') || argv[argv.indexOf('--expected-issue-revision') + 1] !== observation.issue.revision
      || evidence?.status !== 'failed' || evidence.action !== 'not_started' || evidence.outcome !== 'preflight_failed'
      || artifact != null && (!['preparing', 'prepared', 'executing'].includes(String(artifact.phase))
        || artifact.plan_sha != null || artifact.publication_head != null || artifact.replies_started != null)
      || evidence.receipts != null || evidence.review_id != null || evidence.head_sha != null
      || typeof evidence.completedAt !== 'number' || !Number.isFinite(evidence.completedAt) || evidence.completedAt > now
      || !resourceReleaseProven(evidence, true)
  })) return null
  const cause = attempts.every(invocation => invocation.evidence?.error_code === 'atomic_work_execution_budget_exhausted')
    ? 'repair_execution_budget_exhausted'
    : attempts.every(invocation => invocation.evidence?.error_code === 'atomic_work_failed'
      && typeof invocation.evidence.error === 'string' && INCOMPLETE_REPLIES.test(invocation.evidence.error))
      ? 'repair_incomplete_replies' : null
  return cause ? { decision, attempts, cause } : null
}

/** Runs only on the existing reconciliation opportunity. The existing meta
 * store holds creation intent; neither its absence on GitHub nor a restart
 * can reopen that intent for another POST. Intake remains the normal reader. */
export async function reportRepairExhaustion(db: Database, journal: BehaviorChainJournal, chain: BehaviorChain,
  verify: () => Promise<ChainObservation>, allowed: () => boolean): Promise<string | null> {
  if (!enabled(chain.repository) || !allowed() || !chain.held) return null
  const observation = chain.observation as ChainObservation | null
  if (!observation?.pull) return null
  const qualifying = qualifyingAttempts(chain, observation, Date.now())
  const intents = CAUSES.map(cause => {
    const key = chainBasis([cause, chain.id, observation.pull!.number])
    const storageKey = PREFIX + key
    const stored = db.prepare('SELECT value FROM meta WHERE key = ?').get(storageKey) as { value: string } | undefined
    return { cause, key, storageKey, stored }
  })
  const intent = intents.find(intent => intent.cause === qualifying?.cause) ?? intents.find(intent => intent.stored)
  if (!intent) return 'Repair exhaustion reporting: hold has no verified repair exhaustion on the current basis'
  const { cause, key, storageKey, stored } = intent
  let report: RepairReport | null = stored ? JSON.parse(stored.value) as RepairReport : null
  if (report && (report.key !== key || report.source !== chain.id || report.pull !== observation.pull.number
    || report.issueNumber !== null && (!Number.isSafeInteger(report.issueNumber) || report.issueNumber < 1))) {
    throw new Error('Repair report intent conflicts with its source hold')
  }
  const marker = `<!-- poise-repair-exhaustion:${key} -->`
  const save = () => db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(JSON.stringify(report), storageKey)
  if (!report) {
    const accounts = getSettings()
    if (accounts.me.toLowerCase() !== chain.author.toLowerCase() || accounts.agentAccount.toLowerCase() !== chain.reviewer.toLowerCase()) {
      return 'Repair exhaustion reporting pending: configured accounts differ from the source chain'
    }
    if (qualifying?.cause !== cause) return 'Repair exhaustion reporting: hold has no verified repair exhaustion on the current basis'
    if (db.prepare(`SELECT 1 FROM meta WHERE key GLOB ? AND json_extract(value, '$.source') GLOB ?
      AND json_extract(value, '$.issueNumber') = ? LIMIT 1`).get(PREFIX + '*', chain.repository.toLowerCase() + '#*', chain.issue)) {
      return 'Repair exhaustion reporting suppressed for a generated remediation issue; its ordinary hold remains active'
    }
    // verify performs the existing datastore health check before re-reading
    // reviews. A fresh native head alone cannot validate local review rows.
    const fresh = await verify()
    const verified = qualifyingAttempts(chain, fresh, Date.now())
    if (verified?.cause !== cause || fresh.pull?.head !== observation.pull.head || fresh.pull.reviewRevision !== observation.pull.reviewRevision) {
      return 'Repair exhaustion reporting pending: the current head or review basis no longer verifies the exhausted attempts'
    }
    const seed = await handleGhBody({ operation: 'read_issue', repository_full_name: chain.repository, issue_number: chain.issue })
    const source = seed.body as { issue?: { body?: unknown }, error?: string }
    if (seed.status !== 200 || typeof source.issue?.body !== 'string') throw new Error(source.error || 'Repair report source issue is unavailable')
    if (REPORT_MARKER.test(source.issue.body)) return 'Repair exhaustion reporting suppressed for a generated remediation issue; its ordinary hold remains active'
    const existing = await reconcileRepairReport(chain.repository, marker, null)
    const current = journal.read(chain.id)
    if (!current?.held || current.resumedAfterSequence !== chain.resumedAfterSequence || current.sequence !== chain.sequence
      || qualifyingAttempts(chain, fresh, Date.now())?.cause !== cause) {
      return 'Repair exhaustion reporting pending: source hold changed during verification'
    }
    const verifiedAccounts = getSettings()
    if (verifiedAccounts.me.toLowerCase() !== chain.author.toLowerCase()
      || verifiedAccounts.agentAccount.toLowerCase() !== chain.reviewer.toLowerCase()) {
      return 'Repair exhaustion reporting pending: configured accounts differ from the source chain'
    }
    const hold = db.prepare(`SELECT sequence, at FROM behavior_chain_events WHERE chain_id = ?
      AND json_extract(payload, '$.type') = 'chain.held' AND sequence > ? ORDER BY sequence DESC LIMIT 1`)
      .get(chain.id, chain.resumedAfterSequence) as { sequence: number, at: number } | undefined
    if (!hold) throw new Error('Repair report has no durable active hold')
    report = { key, source: chain.id, pull: observation.pull.number, holdSequence: hold.sequence, heldAt: hold.at,
      head: fresh.pull!.head, basis: verified.decision.basis, slot: verified.decision.reviewer?.slot ?? null,
      attempts: verified.attempts.map(invocation => ({ invocation: invocation.id, call: invocation.callId!, completedAt: Number(invocation.evidence!.completedAt) })),
      issueNumber: existing?.number ?? null }
    // FULL durability precedes the external effect. A competing runtime or a
    // crash after this insert may reconcile, but may never create again.
    if (db.pragma('synchronous', { simple: true }) !== 2) db.pragma('synchronous = FULL')
    const claimed = db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING').run(storageKey, JSON.stringify(report))
    if (!claimed.changes) return 'Repair exhaustion report pending: another reconciliation reserved this report'
    if (!existing) {
      if (!allowed()) return 'Repair exhaustion report creation is unconfirmed; admissions are paused'
      const budget = cause === 'repair_execution_budget_exhausted'
      const age = Math.max(0, Math.floor((Date.now() - hold.at) / 60_000))
      const body = [marker, '', `Poise is holding https://github.com/${chain.repository}/pull/${report.pull}.`, '',
        `Stage: repair-pr. Cause: ${cause}. Held since ${new Date(hold.at).toISOString()} (${age} minutes at reporting).`,
        `Source: ${chain.id}; hold event ${hold.sequence}; head ${report.head}; basis ${report.basis}; slot ${report.slot}.`, '',
        `Verified receipts: three or more settled Caller repairs on this basis after the last Resume. Each failed before publication with ${budget ? 'atomic_work_execution_budget_exhausted, action=not_started, outcome=preflight_failed' : 'atomic_work_failed, action=not_started, outcome=preflight_failed and the incomplete-reply validation cause'}; resources were released.`,
        ...report.attempts.map(attempt => `- Invocation ${attempt.invocation}; Caller ${attempt.call}; completed ${new Date(attempt.completedAt).toISOString()}.`), '',
        `Next action: inspect the repair ${budget ? 'execution budget' : 'reply validation'} and source receipts, address the cause, then explicitly Resume the source chain when appropriate. This report preserves its hold and does not recover repair or relax any review, admission or merge gate.`,
      ].join('\n')
      const result = await handleGhBody({ operation: 'open_issue', repository_full_name: chain.repository,
        title: `fix: repair exhausted ${budget ? 'execution budget' : 'incomplete review replies'} for #${report.pull}`, body, labels: ['poise'] })
      const publication = result.body as { record?: { number?: unknown, url?: unknown }, error?: string }
      if (result.status !== 200 || !Number.isSafeInteger(publication.record?.number) || Number(publication.record?.number) < 1
        || publication.record?.url !== `https://github.com/${chain.repository}/issues/${publication.record?.number}`) {
        throw new Error(`Repair report ${key} creation is unconfirmed: ${publication.error || 'no verified issue receipt'}; reconcile its marker before any further action`)
      }
      report.issueNumber = Number(publication.record.number)
      save()
    }
  }
  let issue = await reconcileRepairReport(chain.repository, marker, report.issueNumber)
  if (!issue) return 'Repair exhaustion report creation is unconfirmed; no matching issue is visible yet. Reconcile the same marker; do not create a replacement'
  if (report.issueNumber === null) { report.issueNumber = issue.number; save() }
  const link = `Repair exhaustion report ${issue.url}`
  if (issue.state === 'closed') return `${link} is closed; no replacement will be created`
  if (!issue.labels.some(label => label.toLowerCase() === 'poise') && allowed()) {
    try { issue = (await reconcileRepairReport(chain.repository, marker, issue.number, true))! }
    catch (error) { return `${link}: poise label pending: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (!issue.labels.some(label => label.toLowerCase() === 'poise')) return `${link}: admission blocked because GitHub has not applied the poise label`
  const settings = getBehaviorChainSettings()
  if (!settings.enabled) return `${link}: admission pending while behavior chains are disabled`
  if (settings.seedMode === 'label' && !issue.labels.some(label => label.toLowerCase() === settings.label.toLowerCase())) {
    return `${link}: admission blocked by saved intake label ${settings.label}; use ordinary issue intake to assign it`
  }
  const accounts = getSettings()
  if (accounts.me.toLowerCase() !== chain.author.toLowerCase() || accounts.agentAccount.toLowerCase() !== chain.reviewer.toLowerCase()) {
    return `${link}: admission blocked because configured accounts differ from the source chain`
  }
  const admitted = journal.read(chainIdentity(chain.repository, issue.number))
  return admitted ? `${link}: admitted as ${admitted.id}${admitted.held ? `; remediation is held: ${admitted.held}` : ''}`
    : `${link}: admission pending normal datastore intake and ownership gates`
}
