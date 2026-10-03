export type LogFields = Record<string, unknown>

export interface Logger {
  info(event: string, fields?: LogFields): void
  warn(event: string, fields?: LogFields): void
  error(event: string, fields?: LogFields): void
}

/** One JSON object per line, so `docker logs` output stays greppable and machine-readable. */
export function createLogger(write: (line: string) => void): Logger {
  const emit = (level: string, event: string, fields: LogFields = {}) => {
    write(JSON.stringify({ time: new Date().toISOString(), level, event, ...fields }))
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
