/** Shared presentation/cause identity; never derives technical severity or captures an event. */
const JSON_MESSAGE = /\{[\s\S]*?"message"\s*:\s*("(?:[^"\\]|\\.)*")/

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}

// Startup item errors are not terminal turn failures. Read the complete event
// stream before bounding it, and prefer the last authoritative failed turn.
export function terminalProviderMessage(error: string): string | null {
  let terminal: string | null = null
  let providerError: string | null = null
  for (const line of error.split('\n')) {
    const start = line.indexOf('{')
    if (start < 0) continue
    let event: Record<string, unknown> | null
    try { event = record(JSON.parse(line.slice(start))) } catch { continue }
    if (!event) continue
    const message = event.type === 'turn.failed' ? record(event.error)?.message : event.message
    if (typeof message !== 'string' || !message.trim()) continue
    if (event.type === 'turn.failed') terminal = message.trim()
    else if (event.type === 'error') providerError = message.trim()
  }
  return terminal ?? providerError
}

export function failureCause(error: string): string {
  const terminal = terminalProviderMessage(error)
  if (terminal) return terminal.slice(0, 300)
  const json = JSON_MESSAGE.exec(error)
  if (json) {
    let message = ''
    try {
      message = String(JSON.parse(json[1])).trim()
    } catch {
      // Not a JSON string after all: the lines below say what they can.
    }
    if (message) {
      const before = error.slice(0, json.index).split('\n').pop()?.trim().replace(/^error:\s*/i, '') ?? ''
      return `${before ? `${before} ` : ''}${message}`.slice(0, 300)
    }
  }
  const lines = error.trim().split('\n').filter((line) => line.trim())
  const cause = [...lines].reverse().find((line) => /(?:Error|Timeout|review_packet_too_large):?/.test(line))
    ?? lines[lines.length - 1] ?? error
  return cause.trim().slice(0, 300)
}

export function materialFailureCause(body: string): string {
  if (/review_packet_too_large|Input exceeds the maximum length|PR packet is too large|review prompt limit/.test(body)) return 'review_packet_too_large'
  if (/No space left on device|\bENOSPC\b/.test(body)) return 'storage_exhausted'
  return body.replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '<id>')
    .replace(/\b[0-9a-f]{32,40}\b/gi, '<id>')
    .replace(/\b(actual_chars|max_chars)(["']?\s*[:=]\s*)\d+/g, '$1$2<n>')
    .replace(/\b\d+(?:\.\d+)? (bytes|characters|seconds|milliseconds|attempts)\b/gi, '<n> $1')
}
