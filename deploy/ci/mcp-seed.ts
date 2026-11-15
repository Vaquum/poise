import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { BehaviorChainJournal, chainIdentity, type BehaviorChain, type ChainEvent } from '../../server/behavior-chain-store'
import type { ChainObservation } from '../../server/behavior-chain-decision'

if (process.env.POISE_SKIP_CLI_BOOTSTRAP !== '1') throw new Error('MCP fixture requires a disposable workspace')
const owner = process.env.POISE_WORKSPACE_OWNER
if (!owner) throw new Error('MCP fixture requires its configured owner')
const database = new Database('/home/poise/.poise/cache.db')
const repository = 'fixtures/Work'
const head = 'a'.repeat(40), mergeSha = 'b'.repeat(40)
const now = Date.now()

try {
  const setting = database.prepare('INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
  setting.run('me', owner)
  setting.run('agentAccount', 'review-bot')
  database.prepare(`INSERT INTO organizations(login,datastore_path,managed,status,stage,error,activated_at)
    VALUES ('fixtures','/home/poise/mcp-fixture.sqlite',0,'ready','ready',NULL,?)`).run(new Date(now).toISOString())

  const journal = new BehaviorChainJournal(database)
  const append = (chain: BehaviorChain, event: ChainEvent) => journal.append(chain.id, randomUUID(), chain.sequence, event)
  const admit = (issue: number) => journal.append(chainIdentity(repository, issue), randomUUID(), 0,
    { type: 'chain.admitted', repository, issue, branch: `poise/issue-${issue}`, author: owner, reviewer: 'review-bot' })
  const implementation = (id: string): ChainEvent => ({ type: 'invocation.admitted', invocation: { id, behavior: 'implement-issue',
    basis: 'fixture', actor: owner, model: 'fixture', slot: 'primary', admittedAt: now - 60_000,
    request: { command: 'agent-interface', argv: [], cwd: '/fixture' } } })

  let delayed = append(admit(2), implementation('delayed'))
  delayed = append(delayed, { type: 'invocation.settled', invocationId: 'delayed', callId: 'd'.repeat(32),
    outcome: 'preflight_failed', evidence: { status: 'failed', action: 'not_started' } })
  append(delayed, { type: 'chain.waiting', reason: 'Model capacity is reserved by existing work' })

  for (const issue of [3, 4]) {
    const pullNumber = issue + 10
    const reviewer = { slot: 'primary', model: 'fixture', recovery: 'fixture' }
    const observation: ChainObservation = { checkedAt: now, existingPulls: [],
      issue: { open: false, eligible: true, revision: 'fixture', commentIds: [] }, issueReviewers: [], prReviewers: [],
      implementer: reviewer, repairer: reviewer, approver: reviewer,
      publication: { pull_number: pullNumber, head_sha: head, head_invocation: null, state: 'closed', merged: true, merge_sha: mergeSha },
      pull: { number: pullNumber, head, headSince: now - 1_000, state: 'closed', draft: false, merged: true, mergeSha,
        queueEntry: null, queueRemoval: null, changesRequested: false, unresolved: 0, approved: false, ready: false,
        reviewIds: [], reviewReceipts: [], reviewRevision: 'fixture', reviewContext: 'c'.repeat(64),
        pending: false, failing: [], greyRuns: [], conflict: false, behind: false } }
    const chain = append(admit(issue), { type: 'chain.observed', observation })
    append(chain, { type: 'chain.merged', mergeSha, evidence: { repository, pull_number: pullNumber,
      merged: true, merge_sha: mergeSha, review_complete: issue === 3 } })
  }

  const missing = append(admit(5), implementation('missing'))
  append(missing, { type: 'invocation.uncertain', invocationId: 'missing', reason: 'Original Call receipt is missing' })
} finally {
  database.close()
}
