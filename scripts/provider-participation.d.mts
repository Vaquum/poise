export type Provider = 'claude' | 'codex' | 'grok' | 'antigravity' | 'muse'
export type LiveProvider = 'claude' | 'codex'
export type LiveObservation = boolean | 'missing' | string | null | undefined
export interface Eligibility {
  eligible: Provider[]
  skipped: Partial<Record<Provider, string>>
}
export interface ProviderEvidenceInput {
  logins: Partial<Record<string, string>>
  live: Record<LiveProvider, boolean | null>
}
export class EligibilityError extends Error {}
export const PROVIDERS: Provider[]
export const SKIP_REASON: string
export const ELIGIBILITY_PROBE_TIMEOUT_MS: number
export function participationDbPath(env?: NodeJS.ProcessEnv): string
export function readAccountLogins(dbPath?: string): Partial<Record<string, string>>
export function recordObservedParticipation(dbPath: string, provider: string): void
export function parseClaudeSignIn(stdout: string): boolean | null
export function parseCodexSignIn(output: string): boolean | null
export function setProbeChildTracker(track: (child: object) => void, untrack: (child: object) => void): void
export function decideEligibility(logins: Partial<Record<string, string>>, live: Partial<Record<LiveProvider, LiveObservation>>, record?: (provider: string) => void): Eligibility
export function parseEvidence(raw: string): ProviderEvidenceInput
export function resolveEligibility(env?: NodeJS.ProcessEnv): Promise<Eligibility & { source: 'evidence' | 'standalone' }>
export function sameEligibility(priorEligible: string[] | undefined, eligible: string[]): boolean
