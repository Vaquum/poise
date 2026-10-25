import { expect, it } from 'vitest'
import { remainingProbeCapacity } from './fixtures/poise-recovery-capacity'

it.each([[0, 0, 0], [3, 3, 0], [3, 6, 0], [3, 1, 2]])(
  'keeps remaining admission capacity within its budget (%i, %i)',
  (limit, active, expected) => {
    expect(remainingProbeCapacity(limit, active)).toBe(expected)
  },
)
