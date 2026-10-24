// The Chat sessions pane as a live work log (src/chat-worklog.ts): the five
// dot states with their text labels, and ordering by latest change with
// pinned chats holding their slots.

import { describe, expect, it } from 'vitest'
import type { SessionStatus, StallState, StopReason } from '../server/chat/protocol'
import { applyWorklogOrder, compareWorklog, sessionDot, type WorklogEntry } from '../src/chat-worklog'

const NOW = Date.parse('2026-10-21T17:00:00Z')
const STALL: StallState = { episode: 'e', at: '2026-10-21T16:02:00.000Z', updatedAt: '2026-10-21T16:02:00.000Z',
  repos: [{ path: '.', branch: 'chat/x', dirtyFiles: 1, unpushedCommits: 0 }], backgroundJobs: [] }

describe('status dots', () => {
  const dot = (status: SessionStatus, updatedAt = '2026-10-21T16:02:00.000Z', pendingRequests: string[] = [], lastStopReason?: StopReason, stall?: StallState) =>
    sessionDot({ status, updatedAt, pendingRequests, lastStopReason, stall }, NOW, 'Europe/Helsinki')

  it('maps all five states with text labels, never colour alone', () => {
    expect(dot('running')).toEqual({ state: 'working', label: 'Working · since 19:02' })
    expect(dot('idle')).toEqual({ state: 'completed', label: 'Completed · 19:02' })
    expect(dot('error', '2026-10-21T11:31:00.000Z')).toEqual({ state: 'error', label: 'Error · 14:31' })
    expect(dot('waiting')).toEqual({ state: 'attention', label: 'Waiting for you · since 19:02' })
    expect(dot('queued')).toEqual({ state: 'queued', label: 'Queued · since 19:02' })
  })

  it('treats starting and stopping as working, and outstanding requests as waiting', () => {
    expect(dot('starting').state).toBe('working')
    expect(dot('stopping').state).toBe('working')
    expect(dot('running', '2026-10-21T16:02:00.000Z', ['q1'])).toEqual({ state: 'attention', label: 'Waiting for you · since 19:02' })
  })

  it('names interruptions and closed chats for what they are', () => {
    expect(dot('interrupted')).toEqual({ state: 'error', label: 'Interrupted · 19:02' })
    expect(dot('closed')).toEqual({ state: 'completed', label: 'Closed · 19:02' })
  })

  it('shows Error for an idle chat whose latest turn failed, stopped or was cut', () => {
    expect(dot('idle', '2026-10-21T16:02:00.000Z', [], 'error')).toEqual({ state: 'error', label: 'Error · 19:02' })
    expect(dot('idle', '2026-10-21T16:02:00.000Z', [], 'cancelled')).toEqual({ state: 'error', label: 'Stopped · 19:02' })
    expect(dot('idle', '2026-10-21T16:02:00.000Z', [], 'interrupted')).toEqual({ state: 'error', label: 'Interrupted · 19:02' })
  })

  it('completes other endings, and lets live states win over a stale failure', () => {
    expect(dot('idle', '2026-10-21T16:02:00.000Z', [], 'end_turn').state).toBe('completed')
    expect(dot('idle', '2026-10-21T16:02:00.000Z', [], 'max_tokens').state).toBe('completed')
    expect(dot('idle', '2026-10-21T16:02:00.000Z', [], 'refusal').state).toBe('completed')
    expect(dot('closed', '2026-10-21T16:02:00.000Z', [], 'error')).toEqual({ state: 'completed', label: 'Closed · 19:02' })
    expect(dot('running', '2026-10-21T16:02:00.000Z', [], 'error').state).toBe('working')
    expect(dot('waiting', '2026-10-21T16:02:00.000Z', [], 'error').state).toBe('attention')
  })

  it('labels the state alone when the change time is not a time', () => {
    expect(dot('running', 'not a time')).toEqual({ state: 'working', label: 'Working' })
  })

  it('shows Stalled for an idle chat whose turn left work behind', () => {
    expect(dot('idle', '2026-10-21T16:02:00.000Z', [], 'end_turn', STALL)).toEqual({ state: 'attention', label: 'Stalled · 19:02' })
    expect(dot('running', '2026-10-21T16:02:00.000Z', [], 'end_turn', STALL).state).toBe('working')
    expect(dot('idle', '2026-10-21T16:02:00.000Z', [], 'error', STALL).state).toBe('error')
  })
})

