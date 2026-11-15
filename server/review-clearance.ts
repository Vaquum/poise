import { join } from 'node:path'
import { homedir } from 'node:os'
import { agentInterfaceCwd } from './models'
import { runFile } from './process'
import { withProcessLock } from './process-lock'
import { getMeta, setMeta } from './db'
import { behaviorChainForPull, behaviorChainJournal } from './behavior-chain-journal'
import { chainBasis, type BehaviorChain } from './behavior-chain-store'
import { chainReviewClearance, type ChainObservation, type ChainReviewer } from './behavior-chain-decision'
import { resumeLink } from './review-response'

export const REVIEW_CLEARANCE = 'Poise review clearance'
const REPOSITORY = 'autonomio/poise'
const CHECKS_KEY = 'github-review-clearance:checks'
const BASIS_KEY = 'github-review-clearance:basis'

export interface ClearancePull {
  number: number, head: string, headRef: string, headRepo: string, author: string, context: string, draft: boolean
  reviews: Array<{ id: number, head: string, state: string, actor: string, invocation: string | null,
    response: unknown, submittedAt: string }>
}
export interface ClearanceSnapshot {
  pulls: ClearancePull[]
  groups: Array<{ head: string, base: string, pulls: number[] }>
}
interface Check { id: number, head: string }
interface Evaluation { head: string, conclusion: 'success' | 'failure', summary: string }
export type ClearanceOwner = { kind: 'independent' } | { kind: 'unknown' }
  | { kind: 'managed', chain: BehaviorChain, observation: ChainObservation }

/** Only a complete integration rollup can distinguish revocation from CI repair. */
export function reviewClearanceOnly(removal: Record<string, unknown>): boolean {
  const before = removal.beforeCommit as { statusCheckRollup?: { contexts?: { pageInfo?: { hasNextPage?: boolean },
    nodes?: Array<{ __typename?: string, name?: string, status?: string, conclusion?: string, context?: string, state?: string }> } } } | undefined
  const contexts = before?.statusCheckRollup?.contexts
  const nodes = contexts?.nodes
  return removal.reason === 'failed_checks' && contexts?.pageInfo?.hasNextPage === false && Array.isArray(nodes)
    && nodes.some(node => node.__typename === 'CheckRun' && node.name === REVIEW_CLEARANCE
      && node.status === 'COMPLETED' && node.conclusion === 'FAILURE')
    && nodes.every(node => node.__typename === 'CheckRun' ? node.status === 'COMPLETED'
      && (node.name === REVIEW_CLEARANCE && node.conclusion === 'FAILURE' || ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(node.conclusion ?? ''))
      : node.__typename === 'StatusContext' && node.state === 'SUCCESS')
}

