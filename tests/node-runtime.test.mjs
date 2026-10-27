import { describe, expect, it, vi } from 'vitest'
import { selectNodeRuntime, supportedNodeVersion } from '../scripts/self-update/node-runtime.mjs'

describe('the installed Node runtime', () => {
  it.each(['v22.13.0', 'v22.23.1', '22.13.1'])('accepts the supported Node 22 version %s', (version) => {
    expect(supportedNodeVersion(version)).toBe(true)
  })

  it.each(['v18.20.0', 'v20.19.0', 'v22.12.0', 'v23.10.0', 'v24.0.0', 'v22.13', 'v22.13.0-rc.1', 'unknown'])(
    'rejects an excluded or malformed runtime %s', (version) => {
      expect(supportedNodeVersion(version)).toBe(false)
    },
  )

  function selection(versions, options = {}) {
    const isExecutable = vi.fn(async (path) => path in versions)
    const readVersion = vi.fn(async (path) => versions[path])
    return { isExecutable, readVersion, result: selectNodeRuntime({ explicitNode: null, currentNode: '/custom/node', isExecutable, readVersion, ...options }) }
  }

  it('keeps the invoking Node 22 ahead of other Homebrew installations', async () => {
    const { result, readVersion } = selection({
      '/custom/node': 'v22.23.1',
      '/opt/homebrew/opt/node@20/bin/node': 'v20.19.0',
      '/opt/homebrew/opt/node@24/bin/node': 'v24.0.0',
    })
    await expect(result).resolves.toBe('/custom/node')
    expect(readVersion).toHaveBeenCalledTimes(1)
  })

  it('retains the stable Homebrew Node 22 path instead of a versioned Cellar executable', async () => {
    const currentNode = '/opt/homebrew/Cellar/node@22/22.23.1/bin/node'
    const { result } = selection({ [currentNode]: 'v22.23.1', '/opt/homebrew/opt/node@22/bin/node': 'v22.23.1' }, { currentNode })
    await expect(result).resolves.toBe('/opt/homebrew/opt/node@22/bin/node')
  })

  it('finds Homebrew Node 22 when the invoking runtime is unsupported', async () => {
    const { result } = selection({ '/custom/node': 'v24.0.0', '/usr/local/opt/node@22/bin/node': 'v22.13.1' })
    await expect(result).resolves.toBe('/usr/local/opt/node@22/bin/node')
  })

  it('fails instead of selecting Homebrew Node 20 or 24', async () => {
    const { result } = selection({
      '/custom/node': 'v23.10.0',
      '/opt/homebrew/opt/node@20/bin/node': 'v20.19.0',
      '/opt/homebrew/opt/node@24/bin/node': 'v24.0.0',
    })
    await expect(result).rejects.toThrow('Node.js 22 (minimum 22.13)')
  })

  it('honors an explicit Node 22 override', async () => {
    const { result } = selection({ '/custom/node': 'v22.13.0', '/chosen/node': 'v22.23.1' }, { explicitNode: '/chosen/node' })
    await expect(result).resolves.toBe('/chosen/node')
  })

  it.each(['v20.19.0', 'v22.12.0', 'v24.0.0'])('rejects an explicit %s override without silently using another runtime', async (version) => {
    const { result } = selection({ '/custom/node': 'v22.23.1', '/chosen/node': version }, { explicitNode: '/chosen/node' })
    await expect(result).rejects.toThrow('POISE_NODE /chosen/node must point to Node.js 22')
  })
})
