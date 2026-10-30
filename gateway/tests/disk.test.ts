import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { DiskWatch, LOW_FREE_SHARE } from '../src/disk.js'
import type { DockerClient } from '../src/docker.js'
import { createLogger } from '../src/log.js'

const GB = 1024 ** 3

function watch(sizes: Record<string, number>, space: { free: number; total: number } | Error, budget = '50g') {
  const logs: Array<Record<string, unknown>> = []
  const config = loadConfig({
    POISE_DOMAIN: 'poise.example.com',
    POISE_GITHUB_CLIENT_ID: 'id',
    POISE_GITHUB_CLIENT_SECRET: 'secret',
    POISE_ADMINS: 'root',
    POISE_RUNTIME_IMAGE: 'poise-runtime:latest',
    POISE_GATEWAY_CONTAINER: 'poise-gateway',
    POISE_WORKSPACE_DISK_BUDGET: budget,
  })
  const state = { sizes, space }
  const docker = { volumeSizes: async () => new Map(Object.entries(state.sizes)) } as unknown as DockerClient
  const disk = new DiskWatch({
    config, docker, now: () => 1_000,
    log: createLogger((line) => logs.push(JSON.parse(line) as Record<string, unknown>)),
    space: async () => {
      if (state.space instanceof Error) throw state.space
      return state.space
    },
  })
  return { disk, logs, state, events: () => logs.map((entry) => entry.event) }
}

describe('the disk watch', () => {
  it('measures each workspace\'s home volume and the server\'s free space', async () => {
    const { disk } = watch({ 'poise-home-alice': 2 * GB, 'poise-home-bob': -1, 'poise-gateway-data': GB, other: 9 * GB }, { free: 200 * GB, total: 290 * GB })
    expect(disk.current()).toBeNull()
    const report = await disk.measure()
    expect(report).toEqual({ measuredAt: 1_000, workspaces: new Map([['alice', 2 * GB]]), free: 200 * GB, total: 290 * GB, low: false })
    expect(disk.current()).toBe(report)
  })

  it('warns once when a workspace grows past its budget, and says when it is back within it', async () => {
    const { disk, state, events, logs } = watch({ 'poise-home-alice': 51 * GB }, { free: 200 * GB, total: 290 * GB })
    await disk.measure()
    await disk.measure()
    expect(events()).toEqual(['disk.workspace.over_budget'])
    expect(logs[0]).toMatchObject({ level: 'warn', handle: 'alice', bytes: 51 * GB, budget: 50 * GB })
    state.sizes = { 'poise-home-alice': 49 * GB }
    await disk.measure()
    expect(events()).toEqual(['disk.workspace.over_budget', 'disk.workspace.within_budget'])
  })

  it('warns once when less than a tenth of the disk is free, and says when it recovers', async () => {
    const { disk, state, events } = watch({}, { free: 0.09 * 290 * GB, total: 290 * GB })
    expect(LOW_FREE_SHARE).toBe(0.1)
    expect((await disk.measure()).low).toBe(true)
    await disk.measure()
    state.space = { free: 100 * GB, total: 290 * GB }
    expect((await disk.measure()).low).toBe(false)
    expect(events()).toEqual(['disk.low', 'disk.recovered'])
  })

  it('keeps a low disk low through a reading that fails, without a recovery or a second warning', async () => {
    const { disk, state, events } = watch({}, { free: 0.09 * 290 * GB, total: 290 * GB })
    await disk.measure()
    state.space = new Error('EIO')
    expect(await disk.measure()).toMatchObject({ free: null, total: null, low: true })
    state.space = { free: 0.08 * 290 * GB, total: 290 * GB }
    await disk.measure()
    expect(events()).toEqual(['disk.low', 'disk.space.unknown'])
  })

  it('reports no budget with 0, and workspaces without free space when the filesystem cannot be asked', async () => {
    const { disk, events } = watch({ 'poise-home-alice': 500 * GB }, new Error('ENOSYS'), '0')
    const report = await disk.measure()
    expect(report).toMatchObject({ free: null, total: null, low: false })
    expect(report.workspaces.get('alice')).toBe(500 * GB)
    expect(events()).toEqual(['disk.space.unknown'])
  })
})
