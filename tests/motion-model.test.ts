import { expect, test } from 'vitest'
import { integrate, MOTION, MOTION_CSS, SPRING } from '../gateway/src/motion-model.js'

test('retargeting carries momentum before returning to the new destination', () => {
  let position = 0, velocity = 0
  for (let frame = 0; frame < 8; frame++) ({ position, velocity } = integrate(position, velocity, 100, .016))
  const before = position
  ;({ position, velocity } = integrate(position, velocity, 0, .008))
  expect(position).toBeGreaterThan(before)
  for (let frame = 0; frame < 200; frame++) ({ position, velocity } = integrate(position, velocity, 0, .016))
  expect(Math.abs(position)).toBeLessThan(.001)
  expect(Math.abs(velocity)).toBeLessThan(.001)
})

test('the selected model settles without an independent CSS timing model', () => {
  expect(MOTION).toMatchObject({ stiffness: 180, damping: 20, mass: 1, feedback: 100 })
  let position = 0, velocity = 0
  for (let elapsed = 0; elapsed < SPRING.duration; elapsed += 8) ({ position, velocity } = integrate(position, velocity, 1, .008))
  expect(Math.abs(position - 1)).toBeLessThan(.0008)
  expect(Math.abs(velocity)).toBeLessThan(.008)
  expect(MOTION_CSS).toContain(`--flow-settle:${SPRING.duration}ms`)
  expect(SPRING.easing).toMatch(/^linear\(0\.00000,.*1\.00000\)$/)
})

test('invalid geometry and time fail visibly', () => {
  expect(() => integrate(NaN, 0, 1, .016)).toThrow(/finite/)
  expect(() => integrate(0, Infinity, 1, .016)).toThrow(/finite/)
  expect(() => integrate(0, 0, 1, -.016)).toThrow(/non-negative/)
})