describe('work log order', () => {
  const entry = (updatedAt: string, createdAt = '2026-10-21T16:00:00.000Z', pending = false, manager = false): WorklogEntry =>
    ({ pending, manager, updatedAt, createdAt })

  it('puts the newest change first, breaking ties by creation', () => {
    expect(compareWorklog(entry('2026-10-21T16:02:00Z'), entry('2026-10-21T16:01:00Z'))).toBeLessThan(0)
    expect(compareWorklog(entry('2026-10-21T16:01:00Z'), entry('2026-10-21T16:02:00Z'))).toBeGreaterThan(0)
    expect(compareWorklog(entry('2026-10-21T16:02:00Z', '2026-10-21T15:00:00Z'), entry('2026-10-21T16:02:00Z', '2026-10-21T14:00:00Z'))).toBeLessThan(0)
    expect(compareWorklog(entry('2026-10-21T16:02:00Z'), entry('2026-10-21T16:02:00Z'))).toBe(0)
  })

  it('keeps a pending session above everything', () => {
    expect(compareWorklog(entry('2026-10-21T16:00:00Z', '2026-10-21T16:00:00Z', true), entry('2026-10-21T17:00:00Z'))).toBeLessThan(0)
  })

  it('keeps the Manager first, below only a pending session', () => {
    expect(compareWorklog(entry('2026-10-21T16:00:00Z', '2026-10-21T16:00:00Z', false, true), entry('2026-10-21T17:00:00Z'))).toBeLessThan(0)
    expect(compareWorklog(entry('2026-10-21T17:00:00Z'), entry('2026-10-21T16:00:00Z', '2026-10-21T16:00:00Z', false, true))).toBeGreaterThan(0)
    expect(compareWorklog(entry('2026-10-21T16:00:00Z', '2026-10-21T16:00:00Z', true), entry('2026-10-21T17:00:00Z', '2026-10-21T16:00:00Z', false, true))).toBeLessThan(0)
  })

  it('holds pinned chats in their slots while the rest re-sort', () => {
    const changed: Record<string, number> = { a: 3, b: 1, c: 2 }
    const compare = (x: string, y: string): number => changed[y] - changed[x]
    expect(applyWorklogOrder(['a', 'b', 'c'], () => false, compare)).toEqual(['a', 'c', 'b'])
    expect(applyWorklogOrder(['a', 'b', 'c'], (id) => id === 'b', compare)).toEqual(['a', 'b', 'c'])
    expect(applyWorklogOrder(['c', 'b', 'a'], (id) => id === 'b', compare)).toEqual(['a', 'b', 'c'])
    expect(applyWorklogOrder(['a', 'b', 'c'], (id) => id !== 'c', compare)).toEqual(['a', 'b', 'c'])
  })

  it('keeps the Manager and a pending session ahead of restored pins', () => {
    const entries: Record<string, WorklogEntry> = {
      pinned: entry('2026-10-21T16:00:00Z'), ordinary: entry('2026-10-21T17:00:00Z'),
      manager: entry('2026-10-21T15:00:00Z', undefined, false, true),
      pending: entry('2026-10-21T15:00:00Z', undefined, true),
    }
    expect(applyWorklogOrder(['pinned', 'ordinary', 'manager', 'pending'],
      (id) => id === 'pinned' || id === 'manager',
      (a, b) => compareWorklog(entries[a], entries[b]),
      (id) => entries[id].pending || entries[id].manager))
      .toEqual(['pending', 'manager', 'pinned', 'ordinary'])
  })
})
