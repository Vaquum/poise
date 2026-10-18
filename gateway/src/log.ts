import { environmentSecrets, redact, redactFacts } from './diagnostics/contract.js'
export type LogFields = Record<string, unknown>

export interface Logger {
  info(event: string, fields?: LogFields): void
  warn(event: string, fields?: LogFields): void
  error(event: string, fields?: LogFields): void
}

/** One JSON object per line, so `docker logs` output stays greppable and machine-readable. */
export function createLogger(write: (line: string) => void, observe?: (level: string, event: string, fields: LogFields) => void): Logger {
  const secrets = environmentSecrets()
  const emit = (level: string, event: string, fields: LogFields = {}) => {
    let truncated = false
    const safe = redactFacts(fields, secrets, () => { truncated = true })
    write(JSON.stringify({ ...safe, time: new Date().toISOString(), level, event: redact(event, secrets), ...(truncated ? { truncated: true } : {}) }))
    // The owned observer normalizes and redacts the full cause before its bounded persistence.
    if (level !== 'info') observe?.(level, event, fields)
  }
  return {
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
