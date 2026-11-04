import { randomUUID } from 'node:crypto'
import type { AgentLogSnapshot, LogEntry } from './agent-log-parse'
import { chainBasis, type BehaviorChainJournal } from './behavior-chain-store'
import { resourceReleaseProven } from './behavior-resource-receipt'
import { nativeBehavior } from './behavior-chain-runtime'
import { nativeRequestSha } from './behavior-chain-action'

/** Reads only the existing Caller receipts. Cleanup can release reservations
 * while admission is paused; it never claims a GitHub outcome or starts work. */
export class BehaviorResourceRecovery {
  private cursor = { chain: '', position: -1 }
  constructor(private readonly journal: BehaviorChainJournal, private readonly read: (ids: string[]) => Promise<AgentLogSnapshot>) {}

  async run(): Promise<void> {
    let page = this.journal.pendingResourcePage(this.cursor)
    if (!page.length && this.cursor.chain) {
      this.cursor = { chain: '', position: -1 }
      page = this.journal.pendingResourcePage(this.cursor)
    }
    if (!page.length) return
    const correlations = page.flatMap(({ invocation }) => {
      const resume = invocation.evidence?.publicationResume
      return [invocation.id, ...(resume && typeof resume === 'object' && 'correlation' in resume && typeof resume.correlation === 'string' ? [resume.correlation] : [])]
    })
    const snapshot = await this.read(correlations)
    let failure: Error | undefined
    for (const entry of page) {
      this.cursor = { chain: entry.chain.id, position: entry.position }
      try {
        const chain = this.journal.read(entry.chain.id)!
        const invocation = chain.invocations[entry.position]
        const selected = (correlation: string): LogEntry | undefined => {
          if (snapshot.quarantined.some(row => !row.correlationId || row.correlationId === correlation)) throw new Error('native resource receipt is quarantined')
          const calls = snapshot.entries.filter(call => call.correlation_id === correlation)
          if (calls.length > 1) throw new Error('multiple Caller receipts claim one resource owner')
          return calls[0]
        }
        const call = selected(invocation.id)
        if (!call || call.status === 'running') continue
        if (call.source !== 'poise:behavior-chain' || call.actor !== invocation.actor || call.repo !== chain.repository
          || call.behavior !== nativeBehavior(invocation.behavior) || invocation.callId && invocation.callId !== call.id
          || invocation.evidence?.nativeCallId && invocation.evidence.nativeCallId !== call.id) throw new Error('native resource receipt differs from its original admission')
        if (invocation.model === null && (call.model !== 'native-action'
          || call.pr_id !== invocation.request.argv[1]?.replace(/^#/, '')
          || call.expected_head !== invocation.request.argv[invocation.request.argv.indexOf('--expected-head') + 1]
          || call.artifact?.request_sha && call.artifact.request_sha !== nativeRequestSha(invocation.request))) {
          throw new Error('native action resource receipt differs from its immutable request')
        }
        const physical: Record<string, unknown> = { resource_ownership: call.resource_ownership, resources_settled_at: call.resources_settled_at }
        // Retain logical artifacts verbatim. Only their cleanup fields may be covered.
        if (call.artifact) {
          const prior = invocation.evidence?.artifact
          const artifact = prior && typeof prior === 'object' && !Array.isArray(prior) ? { ...prior } : {}
          for (const key of ['resource_error', 'resource_recovered_at'] as const) {
            if (key in call.artifact) Object.assign(artifact, { [key]: call.artifact[key] })
          }
          if (Object.keys(artifact).length) physical.artifact = artifact
        }
        const resume = invocation.evidence?.publicationResume
        if (resume && typeof resume === 'object' && 'correlation' in resume && typeof resume.correlation === 'string') {
          const continuation = selected(resume.correlation)
          if (continuation && continuation.status !== 'running') {
            if (continuation.source !== 'poise:behavior-chain' || continuation.actor !== invocation.actor || continuation.repo !== chain.repository
              || continuation.behavior !== 'native_publication' || !('head' in resume) || continuation.expected_head !== resume.head
              || !('callId' in resume) || !('plan' in resume)
              || continuation.artifact?.request_sha !== nativeRequestSha({ kind: 'native_publication', call_id: resume.callId, digest: resume.plan, head: resume.head,
                ...(invocation.request.resourceLimits ? { resourceLimits: invocation.request.resourceLimits } : {}) })) {
              throw new Error('native publication resource receipt differs from its original continuation')
            }
            const prior = invocation.evidence?.publicationReceipt
            const publication = prior && typeof prior === 'object' && !Array.isArray(prior) ? { ...prior } : {}
            const oldArtifact = 'artifact' in publication ? publication.artifact : null
            const artifact = oldArtifact && typeof oldArtifact === 'object' && !Array.isArray(oldArtifact) ? { ...oldArtifact } : {}
            for (const key of ['resource_error', 'resource_recovered_at'] as const) {
              if (continuation.artifact && key in continuation.artifact) Object.assign(artifact, { [key]: continuation.artifact[key] })
            }
            physical.publicationReceipt = { ...publication, resource_ownership: continuation.resource_ownership,
              resources_settled_at: continuation.resources_settled_at, ...(Object.keys(artifact).length ? { artifact } : {}) }
          }
        }
        if (!resourceReleaseProven(physical, true)) continue
        const before = Object.fromEntries(Object.keys(physical).map(key => [key, invocation.evidence?.[key]]))
        if (chainBasis(before) !== chainBasis(physical)) this.journal.append(chain.id, randomUUID(), chain.sequence,
          { type: 'invocation.resources_reconciled', invocationId: invocation.id, evidence: physical })
      } catch (error) { failure ??= error instanceof Error ? error : new Error(String(error)) }
    }
    if (failure) throw failure
  }
}
