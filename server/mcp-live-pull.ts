import { runFile } from './process'
import { requireAgentAccount } from './settings'

const SHA = /^[a-f0-9]{40}$/i
const instant = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && Date.parse(value) <= Date.now()
const sha = (value: unknown): value is string => typeof value === 'string' && SHA.test(value)

export async function readLivePull(repository: string, number: number, recordedHead: string | null, recordedMerge: string | null) {
  const observedAt = new Date().toISOString()
  const source = 'Live GitHub through Caller'
  try {
    const actor = requireAgentAccount()
    const target = { repo: repository.toLowerCase(), url: `https://github.com/${repository}/pull/${number}` }
    async function read(command: string, ...args: string[]) {
      const { stdout } = await runFile('github-interface', [command, String(number), '--repository', target.repo, '--token-user', actor, ...args],
        { timeoutMs: 8000, maxOutputBytes: 1024 * 1024 })
      const value: unknown = JSON.parse(stdout)
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid live GitHub response')
      const row = value as Record<string, unknown>
      if (typeof row.repository !== 'string' || row.repository.toLowerCase() !== target.repo || row.pull_number !== number) {
        throw new Error('Live GitHub target mismatch')
      }
      return row
    }
    const pull = await read('--pull-action-state', '--queue-evidence')
    if (!sha(pull.head_sha) || !['open', 'closed'].includes(String(pull.state)) || typeof pull.merged !== 'boolean'
      || pull.merged && (pull.state !== 'closed' || !sha(pull.merge_sha) || !instant(pull.merged_at))
      || (pull.queue_entry_id !== null && (typeof pull.queue_entry_id !== 'string' || !pull.queue_entry_id))) {
      throw new Error('Invalid live pull evidence')
    }
    const head = pull.head_sha.toLowerCase(), mergeSha = pull.merged ? String(pull.merge_sha).toLowerCase() : null
    const identity = { repository, number, head, state: pull.state, merged: pull.merged, mergeSha, pull: target.url,
      ci: target.url + '/checks?sha=' + head, reviews: target.url + '/files',
      recordedHeadMatches: recordedHead === null ? null : head === recordedHead.toLowerCase(),
      recordedMergeMatches: recordedMerge === null ? null : mergeSha === recordedMerge.toLowerCase() }
    if (pull.state === 'closed') {
      return { source, observedAt, coverage: 'complete', record: { ...identity,
        mergedAt: pull.merged ? pull.merged_at : null, gates: null, queue: null } }
    }
    const queue = pull.queue_entry as Record<string, unknown> | null
    if (pull.queue_entry_id !== null && (!queue || queue.id !== pull.queue_entry_id
      || !['QUEUED', 'AWAITING_CHECKS', 'LOCKED', 'MERGEABLE', 'UNMERGEABLE'].includes(String(queue.state))
      || queue.base !== null && !sha(queue.base) || queue.head !== null && !sha(queue.head))) throw new Error('Invalid queue evidence')
    const readiness = await read('--pr-readiness', '--username', actor, '--expected-head', head)
    if (readiness.outcome === 'superseded' || readiness.head_sha !== head || readiness.state !== 'OPEN') {
      return { source, observedAt, coverage: 'partial', record: null, reason: 'The pull state changed across the live reads' }
    }
    if (typeof readiness.reviewer_approved_current_head !== 'boolean' || typeof readiness.changes_requested !== 'boolean'
      || !Number.isSafeInteger(readiness.unresolved_live_conversation_count) || Number(readiness.unresolved_live_conversation_count) < 0
      || !Array.isArray(readiness.blockers) || readiness.blockers.length > 20
      || !readiness.blockers.every(blocker => typeof blocker === 'string' && /^[a-z0-9_]{1,80}$/.test(blocker))) {
      throw new Error('Invalid live PR readiness evidence')
    }
    const incomplete = readiness.blockers.includes('readiness_pagination_incomplete')
    const checks = ['SUCCESS', 'FAILURE', 'ERROR', 'PENDING', 'EXPECTED'].includes(String(readiness.checks_state)) ? readiness.checks_state : null
    return { source, observedAt, coverage: incomplete || checks === null ? 'partial' : 'complete',
      record: { ...identity, queue: queue ? { id: queue.id, state: queue.state, base: queue.base, head: queue.head } : null,
        gates: { reviewer: actor, approved: readiness.reviewer_approved_current_head, changesRequested: readiness.changes_requested,
          unresolvedThreads: readiness.unresolved_live_conversation_count, checks,
          conflicts: readiness.github_mergeable === 'CONFLICTING' ? true : readiness.github_mergeable === 'MERGEABLE' ? false : null, blockers: readiness.blockers } } }
  } catch {
    return { source, observedAt, coverage: 'unavailable', record: null, reason: 'Live GitHub evidence could not be verified' }
  }
}
