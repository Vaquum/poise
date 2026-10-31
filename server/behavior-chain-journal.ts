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

export interface ChainPullIdentity { headRef: string | null, headRepo: string | null }

export function behaviorChainOwnsRepository(repository: string): boolean {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'behavior_chain_current'").get()) return false
  const row = db.prepare(`SELECT chain_id FROM behavior_chain_current WHERE merged = 0
    AND lower(json_extract(state, '$.repository')) = lower(?) LIMIT 1`).get(repository) as { chain_id: string } | undefined
  return !!row && !!behaviorChainJournal().read(row.chain_id)
}

export function behaviorChainOwner(repository: string, number: number, kind: 'issues' | 'pull', identity?: ChainPullIdentity): string | null {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'behavior_chain_current'").get()) return null
  const source = behaviorChainJournal()
  if (kind === 'issues') {
    const chain = source.read(chainIdentity(repository, number))
    return chain && (!chain.mergeSha || chain.reviewPending) ? chain.id : null
  }
  const row = db.prepare(`SELECT chain_id FROM behavior_chain_current
    WHERE merged = 0 AND lower(json_extract(state, '$.repository')) = lower(?)
      AND (json_extract(state, '$.observation.publication.pull_number') = ?
        OR (? IS NOT NULL AND lower(?) = lower(?) AND json_extract(state, '$.branch') = ?)) LIMIT 1`)
    .get(repository, number, identity?.headRef ?? null, identity?.headRepo ?? null, repository, identity?.headRef ?? null) as { chain_id: string } | undefined
  return row && source.read(row.chain_id) ? row.chain_id : null
}
