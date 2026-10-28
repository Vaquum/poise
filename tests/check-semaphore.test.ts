import { describe, expect, it, vi } from 'vitest'
import { CheckSemaphore, checkSlotsBusyError, DEFAULT_CHECK_SLOT_CAP } from '../server/check-semaphore'

describe('shared check slots', () => {
  it('defaults to the same budget Chat settings use', () => {
    expect(DEFAULT_CHECK_SLOT_CAP).toBe(4)
    expect(new CheckSemaphore(() => DEFAULT_CHECK_SLOT_CAP).stats().cap).toBe(4)
  })

  it('runs at most K of N concurrent check requests, granting the rest in FIFO order', async () => {
    const sem = new CheckSemaphore(() => 2)
    const order: number[] = []
    const gates = [0, 1, 2, 3, 4].map((i) => sem.acquire('person').then((release) => {
      order.push(i)
      return release
    }))
    expect(sem.stats()).toMatchObject({ cap: 2, running: 2, queued: 3 })
    const releases = [await gates[0], await gates[1]]
    expect(order).toEqual([0, 1])
    releases[0]()
    expect(sem.stats()).toMatchObject({ running: 2, queued: 2 })
    releases.push(await gates[2])
    expect(order).toEqual([0, 1, 2])
    releases[1]()
    releases.push(await gates[3])
    releases[2]()
    releases.push(await gates[4])
    expect(order).toEqual([0, 1, 2, 3, 4])
    expect(sem.stats()).toMatchObject({ running: 2, queued: 0 })
    for (const release of releases.slice(3)) release()
    expect(sem.stats()).toMatchObject({ running: 0, queued: 0 })
  })

  it('takes immediately with tryAcquire or fails fast when full', () => {
    const sem = new CheckSemaphore(() => 1)
    const first = sem.tryAcquire('person')
    expect(first).not.toBeNull()
    expect(sem.tryAcquire('person')).toBeNull()
    first!()
    expect(sem.tryAcquire('person')).not.toBeNull()
  })

  it('keeps one slot free of background work while the budget holds two', () => {
    const sem = new CheckSemaphore(() => 2)
    expect(sem.tryAcquire('background')).not.toBeNull()
    expect(sem.tryAcquire('background')).toBeNull()
    expect(sem.available('background')).toBe(false)
    expect(sem.available('person')).toBe(true)
    const person = sem.tryAcquire('person')
    expect(person).not.toBeNull()
    expect(sem.tryAcquire('person')).toBeNull()
    expect(sem.stats()).toMatchObject({ running: 2, personRunning: 1, backgroundRunning: 1 })
    person!()
  })

  it('grants a waiting person turn before an earlier background waiter', async () => {
    const sem = new CheckSemaphore(() => 2)
    const backgroundHold = await sem.acquire('background')
    const personHold = await sem.acquire('person')
    let backgroundGranted = false
    let personGranted = false
    const backgroundWait = sem.acquire('background').then((release) => { backgroundGranted = true; return release })
    const personWait = sem.acquire('person').then((release) => { personGranted = true; return release })
    expect(sem.stats().queued).toBe(2)
    backgroundHold()
    const personRelease = await personWait
    expect(personGranted).toBe(true)
    expect(backgroundGranted).toBe(false)
    personHold()
    const backgroundRelease = await backgroundWait
    expect(backgroundGranted).toBe(true)
    personRelease()
    backgroundRelease()
  })

  it('drops the reservation at a cap of one so background work cannot deadlock', () => {
    const sem = new CheckSemaphore(() => 1)
    expect(sem.laneCapacity('behavior')).toBe(1)
    expect(sem.laneCapacity('background')).toBe(1)
    expect(sem.available('background')).toBe(true)
    const hold = sem.tryAcquire('background')
    expect(hold).not.toBeNull()
    expect(sem.tryAcquire('person')).toBeNull()
    hold!()
  })

  it('starts waiters when the cap rises and converges when it falls', async () => {
    let cap = 1
    const sem = new CheckSemaphore(() => cap)
    expect(sem.laneCapacity('person')).toBe(1)
    const hold = await sem.acquire('person')
    let granted = false
    const waiter = sem.acquire('person').then((release) => { granted = true; return release })
    expect(sem.stats().queued).toBe(1)
    cap = 2
    expect(sem.laneCapacity('person')).toBe(2)
    expect(sem.laneCapacity('behavior')).toBe(1)
    sem.grant()
    const release = await waiter
    expect(granted).toBe(true)
    cap = 1
    const late = sem.acquire('person')
    hold()
    expect(sem.stats()).toMatchObject({ running: 1, queued: 1 })
    release()
    const lateRelease = await late
    expect(sem.stats()).toMatchObject({ running: 1, queued: 0 })
    lateRelease()
  })

  it('rejects a parked waiter on abort with its own error and reports queue age', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    try {
      const sem = new CheckSemaphore(() => 1)
      const hold = await sem.acquire('person')
      let queuedCalls = 0
      const controller = new AbortController()
      const parked = sem.acquire('person', {
        signal: controller.signal,
        onQueued: () => { queuedCalls += 1 },
        abortError: () => new Error('cancelled before it started'),
      })
      expect(queuedCalls).toBe(1)
      vi.setSystemTime(new Date('2026-01-01T00:00:01.500Z'))
      expect(sem.stats()).toMatchObject({ queued: 1, oldestQueueAgeMs: 1500 })
      controller.abort()
      await expect(parked).rejects.toThrow('cancelled before it started')
      expect(sem.stats()).toMatchObject({ queued: 0, oldestQueueAgeMs: 0 })
      hold()
      // The fast path never reports a queue.
      let fastQueued = 0
      const fast = await sem.acquire('person', { onQueued: () => { fastQueued += 1 } })
      expect(fastQueued).toBe(0)
      fast()
    } finally {
      vi.useRealTimers()
    }
  })

  it('records the longest wait a grant observed', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    try {
      const sem = new CheckSemaphore(() => 1)
      const hold = await sem.acquire('person')
      const waiter = sem.acquire('person')
      vi.setSystemTime(new Date('2026-01-01T00:00:02.000Z'))
      hold()
      const release = await waiter
      expect(sem.stats().maxWaitMs).toBe(2000)
      release()
      expect(sem.stats().maxWaitMs).toBe(2000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('releases at most once', () => {
    const sem = new CheckSemaphore(() => 1)
    const release = sem.tryAcquire('person')!
    release()
    release()
    expect(sem.stats().running).toBe(0)
  })

  it('names the shared budget in the busy error', () => {
    expect(checkSlotsBusyError(4).message).toBe('all 4 shared check slots are busy; will retry')
  })

  it('leaves one background slot free for behavior runs while the budget holds three', () => {
    const sem = new CheckSemaphore(() => 4)
    const first = sem.tryAcquire('background')
    const second = sem.tryAcquire('background')
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    // Chat worker turns filled their share...
    expect(sem.tryAcquire('background')).toBeNull()
    expect(sem.available('background')).toBe(false)
    // ...but a behavior run still starts, and the person's slot stays untouched.
    expect(sem.available('behavior')).toBe(true)
    const behavior = sem.tryAcquire('behavior')
    expect(behavior).not.toBeNull()
    expect(sem.available('behavior')).toBe(false)
    expect(sem.available('person')).toBe(true)
    expect(sem.stats()).toMatchObject({ running: 3, personRunning: 0, backgroundRunning: 2, behaviorRunning: 1 })
    first!()
    second!()
    behavior!()
  })

  it('grants a waiting behavior run before an earlier background waiter', async () => {
    const sem = new CheckSemaphore(() => 3)
    const backgroundHold = await sem.acquire('background')
    const behaviorHold = await sem.acquire('behavior')
    let backgroundGranted = false
    let behaviorGranted = false
    const backgroundWait = sem.acquire('background').then((release) => { backgroundGranted = true; return release })
    const behaviorWait = sem.acquire('behavior').then((release) => { behaviorGranted = true; return release })
    expect(sem.stats().queued).toBe(2)
    backgroundHold()
    const behaviorRelease = await behaviorWait
    expect(behaviorGranted).toBe(true)
    expect(backgroundGranted).toBe(false)
    behaviorHold()
    const backgroundRelease = await backgroundWait
    expect(backgroundGranted).toBe(true)
    behaviorRelease()
    backgroundRelease()
  })

  it('drops the behavior reservation when the background budget holds one', () => {
    const sem = new CheckSemaphore(() => 2)
    const hold = sem.tryAcquire('background')
    expect(hold).not.toBeNull()
    // No room for a second background share: the behavior run sheds...
    expect(sem.tryAcquire('behavior')).toBeNull()
    hold!()
    // ...but with the budget drained it starts.
    const behavior = sem.tryAcquire('behavior')
    expect(behavior).not.toBeNull()
    behavior!()
  })

  it('notifies release listeners once per holding', () => {
    const sem = new CheckSemaphore(() => 1)
    let calls = 0
    const unsubscribe = sem.onRelease(() => { calls += 1 })
    const release = sem.tryAcquire('person')!
    release()
    release()
    expect(calls).toBe(1)
    unsubscribe()
    const second = sem.tryAcquire('person')!
    second()
    expect(calls).toBe(1)
  })
})
