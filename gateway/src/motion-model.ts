/** Pure presentation model shared by the gateway renderer and browser client. */
export const MOTION = Object.freeze({ stiffness: 180, damping: 20, mass: 1, travel: 20, information: 8, feedback: 100 })

export function integrate(position: number, velocity: number, target: number, seconds: number): { position: number, velocity: number } {
  if (![position, velocity, target, seconds].every(Number.isFinite) || seconds < 0) throw new Error('Motion requires finite positions and a non-negative time step.')
  const steps = Math.max(1, Math.ceil(seconds / .008))
  const dt = seconds / steps
  for (let step = 0; step < steps; step++) {
    velocity += (-MOTION.stiffness * (position - target) - MOTION.damping * velocity) / MOTION.mass * dt
    position += velocity * dt
  }
  return { position, velocity }
}

function curve(): { duration: number, easing: string } {
  const samples = [0]
  let position = 0, velocity = 0
  do {
    const next = integrate(position, velocity, 1, .008)
    position = next.position; velocity = next.velocity
    samples.push(position)
  } while (Math.abs(position - 1) > .0008 || Math.abs(velocity) > .008)
  samples[samples.length - 1] = 1
  return { duration: (samples.length - 1) * 8, easing: `linear(${samples.map(value => value.toFixed(5)).join(',')})` }
}

export const SPRING = Object.freeze(curve())
export const MOTION_CSS = `--flow-settle:${SPRING.duration}ms;--flow-spring:${SPRING.easing};--flow-feedback:${MOTION.feedback}ms;--flow-feedback-ease:ease-out;`
