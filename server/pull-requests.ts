// The person's Approve and Merge buttons, acting with their GitHub account.
// Every call carries the browser's actionId: the receipt reserves it with a
// fingerprint of the action before anything is sent, so repeating a call
// returns the stored outcome, and a lost response reconciles against GitHub
// instead of acting twice. An unknown outcome is the record; nothing here
// depends on diagnostics.
import { createHash } from 'node:crypto'
import { db, getMeta } from './db'
import { runFile } from './process'

const GH_INTERFACE = 'github-interface'
const CLI_TIMEOUT_MS = 60_000
const CLI_OUTPUT_BYTES = 1 * 1024 * 1024

db.exec(`CREATE TABLE IF NOT EXISTS pull_request_action_receipts (
  action_id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  outcome TEXT,
  created_at TEXT NOT NULL
)`)

export interface ActionResult { status: number, body: Record<string, unknown> }

const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]+$/
const SHA = /^[0-9a-f]{40}$/i

interface ValidAction { repo: string, number: number, expectedHead: string, actionId: string }

function invalid(message: string): ActionResult {
  return { status: 400, body: { error: message } }
}

function parseAction(body: unknown): ValidAction | ActionResult {
  if (!body || typeof body !== 'object') return invalid('The action needs a JSON body with repo, number, expectedHeadSha and actionId.')
  const { repo, number, expectedHeadSha, actionId } = body as Record<string, unknown>
  if (typeof repo !== 'string' || !REPO.test(repo)) return invalid('repo must look like owner/name.')
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 1) return invalid('number must be a positive pull request number.')
  if (typeof expectedHeadSha !== 'string' || !SHA.test(expectedHeadSha)) return invalid('expectedHeadSha must be a 40-character commit SHA.')
  if (typeof actionId !== 'string' || !actionId.trim() || actionId.length > 128) return invalid('actionId must be a non-empty string.')
  return { repo, number, expectedHead: expectedHeadSha.toLowerCase(), actionId }
}

interface Receipt { fingerprint: string, outcome: string | null }

const reserveAction = db.transaction((id: string, fingerprint: string, createdAt: string): { fresh: boolean, receipt: Receipt } => {
  const result = db.prepare(`INSERT INTO pull_request_action_receipts (action_id, fingerprint, outcome, created_at)
    VALUES (?, ?, NULL, ?) ON CONFLICT(action_id) DO NOTHING`).run(id, fingerprint, createdAt)
  const receipt = db.prepare('SELECT fingerprint, outcome FROM pull_request_action_receipts WHERE action_id = ?').get(id) as Receipt
  return { fresh: result.changes === 1, receipt }
})

function recordOutcome(id: string, result: ActionResult): void {
  db.prepare('UPDATE pull_request_action_receipts SET outcome = ? WHERE action_id = ?').run(JSON.stringify(result), id)
}

async function callInterface(args: string[]): Promise<unknown> {
  const { stdout } = await runFile(GH_INTERFACE, args, { timeoutMs: CLI_TIMEOUT_MS, maxOutputBytes: CLI_OUTPUT_BYTES })
  return JSON.parse(stdout)
}

type Failure =
  | { kind: 'github', status: number, message: string }
  | { kind: 'refused', message: string }
  | { kind: 'attached', approvedHead: string | null }
  | { kind: 'unknown' }

// Refusals raised before anything is sent (github-interface behaviors): a
// determined nothing-happened. Anything unrecognized stays unknown, which is
// always safe to return and never claims a false outcome.
const REFUSED_PREFIXES = [
  'pull request is not open and ready for review',
  'unresolved review conversation',
  'GitHub did not return an APPROVED review',
  'GitHub recorded approval as ',
  'repository has no allowed merge method',
  'malformed merge queue entry evidence',
  'no pull request node ID for queue admission',
]

