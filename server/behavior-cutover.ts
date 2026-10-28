import { behaviorChainJournal } from './behavior-chain-journal'
import type { BehaviorChainJournal } from './behavior-chain-store'
import { behaviorBackgroundBusy } from './release-background'
import { runningCallerCalls } from './service/caller-calls'
import { db } from './db'

export function behaviorAdmissionDraining(): boolean { return behaviorChainJournal().cutover().mode === 'draining' }

export function behaviorCutoverBlockers(): string[] {
  const calls = runningCallerCalls(true)
  const blockers: string[] = []
  if (!calls.known) blockers.push('Caller activity is unreadable')
  if (calls.count) blockers.push(`${calls.count} native Caller invocation(s) still running`)
  const operations = behaviorBackgroundBusy()
  if (operations) blockers.push(`${operations} behavior operation(s) still settling`)
  const leases = db.prepare("SELECT count(*) AS count FROM behavior_seen WHERE key = 'pr-operation' AND claim_id != '' AND lease_until > ?").get(Date.now()) as { count: number }
  if (leases.count) blockers.push(`${leases.count} reserved PR operation(s) still settling`)
  return blockers
}

/** The existing tick drives this drain. Reads and cancellation may interleave
 * with discovery, so completion rechecks both the barrier and durable sequence. */
export async function advanceBehaviorCutover(journal: BehaviorChainJournal, pulls: () => Promise<string[]>, blockers = behaviorCutoverBlockers, commit?: () => void): Promise<void> {
  const before = journal.cutover()
  if (before.mode !== 'draining' || blockers().length) return
  const legacy = await pulls()
  if (blockers().length || journal.cutover().sequence !== before.sequence) return
  journal.changeAdmission(before.sequence, 'v2', legacy, Date.now(), commit)
}
