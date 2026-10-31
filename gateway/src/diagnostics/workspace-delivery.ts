import type { DiagnosticRuntime } from './runtime.js'

/** This is the production maintenance projection, shared with the boundary proof. */
export function diagnosticDeliveryPage(runtime: DiagnosticRuntime, workspace: string, cursor: string | null) {
  const page = runtime.query((store) => store.delivery({ workspace, operator: false }, cursor))
  const health = runtime.health()
  const sources = health.sources.filter((source) => source.workspace === workspace || source.workspace === null)
  return { ...page, coverage: { status: health.status, currentStatus: health.currentStatus, error: health.error,
    dropped: health.dropped, rejected: health.rejected, lossActive: health.lossActive, lastSuccessfulWriteAt: health.lastSuccessfulWriteAt,
    historyIncomplete: health.dropped > 0 || health.rejected > 0 || sources.length > 16 || sources.some((source) => !source.optional && (source.historyIncomplete || source.gaps.length > 0)),
    sources: sources.slice(0, 16).map((source) => ({ source: source.source, status: source.status, currentStatus: source.currentStatus,
      optional: source.optional, observedAt: source.observedAt, availableFrom: source.availableFrom,
      historyIncomplete: !!source.historyIncomplete || source.gaps.length > 2, gaps: source.gaps.slice(-2),
    })) } }
}
