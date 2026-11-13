/** A CSS duration in milliseconds. The production build writes `500ms` as
 *  `.5s`, so the unit decides, never the bare number; anything else is the fallback. */
export function durationMs(value: string, fallback: number): number {
  const text = value.trim()
  const amount = parseFloat(text)
  if (!Number.isFinite(amount)) return fallback
  return text.endsWith('ms') ? amount : text.endsWith('s') ? amount * 1000 : fallback
}
