import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { BehaviorDeadline } from '../server/behavior-deadline'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

it('keeps the ordinary work limit when no provider preparation occurs', async () => {
  const clock = new BehaviorDeadline(55_000, 120_000)
  await vi.advanceTimersByTimeAsync(55_000)
  expect(clock.controller.signal.aborted).toBe(true)
  expect(clock.controller.signal.reason.name).toBe('TimeoutError')
  clock.close()
})

it('resumes the remaining work budget after a slow but bounded provider check', async () => {
  const clock = new BehaviorDeadline(55_000, 120_000)
  await vi.advanceTimersByTimeAsync(10_000)
  await clock.prepare(() => vi.advanceTimersByTimeAsync(90_000))
  expect(clock.controller.signal.aborted).toBe(false)
  await vi.advanceTimersByTimeAsync(44_999)
  expect(clock.controller.signal.aborted).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(clock.controller.signal.aborted).toBe(true)
  clock.close()
})

it('bounds cumulative provider preparation across multiple launches in one cycle', async () => {
  const clock = new BehaviorDeadline(55_000, 120_000)
  await clock.prepare(() => vi.advanceTimersByTimeAsync(90_000))
  const remaining = clock.prepare(() => vi.advanceTimersByTimeAsync(30_000))
  await expect(remaining).rejects.toMatchObject({ name: 'TimeoutError' })
  clock.close()
})

it('counts overlapping provider waits once and keeps preparation bounded until the last waiter', async () => {
  const clock = new BehaviorDeadline(55_000, 120_000)
  let first!: () => void, second!: () => void
  const a = clock.prepare(() => new Promise<void>(resolve => { first = resolve }))
  await vi.advanceTimersByTimeAsync(20_000)
  const b = clock.prepare(() => new Promise<void>(resolve => { second = resolve }))
  await vi.advanceTimersByTimeAsync(70_000)
  first(); await a
  expect(clock.preparing).toBe(true)
  await vi.advanceTimersByTimeAsync(20_000)
  second(); await b
  expect(clock.preparing).toBe(false)
  expect(clock.controller.signal.aborted).toBe(false)
  await vi.advanceTimersByTimeAsync(55_000)
  expect(clock.controller.signal.aborted).toBe(true)
  clock.close()
})

it('does not resurrect an expired operation when preparation begins after its deadline', async () => {
  const clock = new BehaviorDeadline(55_000, 120_000)
  vi.setSystemTime(Date.now() + 55_001)
  const provider = vi.fn(async () => undefined)
  await expect(clock.prepare(provider)).rejects.toMatchObject({ name: 'TimeoutError' })
  expect(provider).not.toHaveBeenCalled()
  clock.close()
})

it('bounds reservations through overlapping preparation and later unused preparation', async () => {
  const clock = new BehaviorDeadline(55_000, 120_000)
  expect(clock.remainingMs).toBe(175_000)
  await vi.advanceTimersByTimeAsync(10_000)
  let first!: () => void, second!: () => void
  const a = clock.prepare(() => new Promise<void>(resolve => { first = resolve }))
  const b = clock.prepare(() => new Promise<void>(resolve => { second = resolve }))
  await vi.advanceTimersByTimeAsync(20_000)
  first(); await a
  expect(clock.remainingMs).toBe(145_000)
  await vi.advanceTimersByTimeAsync(70_000)
  second(); await b
  expect(clock.remainingMs).toBe(75_000)
  await vi.advanceTimersByTimeAsync(10_000)
  expect(clock.remainingMs).toBe(65_000)
  clock.close()
  expect(clock.remainingMs).toBe(0)
})

it('does not offer unused preparation to a reservation after work has expired', async () => {
  const clock = new BehaviorDeadline(55_000, 120_000)
  vi.setSystemTime(Date.now() + 55_000)
  expect(clock.remainingMs).toBe(0)
  clock.close()
})

it('does not leave a timeout behind a completed operation', async () => {
  const clock = new BehaviorDeadline(55_000, 120_000)
  clock.close()
  await vi.advanceTimersByTimeAsync(180_000)
  expect(clock.controller.signal.aborted).toBe(false)
})
