export type ChainWorkLink =
  | { kind: 'chat', session: string, manager: boolean }
  | { kind: 'pull', url: string }

export interface ChainNudge {
  kind: 'automatic' | 'prerequisite' | 'decision' | 'reconcile' | 'unknown'
  action: string
  prerequisite: string | null
  work: ChainWorkLink | null
}
