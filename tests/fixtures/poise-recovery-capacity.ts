export function remainingProbeCapacity(limit: number, active: number): number {
  return Math.max(1, limit - active)
}
