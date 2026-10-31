import { describe, expect, it } from 'vitest'
import { cardInsertion, cardPositions, cardRowInsertion, reconcileCardOrder } from '../src/analytics-layout'

describe('analytics card order', () => {
  it('retains saved identities, removes duplicates and missing cards, and appends new cards', () => {
    expect(reconcileCardOrder(['quota:user', 'merged', 'merged', 'retired'], ['opened', 'merged', 'quota:user', 'review']))
      .toEqual(['quota:user', 'merged', 'opened', 'review'])
  })
  it('packs mixed widths and height families without overlapping or changing reading order', () => {
    const positions = cardPositions([
      { id: 'wide', span: 10, height: 352 },
      { id: 'compact', span: 4, height: 272 },
      { id: 'regular', span: 5, height: 352 },
      { id: 'next', span: 5, height: 272 },
    ], 988)
    expect([...positions.keys()]).toEqual(['wide', 'compact', 'regular', 'next'])
    expect(positions.get('wide')).toEqual({ x: 0, y: 0, width: 488, height: 352 })
    expect(positions.get('compact')).toEqual({ x: 500, y: 0, width: 188, height: 272 })
    expect(positions.get('regular')).toEqual({ x: 700, y: 0, width: 238, height: 352 })
    expect(positions.get('next')).toEqual({ x: 0, y: 364, width: 238, height: 272 })
  })
  it('places full-width cards in separate rows at narrow widths', () => {
    expect([...cardPositions([{ id: 'first', span: 20, height: 272 }, { id: 'second', span: 20, height: 352 }], 320).values()])
      .toEqual([{ x: 0, y: 0, width: 320, height: 272 }, { x: 0, y: 284, width: 320, height: 352 }])
  })
  it('distinguishes wide-card insertions with identical wrapped destination boxes', () => {
    const cards = Array.from({ length: 8 }, (_, i) => ({ id: String(i), span: 5, height: 352 }))
    const wide = { id: 'quota', span: 10, height: 352 }
    const beforeFourth = [...cards]; beforeFourth.splice(3, 0, wide)
    const afterFourth = [...cards]; afterFourth.splice(4, 0, wide)
    expect(cardPositions(beforeFourth, 988).get('quota')).toEqual(cardPositions(afterFourth, 988).get('quota'))
    expect(cardInsertion(cards, 988, 744, 20, 8)).toBe(3)
    expect(cardInsertion(cards, 988, 994, 20, 8)).toBe(4)
    expect(cardInsertion(cards, 988, 0, 384, 8)).toBe(4)
  })
  it('moves a wide card to a different visual row rather than stepping by its own span', () => {
    const cards = [
      ...Array.from({ length: 8 }, (_, i) => ({ id: String(i), span: 5, height: 352 })),
      { id: 'work', span: 10, height: 272 }, { id: 'rounds', span: 5, height: 272 }, { id: 'share', span: 5, height: 272 },
      ...Array.from({ length: 5 }, (_, i) => ({ id: `per-pr-${i}`, span: 4, height: 272 })),
    ]
    const before = cardPositions(cards, 988).get('work')!
    const index = cardRowInsertion(cards, 988, 'work', 1)
    const next = cards.filter(card => card.id !== 'work'); next.splice(index, 0, cards[8])
    expect(cardPositions(next, 988).get('work')!.y).toBeGreaterThan(before.y)
    expect(cardRowInsertion(cards, 988, '0', -1)).toBe(0)
  })
})
