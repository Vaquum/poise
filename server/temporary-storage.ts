import { statfs } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { db, getMeta, setMeta } from './db'
import { raiseAlert, resolveAlert } from './alerts/store'

export const TEMPORARY_STORAGE_GB = 1024 ** 3
export const TEMPORARY_STORAGE_CHECK_MS = 60_000
const BUCKET_KEY = 'temporary_storage_warning_bucket'
const alertKey = (bucket: number) => `temporary-storage:${bucket}`

/** Warn on downward crossings only; storage never gates or stops work. */
export function temporaryStorageMeasured(free: number): void {
  if (!Number.isFinite(free) || free < 0) throw new Error('temporary storage free bytes must be nonnegative')
  const bucket = Math.max(1, Math.min(6, Math.ceil(free / TEMPORARY_STORAGE_GB)))
  db.transaction(() => {
    const previous = Number(getMeta(BUCKET_KEY) ?? '6')
    if (!Number.isInteger(previous) || previous < 1 || previous > 6) throw new Error('invalid temporary storage warning bucket')
    // Rearm after a full GB of recovery above the first warning. Oscillating
    // near a threshold must not create repeated desktop notifications.
    if (bucket >= previous && free < 6 * TEMPORARY_STORAGE_GB) return
    if (bucket === previous) return
    for (let level = 1; level <= 5; level++) resolveAlert(alertKey(level))
    if (bucket < previous && bucket <= 5) {
      raiseAlert({
        kind: 'storage_low',
        dedupeKey: alertKey(bucket),
        title: `Temporary space is down to ${bucket} GB`,
        body: `${(free / TEMPORARY_STORAGE_GB).toFixed(1)} GB remains for temporary files. Work continues normally.`,
        path: '/',
      })
    }
    setMeta(BUCKET_KEY, String(bucket))
  })()
}

export async function checkTemporaryStorage(read = () => statfs(tmpdir())): Promise<void> {
  try {
    const stats = await read()
    temporaryStorageMeasured(stats.bavail * stats.bsize)
  } catch (error) {
    console.error('[storage] could not measure temporary space:', error)
  }
}

let timer: ReturnType<typeof setInterval> | null = null
let pass: Promise<void> | null = null

export function startTemporaryStorageRuntime(): void {
  if (timer) return
  const run = () => {
    if (pass) return
    pass = checkTemporaryStorage().finally(() => { pass = null })
  }
  timer = setInterval(run, TEMPORARY_STORAGE_CHECK_MS)
  timer.unref?.()
  run()
}

export async function stopTemporaryStorageRuntime(): Promise<void> {
  if (timer) clearInterval(timer)
  timer = null
  await pass
}