function classifyFailure(error: unknown): Failure {
  const stderr = typeof (error as { stderr?: unknown })?.stderr === 'string' ? (error as { stderr: string }).stderr : ''
  const github = stderr.match(/GitHub (\d{3}): ([\s\S]*)/)
  if (github) {
    const status = Number(github[1])
    const message = github[2].trim().slice(0, 2000) || `GitHub answered ${status}`
    if (status >= 400 && status < 500) return { kind: 'github', status, message }
    return { kind: 'unknown' }
  }
  const lines = stderr.split('\n').map((line) => line.trim()).filter(Boolean)
  const last = (lines[lines.length - 1] ?? '').replace(/^[A-Za-z_][\w.]*Error: /, '')
  const attached = last.match(/^GitHub attached approval to ([0-9a-f]{40}|missing), expected [0-9a-f]{40}$/)
  if (attached) return { kind: 'attached', approvedHead: attached[1] === 'missing' ? null : attached[1].toLowerCase() }
  if (REFUSED_PREFIXES.some((prefix) => last.startsWith(prefix))) return { kind: 'refused', message: last.slice(0, 2000) }
  return { kind: 'unknown' }
}

interface Approval { id: unknown, commitSha: string | null, submittedAt: unknown }

interface ActionState {
  state: string | null
  merged: boolean
  mergedBy: string | null
  headSha: string | null
  mergeSha: string | null
  queueEntryId: string | null
  myApprovals: Approval[]
}

function asSha(value: unknown): string | null {
  return typeof value === 'string' && SHA.test(value) ? value.toLowerCase() : null
}

async function readActionState(repo: string, number: number, actor: string): Promise<ActionState> {
  const raw = await callInterface(['--pull-action-state', `#${number}`, '--repository', repo, '--token-user', actor]) as Record<string, unknown>
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.my_reviews)) throw new Error('pull-action-state returned no state')
  const myApprovals: Approval[] = []
  for (const review of raw.my_reviews as Array<Record<string, unknown>>) {
    if (!review || typeof review !== 'object' || review.state !== 'APPROVED') continue
    myApprovals.push({ id: review.id ?? null, commitSha: asSha(review.commit_id), submittedAt: review.submitted_at ?? null })
  }
  return {
    state: typeof raw.state === 'string' ? raw.state : null,
    merged: raw.merged === true,
    mergedBy: typeof raw.merged_by === 'string' ? raw.merged_by : null,
    headSha: asSha(raw.head_sha),
    mergeSha: asSha(raw.merge_sha),
    queueEntryId: typeof raw.queue_entry_id === 'string' ? raw.queue_entry_id : null,
    myApprovals,
  }
}

function githubState(state: ActionState | null): Record<string, unknown> | null {
  if (!state) return null
  const latest = [...state.myApprovals].reverse().find((approval) => approval.commitSha !== null) ?? null
  return {
    state: state.state,
    merged: state.merged,
    mergedBy: state.mergedBy,
    headSha: state.headSha,
    queueEntryId: state.queueEntryId,
    myApproval: latest ? { id: latest.id, commitSha: latest.commitSha, submittedAt: latest.submittedAt } : null,
  }
}

function unknownResult(action: ValidAction, state: ActionState | null): ActionResult {
  return { status: 503, body: { outcome: 'unknown', repo: action.repo, number: action.number, github: githubState(state) } }
}

async function tryState(action: ValidAction, actor: string): Promise<{ state: ActionState } | { failure: Failure }> {
  try {
    return { state: await readActionState(action.repo, action.number, actor) }
  } catch (error) {
    return { failure: classifyFailure(error) }
  }
}

export async function handlePullRequestApprove(body: unknown, person: boolean): Promise<ActionResult> {
  if (!person) return { status: 403, body: { error: 'Approving a pull request is the person\'s action, taken in the browser.', code: 'invalid' } }
  const parsed = parseAction(body)
  if ('status' in parsed) return parsed
  const me = getMeta('me') || ''
  if (!me) return invalid('Set your GitHub account in Settings → General to approve pull requests.')
  return runAction('approve', parsed, me)
}

export async function handlePullRequestMerge(body: unknown, person: boolean): Promise<ActionResult> {
  if (!person) return { status: 403, body: { error: 'Merging a pull request is the person\'s action, taken in the browser.', code: 'invalid' } }
  const parsed = parseAction(body)
  if ('status' in parsed) return parsed
  const me = getMeta('me') || ''
  if (!me) return invalid('Set your GitHub account in Settings → General to merge pull requests.')
  return runAction('merge', parsed, me)
}

