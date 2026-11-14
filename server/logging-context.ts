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
      // A sweep TimeoutError is shared: the target attaches first, then the
      // sweep reattaches its identity. Outer wins so the sweep keeps its
      // progress. Child failures keep the inner precise identity.
      const sweepTimeout = error instanceof DOMException && error.name === 'TimeoutError'
      if (error !== null && typeof error === 'object' && (sweepTimeout || !failures.has(error))) failures.set(error, identity)
      throw error
    }
  })
}

export function conditionCorrelation(...identity: string[]): string {
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 32)
}
