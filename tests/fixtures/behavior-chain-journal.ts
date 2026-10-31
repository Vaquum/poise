import type { ChainEvent } from '../../server/behavior-chain-store'

// Frozen by executing reduceChain in the named original revisions. These
// hashes must never be regenerated with the candidate reducer.
export const historicalEvents: ChainEvent[] = [
  { type: 'chain.admitted', repository: 'Historical/Repo', issue: 7, branch: 'poise/issue-7', author: 'author', reviewer: 'reviewer' },
  { type: 'invocation.admitted', invocation: { id: 'historical-review', behavior: 'review-issue', basis: 'revision-1',
    actor: 'reviewer', model: 'fixture-model', slot: 'primary', admittedAt: 1_800_000_000_000,
    request: { command: 'agent-interface', argv: ['--issue-review', 'Historical/Repo#7'], cwd: '/isolated' } } },
  { type: 'invocation.started', invocationId: 'historical-review' },
  { type: 'invocation.uncertain', invocationId: 'historical-review', reason: 'publication response lost' },
  { type: 'invocation.reconciled', invocationId: 'historical-review', evidence: { resources_settled_at: '2027-01-15T08:00:00.000Z' } },
]

export const historicalJournals = [
  { revision: '77976fd92963cc7e2ad238f90b5ef3f8788ee0c0', reservationPresent: false, hashes: [
    '90cd457aae65076093df890ebb753785734aac2d88b9472d04212eb313e224c2',
    'e3e4e9bbe510a24355e6d99e0a47a9f61c0ce26035eda0af3a0d9c62ab1053a5',
    'f4829698e3a707d5c1da03aa948f03aa1fd124c6e82eb4143fba3f5cb4ef7190',
    '8d5d9579df67d86b94c8949adbe58e646ed23a512ec2fe480c30b31ec3631cfc',
    'ba5630a35a45d8124e3a320c2a8e3be4ea552e48737989590e1c3477d27bb30c',
  ] },
  { revision: '1c9d6f9f7da53856a613a4322cd6b8d7df101c30', reservationPresent: true, hashes: [
    '90cd457aae65076093df890ebb753785734aac2d88b9472d04212eb313e224c2',
    '933ac1c628de6c911b5959c8072c7ba26f65e4efc112a3e933a574ab7c4d747c',
    'f3eec8bbf4ee83d546e52d47310d4cc4a29c16b2c4fb39a316eb90c89f235ef3',
    '0bdb463e479b9f0325e399de13858b750a132d087b3d5a2d052b953622e99c52',
    '0fb16c1d7432b03c615502be2c076eebde4d1be54228ab57a3d8d71ead4f1f19',
  ] },
]
