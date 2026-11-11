// What a refused save says on its row (#556): the row's own value as the
// server now holds it. The queue has already taken the server's values, so the
// row reads them as its saved value.
import { words, type Row } from './rows'

export function conflictWords(row: Row, _current: Record<string, unknown>): string {
  const now = row.value ? words(row) : ''
  return now ? `${row.label} is now ${now}, changed in another tab or by Poise` : `${row.label} changed in another tab or by Poise`
}
