import { getMeta, setMeta } from './db'

// A restart empties every cache, so the first Board or Overview after a deploy
// waited seconds for reads the last process had already made. Poise keeps the
// GitHub reads its pages made, and shortly after a start makes them again in
// the background, with system health, so the first page finds them warm.
// Production switches builds while nobody is using it.

const KEY = 'warm_up_reads'
/** Distinct reads kept: a page or two per place, in the filters last used. */
const KEPT = 8
let reads: string[] | null = null

function kept(): string[] {
  if (reads) return reads
  try {
    const value: unknown = JSON.parse(getMeta(KEY) || '[]')
    reads = Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string').slice(0, KEPT) : []
  } catch {
    reads = []
  }
  return reads
}

/** A page's GitHub read, kept to be made again after the next start. Written
 *  only when it is new, since each commit waits for the disk. */
export function rememberRead(body: unknown): void {
  const text = JSON.stringify(body)
  const known = kept()
  if (known.includes(text)) return
  reads = [text, ...known].slice(0, KEPT)
  try { setMeta(KEY, JSON.stringify(reads)) } catch { /* kept in memory; written with the next new read */ }
}

/** Makes the kept reads again, one at a time, then system health. A read that
 *  fails is the next page's to report. */
export async function warmUp(make: { read: (body: unknown) => Promise<unknown>, health: () => Promise<unknown> }): Promise<void> {
  for (const text of kept()) {
    try { await make.read(JSON.parse(text)) } catch { /* the page reads it again */ }
  }
  try { await make.health() } catch { /* the page reads it again */ }
}
