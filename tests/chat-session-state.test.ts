// Live record updates from streamed chat status (src/chat-session-state.ts):
// a progress-only event keeps the queued reason, a new reason replaces it,
// and leaving `queued` clears it.

import { describe, expect, it } from 'vitest'
import type { SessionRecord, SessionStatus } from '../server/chat/protocol'
import { applyStatusChanged } from '../src/chat-session-state'

const record = (overrides: Partial<SessionRecord> = {}): SessionRecord => ({
  id: 's1',
  status: 'queued',
  queuedBehind: 'preparing the checkout',
  updatedAt: '2026-10-21T16:02:00.000Z',
  ...overrides,
} as SessionRecord)

const event = (status: SessionStatus, queuedBehind?: string) => ({ status, queuedBehind })

describe('applyStatusChanged', () => {
  it('keeps the live reason on a progress-only event while still queued', () => {
    const next = applyStatusChanged(record(), event('queued'), '2026-10-21T16:03:00.000Z')
    expect(next.status).toBe('queued')
    expect(next.queuedBehind).toBe('preparing the checkout')
    expect(next.updatedAt).toBe('2026-10-21T16:03:00.000Z')
  })

  it('replaces the reason when the event names the next wait', () => {
    const next = applyStatusChanged(record(), event('queued', 'capturing the checkout snapshot'), '2026-10-21T16:03:00.000Z')
    expect(next.queuedBehind).toBe('capturing the checkout snapshot')
  })

  it('clears the reason on leaving queued', () => {
    const next = applyStatusChanged(record(), event('running'), '2026-10-21T16:03:00.000Z')
    expect(next.status).toBe('running')
    expect(next.queuedBehind).toBeUndefined()
  })
})
