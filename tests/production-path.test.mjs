import { describe, expect, it } from 'vitest'
import { servicePath } from '../scripts/production-path.mjs'

describe('the PATH the launchd services run with', () => {
  it('puts the Caller virtualenv first, then the provider CLIs in ~/.local/bin, then the system', () => {
    expect(servicePath('/Users/me', '/Users/me/.poise/production/caller/.venv/bin')).toBe(
      '/Users/me/.poise/production/caller/.venv/bin:/Users/me/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    )
  })

  it('serves the doctor without a Caller', () => {
    expect(servicePath('/Users/me')).toBe('/Users/me/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin')
  })
})
