import { describe, expect, it } from 'vitest'
import { failureCause, jsonMessageCause, lastCauseLine, selectFailureCause, terminalProviderMessage } from '../src/diagnostics/material-cause.js'

// The shared cause selector behind health summaries, rail details and
// retained-evidence joins: select first, redact and bound afterwards.

const QUOTA = 'error: GitHub 403 rate-limit: {\'x-ratelimit-resource\': \'core\', \'x-ratelimit-remaining\': \'0\', '
  + '\'x-ratelimit-reset\': \'1800000000\'} body={\n\t"message": "API rate limit exceeded for user ID 42.",\n\t"status": "403"\n}'
const QUOTA_CAUSE = 'GitHub 403 rate-limit '
  + '{\'x-ratelimit-resource\': \'core\', \'x-ratelimit-remaining\': \'0\', \'x-ratelimit-reset\': \'1800000000\'}: '
  + 'API rate limit exceeded for user ID 42.'

describe('shared failure cause selection', () => {
  it('selects the quota cause with its facts, unbounded', () => {
    expect(jsonMessageCause(QUOTA)).toBe(QUOTA_CAUSE)
    expect(selectFailureCause(QUOTA)).toBe(QUOTA_CAUSE)
    expect(failureCause(QUOTA)).toBe(QUOTA_CAUSE)
  })
  it('keeps a plain JSON message without inventing quota facts', () => {
    expect(jsonMessageCause('Internal error: {\n  "message": "boom",\n  "http_status": 402\n}')).toBe('Internal error: boom')
    expect(jsonMessageCause('error: GitHub 500: {"message":"unavailable"}')).toBe('GitHub 500: unavailable')
  })
  it('selects nothing when the input names no cause', () => {
    for (const error of ['', '   \n  ', '{\n}', '{\n"status": "403"\n}', '{"message": oops', '{\n"message": ""\n}']) {
      expect(selectFailureCause(error)).toBeNull()
      expect(jsonMessageCause(error)).toBeNull()
    }
  })
  it('prefers the last terminal provider event over a JSON body', () => {
    const stream = `${QUOTA}\n{"type":"error","message":"Reconnecting..."}\n{"type":"turn.failed","error":{"message":"Selected model is at capacity."}}`
    expect(selectFailureCause(stream)).toBe('Selected model is at capacity.')
    expect(terminalProviderMessage(stream)).toBe('Selected model is at capacity.')
  })
  it('reads past a link-only tail to the line that names the cause', () => {
    expect(lastCauseLine('error: not logged in\nhttps://example.com/login')).toBe('error: not logged in')
    expect(lastCauseLine('{\n}')).toBeNull()
    expect(lastCauseLine('')).toBeNull()
  })
  it('bounds only the display form, never the selected text', () => {
    const cause = selectFailureCause(`error: GitHub 500: {"message":"${'x'.repeat(500)}"}`)
    expect(cause?.length).toBeGreaterThan(300)
    expect(failureCause(`error: GitHub 500: {"message":"${'x'.repeat(500)}"}`)).toHaveLength(300)
  })
})
