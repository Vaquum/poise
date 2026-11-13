import { createHash } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'

/** Causal identity for existing capture, with no new diagnostic occurrence. */
export interface NoticeDiagnosticIdentity {
  correlationId: string; behavior: string; target: string | null; repository: string | null; account: string | null
  organization?: string
  phase?: string
  expectedHead?: string
  deadline?: number
  progress?: Record<string, string | number | null | Array<Record<string, string | number | null>>>
}
const context = new AsyncLocalStorage<NoticeDiagnosticIdentity>()
const failures = new WeakMap<object, NoticeDiagnosticIdentity>()
export function diagnosticIdentity(error?: unknown): NoticeDiagnosticIdentity | undefined {
  return (error !== null && typeof error === 'object' ? failures.get(error) : undefined) ?? context.getStore()
}
export async function withNoticeDiagnosticIdentity<T>(identity: NoticeDiagnosticIdentity, work: () => Promise<T>): Promise<T> {
  return context.run(identity, async () => {
    try { return await work() }
    catch (error) {
      if (error !== null && typeof error === 'object' && !failures.has(error)) failures.set(error, identity)
      throw error
    }
  })
}

export function conditionCorrelation(...identity: string[]): string {
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 32)
}
