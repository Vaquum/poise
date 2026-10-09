import { describe, expect, it } from 'vitest'
import { failureCause } from '../src/behavior-failure-cause'

// What Behaviors' diagnostics show for a failure (src/behavior-failure-cause.ts).

const GROK = 'Internal error: {\n  "message": "API error (status 402 Payment Required): Grok Build usage balance exhausted",\n  "http_status": 402\n}'

describe('the cause a behavior failure shows', () => {
  it('reads a provider\'s JSON error by its message, not by the line with its brace', () => {
    expect(failureCause(`Error: ${GROK}`)).toBe('Internal error: API error (status 402 Payment Required): Grok Build usage balance exhausted')
    expect(failureCause(GROK)).toBe('Internal error: API error (status 402 Payment Required): Grok Build usage balance exhausted')
  })

  it('keeps what GitHub\'s error says before its JSON', () => {
    const error = 'error: GitHub 500: {"message":"Server Error: Sorry, this diff is temporarily unavailable due to heavy server load.","errors":[{"resource":"Comparison","field":"diff","code":"not_available"}],"status":"500"}'
    expect(failureCause(error)).toBe('GitHub 500: Server Error: Sorry, this diff is temporarily unavailable due to heavy server load.')
  })

  it('keeps the last line naming an error otherwise, bounded', () => {
    expect(failureCause('Traceback (most recent call last):\n  File "x.py"\nValueError: bad verdict\n')).toBe('ValueError: bad verdict')
    expect(failureCause('just this')).toBe('just this')
    expect(failureCause(`Error: ${'x'.repeat(400)}`)).toHaveLength(300)
  })
})
