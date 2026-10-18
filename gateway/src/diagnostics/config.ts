import { DEFAULT_LOG_POLICY, type LogPolicy } from './store.js'

/** Configuration is explicit; an invalid budget never silently changes retention. */
export function diagnosticConfig(env: Readonly<Record<string, string | undefined>>) {
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const raw = env[key]
    if (raw === undefined || raw === '') return fallback
    const value = /^\d+$/.test(raw) ? Number(raw) : NaN
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${key} must be an integer between ${min} and ${max}`)
    return value
  }
  const policy: LogPolicy = {
    retentionMs: integer('POISE_LOG_RETENTION_DAYS', DEFAULT_LOG_POLICY.retentionMs / 86_400_000, 1, 365) * 86_400_000,
    maxBytes: integer('POISE_LOG_MAX_BYTES', DEFAULT_LOG_POLICY.maxBytes, 4096, 1024 ** 3),
    maxEvents: integer('POISE_LOG_MAX_EVENTS', DEFAULT_LOG_POLICY.maxEvents, 1, 1_000_000),
  }
  return { policy, maxQueueEvents: integer('POISE_LOG_QUEUE_EVENTS', 1000, 1, 10_000),
    maxQueueBytes: integer('POISE_LOG_QUEUE_BYTES', 2 * 1024 ** 2, 64 * 1024, 16 * 1024 ** 2) }
}