async function runAction(kind: 'approve' | 'merge', action: ValidAction, actor: string): Promise<ActionResult> {
  const fingerprint = createHash('sha256').update(JSON.stringify({
    action: kind, actor: actor.toLowerCase(), repo: action.repo, number: action.number, expectedHead: action.expectedHead,
  })).digest('hex')
  let reserved: { fresh: boolean, receipt: Receipt }
  try {
    reserved = reserveAction.immediate(action.actionId, fingerprint, new Date().toISOString())
  } catch {
    return { status: 503, body: { error: 'Could not reserve the action safely; nothing was sent.' } }
  }
  if (reserved.receipt.fingerprint !== fingerprint) {
    return { status: 409, body: { error: 'This action ID was already used for a different action.' } }
  }
  if (reserved.receipt.outcome !== null) {
    try {
      return JSON.parse(reserved.receipt.outcome) as ActionResult
    } catch {
      // A corrupted receipt never acts again; it reconciles like a pending one.
    }
  }
  const early = await tryState(action, actor)
  if ('failure' in early) {
    // A fresh reservation proves nothing was sent under this ID, so a
    // determined read failure answers directly; anything else fails closed.
    if (reserved.fresh && early.failure.kind === 'github') {
      return finalize(action.actionId, { status: early.failure.status, body: { outcome: 'refused', repo: action.repo, number: action.number, error: early.failure.message } })
    }
    if (reserved.fresh) return unknownResult(action, null)
    return finalize(action.actionId, unknownResult(action, null))
  }
  const settled = kind === 'approve'
    ? reconcileApproval(action, actor, early.state)
    : reconcileMerge(action, actor, early.state)
  if (settled) return finalize(action.actionId, settled)
  if (!reserved.fresh) return finalize(action.actionId, unknownResult(action, early.state))
  return act(kind, action, actor)
}

function finalize(id: string, result: ActionResult): ActionResult {
  try {
    recordOutcome(id, result)
  } catch {
    // The receipt is the record: when it cannot be written the outcome is
    // unknown, even one just determined.
    return { status: 503, body: { ...(typeof result.body === 'object' && result.body ? result.body : {}), outcome: 'unknown' } }
  }
  return result
}

function reconcileApproval(action: ValidAction, actor: string, state: ActionState): ActionResult | null {
  const approval = state.myApprovals.find((review) => review.commitSha === action.expectedHead) ?? null
  if (!approval) return null
  return {
    status: 200,
    body: {
      outcome: 'already_approved', repo: action.repo, number: action.number, actor,
      approvedHead: action.expectedHead, expectedHead: action.expectedHead, currentHead: state.headSha,
      reviewId: approval.id, submittedAt: approval.submittedAt,
    },
  }
}

function reconcileMerge(action: ValidAction, actor: string, state: ActionState): ActionResult | null {
  if (state.merged) {
    return {
      status: 200,
      body: {
        outcome: 'already_merged', repo: action.repo, number: action.number, actor,
        headSha: action.expectedHead, mergedBy: state.mergedBy, mergeSha: state.mergeSha,
      },
    }
  }
  if (state.queueEntryId) {
    return {
      status: 200,
      body: {
        outcome: 'in_queue', repo: action.repo, number: action.number, actor,
        headSha: action.expectedHead, queueEntryId: state.queueEntryId,
      },
    }
  }
  return null
}

async function act(kind: 'approve' | 'merge', action: ValidAction, actor: string): Promise<ActionResult> {
  const flag = kind === 'approve' ? '--approve-pr' : '--merge-pr'
  let raw: unknown
  try {
    raw = await callInterface([flag, `#${action.number}`, '--expected-head', action.expectedHead, '--repository', action.repo, '--token-user', actor])
  } catch (error) {
    return actFailed(kind, action, actor, classifyFailure(error))
  }
  if (kind === 'approve') return approveSucceeded(action, actor, raw)
  return mergeSucceeded(action, actor, raw)
}

