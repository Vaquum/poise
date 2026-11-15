import { createHash } from 'node:crypto'
import { canonicalJson } from './chat/protocol'
import { chainBasis, type BehaviorChain, type ChainInvocation } from './behavior-chain-store'

/** Caller hashes native requests with sorted keys. Journal and plan hashes
 * retain their original serialization; response bytes are hashed verbatim. */
export function nativeRequestSha(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

const SHA = /^[a-f0-9]{40}$/i
// Native actions keep their tighter bound inside the larger journal event
// limit. Leave room for its envelope and the small settlement summary
// without duplicating resolved thread IDs.
const MAX_RECEIPT_BYTES = 256 * 1024 - 4096
const RESULT_FIELDS = ['action', 'repository', 'pull_number', 'head_sha', 'outcome', 'merge_sha', 'merge_method', 'queue_entry_id',
  'current_head_sha', 'ready_except_conversations', 'resolved_count', 'unresolved_count', 'issue_number', 'coverage'] as const
interface ProcessFailure { code: number | string | null, signal: string | null }
export interface NativeActionReceipt {
  version: 1
  chainId: string
  invocationId: string
  actor: string
  requestSha: string
  observedAt: number
  result: Record<string, unknown>
  processFailure?: ProcessFailure
}

export function attributedNativeAction(invocation: ChainInvocation): boolean {
  return invocation.request.command === 'github-interface' && ['merge-pr', 'resolve-threads', 'retire-pr'].includes(invocation.behavior)
}

function argument(invocation: ChainInvocation, flag: string): string {
  const args = invocation.request.argv
  if (args.filter((value) => value === flag).length !== 1) throw new Error(`native action requires one ${flag}`)
  const value = args[args.indexOf(flag) + 1]
  if (!value) throw new Error(`native action lacks ${flag}`)
  return value
}

/** Validates an actual command response, never a later target observation. */
export function nativeActionReceipt(chain: BehaviorChain, invocation: ChainInvocation, result: Record<string, unknown>, observedAt = Date.now()): NativeActionReceipt {
  const merging = invocation.behavior === 'merge-pr'
  const retiring = invocation.behavior === 'retire-pr'
  const command = retiring ? '--issue-work' : merging ? '--merge-if-ready' : '--resolve-nonblocking-conversations-if-ready'
  const action = retiring ? 'issue_work' : merging ? 'merge_if_ready' : 'resolved_nonblocking_conversations_if_ready'
  const number = Number(invocation.request.argv[1]?.replace(/^#/, ''))
  const head = argument(invocation, '--expected-head')
  if (!attributedNativeAction(invocation) || invocation.request.argv[0] !== command || !Number.isSafeInteger(number) || number < 1
    || argument(invocation, '--token-user').toLowerCase() !== invocation.actor.toLowerCase() || !SHA.test(head)
    || !Number.isSafeInteger(observedAt) || observedAt < invocation.admittedAt || observedAt > Date.now()
    || result.action !== action || typeof result.repository !== 'string' || result.repository.toLowerCase() !== chain.repository.toLowerCase()
    || (retiring ? result.issue_number !== number || number !== chain.issue : result.pull_number !== number)
    || result.head_sha !== head) throw new Error('native action receipt conflicts with its immutable admission')
  const retained: Record<string, unknown> = {}
  for (const key of RESULT_FIELDS) if (Object.hasOwn(result, key)) retained[key] = result[key]
  if (retiring) {
    retained.merged = result.merged
    retained.state = result.state
    if (typeof result.reason === 'string') retained.reason = result.reason
    if (argument(invocation, '--mode') !== 'retire' || argument(invocation, '--branch') !== chain.branch
      || Number(argument(invocation, '--pull-number')) !== result.pull_number
      || !['closed', 'already_closed', 'not_ready', 'superseded'].includes(String(result.outcome))
      || result.merged !== false || result.merge_sha != null) throw new Error('native retirement receipt conflicts with its original target')
    if (['closed', 'already_closed'].includes(String(result.outcome))) {
      const coverage = JSON.parse(argument(invocation, '--coverage-json')) as Record<string, unknown>
      const duplicate = coverage.duplicate as { number?: unknown, head?: unknown } | undefined
      if (result.state !== 'closed' || coverage.verified !== true || duplicate?.number !== result.pull_number || duplicate.head !== head
        || chainBasis(coverage) !== chainBasis(result.coverage)) throw new Error('native retirement lacks its original verified coverage')
    }
  } else if (merging) {
    if (!['merged', 'enqueued', 'already_merged', 'in_queue', 'not_ready', 'superseded'].includes(String(result.outcome))
      || (result.outcome === 'merged' && (typeof result.merge_sha !== 'string' || !SHA.test(result.merge_sha)
        || !['merge', 'squash', 'rebase'].includes(String(result.merge_method))))
      || (result.outcome !== 'merged' && (Object.hasOwn(result, 'merge_sha') || Object.hasOwn(result, 'merge_method')))
      || (['enqueued', 'in_queue'].includes(String(result.outcome))
        && (typeof result.queue_entry_id !== 'string' || !result.queue_entry_id.trim() || result.queue_entry_id.length > 256))
      || (!['enqueued', 'in_queue'].includes(String(result.outcome)) && Object.hasOwn(result, 'queue_entry_id'))) {
      throw new Error('native merge receipt lacks its accepted result')
    }
  } else if (result.outcome !== 'superseded') {
    if (Object.hasOwn(result, 'outcome') || typeof result.ready_except_conversations !== 'boolean' || !Number.isSafeInteger(result.resolved_count) || Number(result.resolved_count) < 0
      || !Number.isSafeInteger(result.unresolved_count) || Number(result.unresolved_count) < 0 || !Array.isArray(result.conversations)
      || result.conversations.length !== result.resolved_count
      || result.conversations.some((item) => !item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id || item.isResolved !== true)
      || new Set(result.conversations.map((item) => item.id)).size !== result.resolved_count
      || (result.ready_except_conversations ? result.unresolved_count !== 0 : result.resolved_count !== 0)) throw new Error('native resolution receipt lacks its accepted results')
    retained.conversations = result.conversations.map((item) => ({ id: item.id, isResolved: true }))
  }
  const proof: NativeActionReceipt = { version: 1, chainId: chain.id, invocationId: invocation.id, actor: invocation.actor,
    requestSha: chainBasis(invocation.request), observedAt, result: retained }
  if (result.nativeProcessFailure) {
    const failure = result.nativeProcessFailure as ProcessFailure
    if (!(failure.code === null || Number.isSafeInteger(failure.code) || (typeof failure.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(failure.code)))
      || !(failure.signal === null || (typeof failure.signal === 'string' && /^SIG[A-Z0-9]{1,16}$/.test(failure.signal)))) throw new Error('invalid native process failure evidence')
    proof.processFailure = { code: failure.code, signal: failure.signal }
  }
  if (Buffer.byteLength(JSON.stringify(proof)) > MAX_RECEIPT_BYTES) throw new Error('native action receipt exceeds its journal bound')
  return proof
}

export function matchingNativeActionReceipt(chain: BehaviorChain, invocation: ChainInvocation): NativeActionReceipt | null {
  const value = invocation.evidence?.nativeActionReceipt as NativeActionReceipt | undefined
  if (!value || value.version !== 1 || value.chainId !== chain.id || value.invocationId !== invocation.id || value.actor !== invocation.actor
    || value.requestSha !== chainBasis(invocation.request) || !value.result || typeof value.result !== 'object') return null
  try {
    const verified = nativeActionReceipt(chain, invocation, { ...value.result, ...(value.processFailure ? { nativeProcessFailure: value.processFailure } : {}) }, value.observedAt)
    return chainBasis(verified) === chainBasis(value) ? verified : null
  } catch {
    // Contradictory evidence cannot settle or release the original owner.
    return null
  }
}

export function nativeActionSettlement(proof: NativeActionReceipt): Record<string, unknown> {
  const result = proof.result
  const outcome = result.outcome ?? (result.ready_except_conversations ? (Number(result.resolved_count) > 0 ? 'resolved' : 'nothing_to_resolve') : 'not_ready')
  const changed = ['merged', 'enqueued', 'resolved', 'closed'].includes(String(outcome))
  return { repository: result.repository, pull_number: result.pull_number, head_sha: result.head_sha,
    ...(result.outcome === 'merged' ? { merge_sha: result.merge_sha } : {}),
    ...(['enqueued', 'in_queue'].includes(String(result.outcome)) ? { queue_entry_id: result.queue_entry_id } : {}),
    ...(result.action === 'resolved_nonblocking_conversations_if_ready' && !result.outcome
      ? { resolved_count: result.resolved_count, unresolved_count: result.unresolved_count } : {}),
    outcome, status: changed ? 'completed' : 'deferred', action: changed ? result.action : 'not_started',
    completedAt: proof.observedAt, nativeActionReceipt: proof }
}
