import { describe, expect, it } from 'vitest'
import { budgetShortfall, headroomShortfall, measureBehaviorHeadroom, readBehaviorResourceAdmission } from '../server/behavior-resources'

describe('behavior resource admission', () => {
  it('is unbounded without configuration and preserves admission behavior', () => {
    expect(readBehaviorResourceAdmission({})).toBeNull()
    expect(readBehaviorResourceAdmission({ POISE_BEHAVIOR_MEMORY_BUDGET_BYTES: '  ' })).toBeNull()
  })

  it('rejects invalid budgets, reservations and silent unbounded reservations explicitly', () => {
    for (const value of ['0', '-8', '1.5', 'nope', String(Number.MAX_SAFE_INTEGER + 1)]) {
      expect(() => readBehaviorResourceAdmission({ POISE_BEHAVIOR_MEMORY_BUDGET_BYTES: value })).toThrow('POISE_BEHAVIOR_MEMORY_BUDGET_BYTES must be a positive byte count')
      expect(() => readBehaviorResourceAdmission({ POISE_BEHAVIOR_DISK_BUDGET_BYTES: value })).toThrow('POISE_BEHAVIOR_DISK_BUDGET_BYTES must be a positive byte count')
    }
    expect(() => readBehaviorResourceAdmission({ POISE_BEHAVIOR_MEMORY_RESERVATION_BYTES: '-1' })).toThrow('POISE_BEHAVIOR_MEMORY_RESERVATION_BYTES must be a nonnegative byte count')
    expect(() => readBehaviorResourceAdmission({ POISE_BEHAVIOR_MEMORY_BUDGET_BYTES: '8', POISE_BEHAVIOR_MEMORY_RESERVATION_BYTES: '0' }))
      .toThrow('POISE_BEHAVIOR_MEMORY_RESERVATION_BYTES reserves nothing')
    expect(() => readBehaviorResourceAdmission({ POISE_BEHAVIOR_DISK_BUDGET_BYTES: '8' })).toThrow('POISE_BEHAVIOR_DISK_RESERVATION_BYTES reserves nothing')
    expect(readBehaviorResourceAdmission({ POISE_BEHAVIOR_MEMORY_BUDGET_BYTES: '8', POISE_BEHAVIOR_MEMORY_RESERVATION_BYTES: '3' }))
      .toEqual({ budget: { memoryBytes: 8, diskBytes: null }, reservation: { memoryBytes: 3, diskBytes: 0 } })
  })

  it('reports durable-budget and measured-headroom shortfalls separately', () => {
    expect(budgetShortfall({ memoryBytes: 8, diskBytes: null }, { memoryBytes: 6, diskBytes: 0 }, { memoryBytes: 3, diskBytes: 0 }))
      .toBe('shared native resource budget is exhausted: memory needs 9 of 8 bytes')
    expect(budgetShortfall({ memoryBytes: 8, diskBytes: null }, { memoryBytes: 5, diskBytes: 0 }, { memoryBytes: 3, diskBytes: 0 })).toBeNull()
    expect(headroomShortfall({ freeMemoryBytes: 2, freeDiskBytes: 9, diskPath: '/tmp' }, { memoryBytes: 3, diskBytes: 4 }))
      .toBe('insufficient behavior resource headroom: only 2 bytes of free memory for a 3 byte reservation')
    expect(headroomShortfall({ freeMemoryBytes: 9, freeDiskBytes: 9, diskPath: '/tmp' }, { memoryBytes: 3, diskBytes: 4 })).toBeNull()
  })

  it('measures the tighter disposable filesystem and fails closed on probe errors', () => {
    const seen: string[] = []
    const headroom = measureBehaviorHeadroom({ freeMemory: () => 7, diskFree: (path) => { seen.push(path); return path === seen[0] ? 5 : 9 } })
    expect(headroom.freeMemoryBytes).toBe(7)
    expect(headroom).toMatchObject({ freeDiskBytes: 5, diskPath: seen[0] })
    expect(seen).toHaveLength(2)
    expect(() => measureBehaviorHeadroom({ freeMemory: () => { throw new Error('nope') } })).toThrow('behavior resource measurement unavailable: free memory read failed: nope')
    expect(() => measureBehaviorHeadroom({ freeMemory: () => -1 })).toThrow('behavior resource measurement unavailable: free memory read is invalid')
    expect(() => measureBehaviorHeadroom({ freeMemory: () => 1, diskFree: () => { throw new Error('gone') } })).toThrow('behavior resource measurement unavailable: disk read of')
    expect(() => measureBehaviorHeadroom({ freeMemory: () => 1, diskFree: () => Number.NaN })).toThrow('behavior resource measurement unavailable: disk read of')
  })
})
