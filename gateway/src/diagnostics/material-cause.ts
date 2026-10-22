/** Shared presentation/cause identity; never derives technical severity or captures an event. */
const JSON_MESSAGE = /\{[\s\S]*?"message"\s*:\s*("(?:[^"\\]|\\.)*")/

// The quota facts Caller's GitHub client prints with a 403/429 rate-limit
// error: which bucket fired, whether any quota remains, and when the window
// resets. The full header mapping never survives the short summary, so the
// selector keeps these three keys in the producer's own shape.
const RATE_LIMIT_FACTS = [
  ['x-ratelimit-resource', /x-ratelimit-resource['"]?\s*[:=]\s*['"]?([A-Za-z][A-Za-z0-9_-]*)/],
  ['x-ratelimit-remaining', /x-ratelimit-remaining['"]?\s*[:=]\s*['"]?(\d+)/],
  ['x-ratelimit-reset', /x-ratelimit-reset['"]?\s*[:=]\s*['"]?(\d+)/],
] as const

function rateLimitFacts(error: string): string | null {
  const facts = RATE_LIMIT_FACTS.flatMap(([key, pattern]) => {
    const value = pattern.exec(error)?.[1]
    return value === undefined ? [] : [`'${key}': '${value}'`]
  })
  return facts.length ? `{${facts.join(', ')}}` : null
}

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

// The message inside a JSON error, with the quota facts a rate-limit error
// carries. Unbounded: callers redact the selected text before bounding it.
export function jsonMessageCause(error: string): string | null {
  const json = JSON_MESSAGE.exec(error)
  if (!json) return null
  let message = ''
  try {
    message = String(JSON.parse(json[1])).trim()
  } catch {
    // Not a JSON string after all: the lines below say what they can.
    return null
  }
  if (!message) return null
  const before = error.slice(0, json.index).split('\n').pop()?.trim().replace(/^error:\s*/i, '') ?? ''
  const facts = rateLimitFacts(error)
  if (!facts) return `${before ? `${before} ` : ''}${message}`
  const prefix = before.replace(/:\s*$/, '')
  return `${prefix ? `${prefix} ` : ''}${facts}: ${message}`
}

// The authoritative cause before bounding: a terminal provider failure, else
// the message inside a JSON error. Null when the input names no cause.
export function selectFailureCause(error: string): string | null {
  return terminalProviderMessage(error) ?? jsonMessageCause(error)
}

// The last stderr line that can be a cause. Undecoded JSON fragments, bare
// punctuation and bare links name no cause, so the outer error stands alone.
export function lastCauseLine(stderr: string): string | null {
  const lines = stderr.split('\n').map((line) => line.trim()).filter((line) => line)
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!
    if (line.startsWith('{') || line.startsWith('"')) continue
    if (/^[{}\[\](),:;."'\s\-_=]+$/.test(line)) continue
    if (/^https?:\/\/\S+$/.test(line)) continue
    return line
  }
  return null
}

export function failureCause(error: string): string {
  const selected = selectFailureCause(error)
  if (selected) return selected.slice(0, 300)
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