async function actFailed(kind: 'approve' | 'merge', action: ValidAction, actor: string, failure: Failure): Promise<ActionResult> {
  if (failure.kind === 'attached' && kind === 'approve') {
    const state = await tryState(action, actor)
    const found = 'state' in state ? state.state.myApprovals.find((review) => review.commitSha === failure.approvedHead) ?? null : null
    return finalize(action.actionId, {
      status: 200,
      body: {
        outcome: 'approved', repo: action.repo, number: action.number, actor,
        approvedHead: failure.approvedHead, expectedHead: action.expectedHead,
        currentHead: 'state' in state ? state.state.headSha : null,
        reviewId: found?.id ?? null, submittedAt: found?.submittedAt ?? null,
      },
    })
  }
  if (failure.kind === 'refused') {
    return finalize(action.actionId, { status: 409, body: { outcome: 'refused', repo: action.repo, number: action.number, error: failure.message } })
  }
  if (failure.kind === 'github') {
    return finalize(action.actionId, { status: failure.status, body: { outcome: 'refused', repo: action.repo, number: action.number, error: failure.message } })
  }
  return reconcileUnknown(kind, action, actor)
}

async function approveSucceeded(action: ValidAction, actor: string, raw: unknown): Promise<ActionResult> {
  const review = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null
  if (!review || review.outcome !== 'approved' || asSha(review.head_sha) !== action.expectedHead) return reconcileUnknown('approve', action, actor)
  const state = await tryState(action, actor)
  return finalize(action.actionId, {
    status: 200,
    body: {
      outcome: 'approved', repo: action.repo, number: action.number, actor,
      approvedHead: action.expectedHead, expectedHead: action.expectedHead,
      currentHead: 'state' in state ? state.state.headSha : null,
      reviewId: review.review_id ?? null, submittedAt: review.submitted_at ?? null,
    },
  })
}

async function mergeSucceeded(action: ValidAction, actor: string, raw: unknown): Promise<ActionResult> {
  const result = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null
  const outcome = result?.outcome
  const base = { repo: action.repo, number: action.number, actor, headSha: action.expectedHead }
  if (!result || typeof outcome !== 'string') return reconcileUnknown('merge', action, actor)
  switch (outcome) {
    case 'merged':
      if (typeof result.merge_sha !== 'string' || typeof result.merge_method !== 'string') return reconcileUnknown('merge', action, actor)
      return finalize(action.actionId, { status: 200, body: { ...base, outcome, mergeSha: result.merge_sha, mergeMethod: result.merge_method } })
    case 'enqueued':
    case 'in_queue':
      if (typeof result.queue_entry_id !== 'string' || !result.queue_entry_id) return reconcileUnknown('merge', action, actor)
      return finalize(action.actionId, { status: 200, body: { ...base, outcome, queueEntryId: result.queue_entry_id } })
    case 'already_merged':
      return finalize(action.actionId, {
        status: 200,
        body: { ...base, outcome, mergedBy: typeof result.merged_by === 'string' ? result.merged_by : null, mergeSha: asSha(result.merge_sha) },
      })
    case 'superseded':
      return finalize(action.actionId, {
        status: 409, body: { ...base, outcome, expectedHead: action.expectedHead, actualHead: asSha(result.actual_head) },
      })
    case 'not_ready':
      return finalize(action.actionId, { status: 409, body: { ...base, outcome } })
    case 'refused':
      return finalize(action.actionId, {
        status: 422, body: { ...base, outcome, error: typeof result.message === 'string' && result.message ? result.message.slice(0, 2000) : 'GitHub refused to merge this pull request.' },
      })
    default:
      return reconcileUnknown('merge', action, actor)
  }
}

/** Reads GitHub after a send that may or may not have landed: a recorded
 *  result becomes the outcome, anything else stays unknown with that state. */
async function reconcileUnknown(kind: 'approve' | 'merge', action: ValidAction, actor: string): Promise<ActionResult> {
  const read = await tryState(action, actor)
  if (!('state' in read)) return finalize(action.actionId, unknownResult(action, null))
  const settled = kind === 'approve' ? reconcileApproval(action, actor, read.state) : reconcileMerge(action, actor, read.state)
  if (settled) return finalize(action.actionId, settled)
  return finalize(action.actionId, unknownResult(action, read.state))
}
