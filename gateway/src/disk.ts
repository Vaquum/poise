import { statfs } from 'node:fs/promises'
import type { Config } from './config.js'
import type { DockerClient } from './docker.js'
import { errorMessage, type Logger } from './log.js'

/** How often the gateway measures disk use: Docker walks every volume to size it. */
export const DISK_MEASURE_INTERVAL_MS = 60 * 60_000
/** The server's disk counts as low below this share of it free. */
export const LOW_FREE_SHARE = 0.1

const HOME_VOLUME = /^poise-home-(.+)$/

/** What the gateway last measured; Settings → Admin and the admin page show it. */
export interface DiskReport {
  measuredAt: number
  /** Bytes in each workspace's home volume, by handle. */
  workspaces: Map<string, number>
  /** The filesystem the gateway's data directory is on, which Docker's volumes share unless the operator moved them. */
  free: number | null
  total: number | null
  /** Whether free space is below LOW_FREE_SHARE of the filesystem; the last known answer when it could not be read. */
  low: boolean
}

export interface DiskWatchDeps {
  config: Config
  docker: DockerClient
  log: Logger
  now: () => number
  /** The filesystem to report free space for; statfs by default. */
  space?: (path: string) => Promise<{ free: number; total: number }>
}

async function filesystemSpace(path: string): Promise<{ free: number; total: number }> {
  const stats = await statfs(path)
  return { free: stats.bavail * stats.bsize, total: stats.blocks * stats.bsize }
}

/**
 * Measures each workspace's home volume and the server's free disk, and warns, once per crossing, when a
 * workspace grows past POISE_WORKSPACE_DISK_BUDGET or the disk runs low.
 */
export class DiskWatch {
  private report: DiskReport | null = null
  private readonly overBudget = new Set<string>()
  private low = false

  constructor(private readonly deps: DiskWatchDeps) {}

  current(): DiskReport | null {
    return this.report
  }

  async measure(): Promise<DiskReport> {
    const { config, docker, log, now } = this.deps
    const workspaces = new Map<string, number>()
    for (const [volume, bytes] of await docker.volumeSizes()) {
      const handle = HOME_VOLUME.exec(volume)?.[1]
      if (handle && bytes >= 0) workspaces.set(handle, bytes)
    }
    let free: number | null = null
    let total: number | null = null
    try {
      ;({ free, total } = await (this.deps.space ?? filesystemSpace)(config.dataDir))
    } catch (error) {
      log.warn('disk.space.unknown', { path: config.dataDir, error: errorMessage(error) })
    }
    const budget = config.workspaceDiskBudgetBytes
    for (const [handle, bytes] of workspaces) {
      const over = budget > 0 && bytes > budget
      if (over && !this.overBudget.has(handle)) log.warn('disk.workspace.over_budget', { handle, bytes, budget })
      if (!over && this.overBudget.has(handle)) log.info('disk.workspace.within_budget', { handle, bytes, budget })
      if (over) this.overBudget.add(handle)
      else this.overBudget.delete(handle)
    }
    // A failed reading says nothing about the disk: the last known state stands, so it neither clears nor repeats a warning.
    const low = free !== null && total !== null && total > 0 ? free / total < LOW_FREE_SHARE : this.low
    if (low && !this.low) log.warn('disk.low', { free, total })
    if (!low && this.low) log.info('disk.recovered', { free, total })
    this.low = low
    this.report = { measuredAt: now(), workspaces, free, total, low }
    return this.report
  }

  /** Measures now and every interval after; returns a function that stops it. */
  start(intervalMs = DISK_MEASURE_INTERVAL_MS): () => void {
    const run = () => {
      this.measure().catch((error: unknown) => this.deps.log.error('disk.measure.failed', { error: errorMessage(error) }))
    }
    run()
    const timer = setInterval(run, intervalMs)
    timer.unref()
    return () => clearInterval(timer)
  }
}
