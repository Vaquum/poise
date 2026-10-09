// The cause a behavior failure shows in Behaviors' diagnostics. A provider's
// or GitHub's JSON error reads by its message, not by whichever line of it
// holds a brace: a Grok balance error showed as "Internal error: {" or "}".

const JSON_MESSAGE = /\{[\s\S]*?"message"\s*:\s*("(?:[^"\\]|\\.)*")/

export function failureCause(error: string): string {
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
