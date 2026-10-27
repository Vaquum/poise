import { environmentSecrets, redact } from '../gateway/src/diagnostics/redaction.mjs'

export interface ProcessDiagnostic {
  version: 1
  source: 'caller'
  severity: 'error'
  operation: string
  phase: string
  outcome: string
  stderr: string
  stderr_truncated: boolean
  context: Record<string, string | number | null>
  filesystem: Record<string, string | number | null> | null
}

const CONTEXT_FIELDS = ['event_time', 'executable', 'resolved_executable', 'cwd', 'pid', 'exit_code', 'signal', 'timeout_seconds', 'errno',
  'elapsed_ms', 'message', 'workspace', 'container', 'release', 'repository', 'pr', 'expected_head', 'observed_head',
  'base_sha', 'merge_base_sha', 'call_id', 'correlation_id', 'reviewer', 'behavior'] as const
const FILESYSTEM_FIELDS = ['path', 'free_bytes', 'total_bytes', 'free_inodes', 'total_inodes', 'measured_at', 'measurement_error'] as const

// The canonical redactor, which Logging applies to the same Caller rows: every
// configured secret goes, whatever its length, and its markers stay whole.
function text(value: string, secrets: readonly string[]): string {
  return redact(value, secrets).slice(0, 32_768)
}

function fields(value: Record<string, unknown>, keys: readonly string[], secrets: readonly string[]): Record<string, string | number | null> {
  return Object.fromEntries(keys.map((key) => {
    const item = value[key]
    if (item == null) return [key, null]
    if (typeof item === 'string') return [key, text(item, secrets)]
    if (typeof item === 'number' && Number.isFinite(item)) return [key, item]
    throw new Error(`Caller process diagnostic has invalid ${key}`)
  }))
}

export function parseProcessDiagnostic(value: unknown): ProcessDiagnostic | null {
  if (value == null) return null
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Caller process diagnostic is not an object')
  const row = value as Record<string, unknown>
  if (row.version !== 1 || row.source !== 'caller' || row.severity !== 'error'
    || !['operation', 'phase', 'outcome', 'stderr'].every((key) => typeof row[key] === 'string')
    || typeof row.stderr_truncated !== 'boolean') throw new Error('Caller process diagnostic is invalid or unsupported')
  const fs = row.filesystem
  if (fs != null && (typeof fs !== 'object' || Array.isArray(fs))) throw new Error('Caller process diagnostic filesystem is invalid')
  const secrets = environmentSecrets()
  return {
    version: 1, source: 'caller', severity: 'error', operation: text(String(row.operation), secrets), phase: text(String(row.phase), secrets),
    outcome: text(String(row.outcome), secrets), stderr: text(String(row.stderr), secrets), stderr_truncated: row.stderr_truncated,
    context: fields(row, CONTEXT_FIELDS, secrets), filesystem: fs == null ? null : fields(fs as Record<string, unknown>, FILESYSTEM_FIELDS, secrets),
  }
}
