export type Provider = 'claude' | 'codex' | 'grok' | 'antigravity' | 'muse'
export interface CliUpdate {
  provider: Provider
  configuredExecutable?: string
  status: 'current' | 'updated' | 'unavailable' | 'skipped'
  reason?: string
  checkedAt: string
  path?: string
  resolvedPath?: string
  diagnostic?: { version: 1; operation: string; configuredExecutable: string; cwd: string; exitCode: number | null; signal: string | null; errno: string | number | null; timeoutMs: number; elapsedMs: number; stderr: string; truncated: boolean }
  launchPath?: string
  launchVersion?: string
  before?: string
  after?: string
  error?: string
}
export interface UpdateOptions {
  env?: NodeJS.ProcessEnv
  root?: string
  run?: typeof runUpdateCommand
  timeoutMs?: number
  providers?: Provider[]
}
export const PROVIDERS: Provider[]
export const CLI_UPDATE_TIMEOUT_MS: number
export function runUpdateCommand(command: string, args: string[], options: { env: NodeJS.ProcessEnv, cwd: string, timeoutMs?: number }): Promise<{ stdout: string, stderr: string }>
export function ensureProviderCli(provider: Provider, options?: UpdateOptions): Promise<CliUpdate>
export function ensureProviderClis(options?: UpdateOptions): Promise<Record<Provider, CliUpdate>>

export function terminateUpdateChildren(): void
export function trackUpdateChild(child: object): void
export function untrackUpdateChild(child: object): void
export function withModelRefreshLock<T>(reportPath: string, operation: () => Promise<T>): Promise<T>