/** Every obligation sharing a commit participates, even across queue groups. */
export function reviewClearanceResults(snapshot: ClearanceSnapshot, owners: ReadonlyMap<number, ClearanceOwner>, now: number): Evaluation[] {
  const targets = new Map<string, Set<number>>()
  for (const pull of snapshot.pulls) {
    const members = targets.get(pull.head) ?? new Set<number>()
    members.add(pull.number); targets.set(pull.head, members)
  }
  for (const group of snapshot.groups) {
    const heads = new Set(snapshot.pulls.filter(pull => group.pulls.includes(pull.number)).map(pull => pull.head))
    const members = targets.get(group.head) ?? new Set<number>()
    for (const number of group.pulls) members.add(number)
    for (const pull of snapshot.pulls) if (heads.has(pull.head)) members.add(pull.number)
    targets.set(group.head, members)
  }
  return [...targets].map(([head, members]): Evaluation => {
    const blockers: string[] = []
    for (const number of members) {
      const pull = snapshot.pulls.find(item => item.number === number)
      const owner = owners.get(number)
      if (!pull || !owner || owner.kind === 'unknown') { blockers.push(`#${number}: ownership/evidence unavailable`); continue }
      if (owner.kind === 'independent') continue
      const original = owner.observation
      if (!original.pull || original.pull.number !== number || original.pull.head !== pull.head
        || original.pull.reviewContext !== pull.context) { blockers.push(`#${number}: stale native review context`); continue }
      const live: ChainObservation = { ...original, checkedAt: now, pull: { ...original.pull,
        reviewReceipts: pull.reviews.filter(review => review.actor.toLowerCase() === owner.chain.reviewer.toLowerCase())
          .map(review => ({ ...review, submittedAt: Date.parse(review.submittedAt) })) } }
      // A resumed finalizer publishes under its original marker, so the
      // marker and the review ID span two invocations of one obligation.
      const unretained = pull.reviews.some(review => review.head === pull.head && review.invocation
        && !owner.chain.invocations.some(invocation => invocation.evidence?.review_id === review.id
          && (invocation.callId === review.invocation
            || resumeLink(invocation.evidence?.artifact as Record<string, unknown> | undefined)?.callId === review.invocation)))
      const reason = pull.draft ? 'draft' : unretained ? 'native submission is not yet retained'
        : chainReviewClearance(owner.chain, live, now)
      if (reason) blockers.push(`#${number}: ${reason}`)
    }
    return { head, conclusion: blockers.length ? 'failure' : 'success',
      summary: blockers.length ? blockers.join('\n') : `Current Poise review obligations cleared: ${[...members].map(number => `#${number}`).join(', ')}` }
  })
}

async function command(mode: 'snapshot' | 'begin' | 'complete', results?: unknown) {
  const { stdout } = await runFile('github-interface', ['--review-clearance', '--mode', mode,
    ...(results ? ['--results-json', JSON.stringify(results)] : [])],
  { cwd: agentInterfaceCwd(), timeoutMs: 120_000, maxOutputBytes: 8 * 1024 * 1024 })
  return JSON.parse(stdout)
}

/** One evaluation owns its check IDs. Late evaluations cannot finish newer runs. */
export async function publishReviewClearance(operations: {
  snapshot(): Promise<ClearanceSnapshot>
  owners(snapshot: ClearanceSnapshot): Promise<Map<number, ClearanceOwner>>
  begin(heads: string[]): Promise<Check[]>
  complete(results: Array<Check & Omit<Evaluation, 'head'>>): Promise<void>
  retained(): Check[]
  retain(checks: Check[]): void
  basis?(): string | null
  retainBasis?(basis: string): void
}): Promise<void> {
  let checks = operations.retained()
  try {
    const snapshot = await operations.snapshot()
    const owners = await operations.owners(snapshot)
    const basis = chainBasis([snapshot, [...owners]])
    // Re-publishing failure on unchanged green evidence would eject a healthy
    // queue entry. Reuse only after fresh reads of every original obligation.
    if (operations.basis?.() === basis) return
    const heads = [...new Set([...snapshot.pulls.map(pull => pull.head), ...snapshot.groups.map(group => group.head)])]
    checks = await operations.begin(heads)
    operations.retain(checks)
    const results = reviewClearanceResults(snapshot, owners, Date.now())
    const refreshed = await operations.snapshot()
    const freshOwners = await operations.owners(refreshed)
    const unchanged = basis === chainBasis([refreshed, [...freshOwners]])
    await operations.complete(checks.map(check => {
      const result = results.find(result => result.head === check.head)
      return { ...check, conclusion: unchanged && result?.conclusion === 'success' ? 'success' : 'failure',
        summary: unchanged ? result?.summary ?? 'Review evidence unavailable' : 'Head, review context, ownership or retained evidence changed during evaluation' }
    }))
    operations.retainBasis?.(unchanged ? basis : '')
  } catch (error) {
    operations.retainBasis?.('')
    try {
      await operations.complete(checks.map(check => ({ ...check, conclusion: 'failure', summary: 'Native ownership or review evidence is unavailable' })))
    } catch (revocation) {
      throw new AggregateError([error, revocation], 'Review clearance evidence and revocation failed')
    }
    throw error
  }
}

export function reviewClearanceConfigured(): boolean {
  const names = ['POISE_REVIEW_APP_ID', 'POISE_REVIEW_INSTALLATION_ID', 'POISE_REVIEW_PRIVATE_KEY_FILE']
  if (!names.some(name => process.env[name])) return false
  if (!names.every(name => process.env[name])) throw new Error(`Review clearance requires ${names.join(', ')}`)
  return true
}

export async function runReviewClearance(accounts: { me: string, agentAccount: string }, roster: (chain: BehaviorChain) => Promise<ChainReviewer[]>): Promise<void> {
  if (!reviewClearanceConfigured()) return
  await withProcessLock({ path: join(homedir(), '.poise', 'review-clearance.lock.sqlite3'), timeoutMs: 1000 }, async () => {
    await publishReviewClearance({
      snapshot: () => command('snapshot'),
      async owners(snapshot) {
        const owners = new Map<number, ClearanceOwner>()
        for (const pull of snapshot.pulls) {
          const chain = behaviorChainForPull(REPOSITORY, pull.number, pull)
          if (chain) {
            const observation = chain.observation as ChainObservation | null
            owners.set(pull.number, observation?.pull ? { kind: 'managed', chain,
              observation: { ...observation, prReviewers: await roster(chain) } } : { kind: 'unknown' })
          } else {
            // Author identity is read live. Only authors outside both configured
            // native identities can be positively independent of this owner.
            const independent = !!accounts.me && !!accounts.agentAccount && !pull.headRef.startsWith('poise/')
              && ![accounts.me, accounts.agentAccount].some(account => account.toLowerCase() === pull.author.toLowerCase())
            owners.set(pull.number, { kind: independent ? 'independent' : 'unknown' })
          }
        }
        // Force verification of the canonical projection even for an otherwise
        // independent group; unreadable ownership is never an absence proof.
        behaviorChainJournal().verifyProjection()
        return owners
      },
      async begin(heads) { return (await command('begin', heads.map(head => ({ head })))).checks as Check[] },
      async complete(results) { if (results.length) await command('complete', results) },
      retained: () => JSON.parse(getMeta(CHECKS_KEY) || '[]') as Check[],
      retain: checks => setMeta(CHECKS_KEY, JSON.stringify(checks)),
      basis: () => getMeta(BASIS_KEY),
      retainBasis: basis => setMeta(BASIS_KEY, basis),
    })
  })
}
