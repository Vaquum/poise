import { db } from './db'
import { BehaviorChainJournal, chainIdentity } from './behavior-chain-store'

let journal: BehaviorChainJournal | undefined
export function behaviorChainJournal(): BehaviorChainJournal {
  if (!journal) {
    const opened = new BehaviorChainJournal(db)
    opened.verifyProjection()
    journal = opened
  }
  return journal
}

export function behaviorChainOwner(repository: string, number: number, kind: 'issues' | 'pull'): string | null {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'behavior_chain_current'").get()) return null
  const source = behaviorChainJournal()
  if (kind === 'issues') {
    const chain = source.read(chainIdentity(repository, number))
    return chain && !chain.mergeSha ? chain.id : null
  }
  const row = db.prepare(`SELECT chain_id FROM behavior_chain_current
    WHERE merged = 0 AND lower(json_extract(state, '$.repository')) = lower(?)
      AND json_extract(state, '$.observation.publication.pull_number') = ? LIMIT 1`).get(repository, number) as { chain_id: string } | undefined
  return row && source.read(row.chain_id) ? row.chain_id : null
}
