import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CATALOG, CATALOG_STDOUT, NARROW_CATALOG, PRE_ISSUE_REVIEW_CATALOG } from './model-catalog-fixture'

const mocks = vi.hoisted(() => ({ runFile: vi.fn() }))
vi.mock('../server/process', () => ({ runFile: mocks.runFile }))

const models = await import('../server/models')
const catalog = CATALOG as any
const narrow = NARROW_CATALOG as any

beforeEach(() => {
  models.invalidateCatalog()
  mocks.runFile.mockReset().mockResolvedValue({ stdout: CATALOG_STDOUT, stderr: '' })
})

describe('the catalog Poise reads from Caller', () => {
  it('is read once per minute, not per launch', async () => {
    await models.loadCatalog()
    await models.loadCatalog()
    expect(mocks.runFile).toHaveBeenCalledTimes(1)
    expect(mocks.runFile).toHaveBeenCalledWith('agent-interface', ['--models'], expect.objectContaining({ timeoutMs: 30_000 }))
  })

  it('refuses a Caller that does not export identities', async () => {
    mocks.runFile.mockResolvedValue({ stdout: JSON.stringify({ opus: 'opus-5-high', astra: 'gpt-6-astra-xhigh', policy: 'bounded-v1' }), stderr: '' })
    await expect(models.loadCatalog()).rejects.toThrow('Update Caller')
    mocks.runFile.mockResolvedValue({ stdout: 'not json', stderr: '' })
    await expect(models.loadCatalog()).rejects.toThrow('Update Caller')
  })

  it.each(['muse-spark-1.3', 'muse-spark-1.3-contributor-paid', 'muse-spark-1.3-contributor\n', '', undefined])('rejects unsafe Muse catalog selector %s', async (selector) => {
    const unsafe = JSON.parse(CATALOG_STDOUT)
    unsafe.models.find((row: { provider: string }) => row.provider === 'muse').selector = selector
    mocks.runFile.mockResolvedValue({ stdout: JSON.stringify(unsafe), stderr: '' })
    await expect(models.loadCatalog()).rejects.toThrow(/contributor/)
  })

  it('knows the provider behind every identity, and the retired Claude ones by prefix', () => {
    expect(models.isClaudeModel(catalog, 'opus-5-max')).toBe(true)
    expect(models.isClaudeModel(catalog, 'fable-5.1-xhigh')).toBe(true)
    expect(models.isClaudeModel(catalog, 'gpt-6-astra-ultra')).toBe(false)
    expect(models.isClaudeModel(catalog, 'grok-4.6-xhigh')).toBe(false)
    expect(models.isClaudeModel(catalog, 'gemini-3.8-flash-high')).toBe(false)
    expect(models.isClaudeModel(catalog, 'muse-spark-1.3-contributor-max')).toBe(false)
    // Rows the log still carries from before this catalog.
    expect(models.isClaudeModel(catalog, 'opus-4.8-max')).toBe(true)
    expect(models.isClaudeModel(catalog, 'opus-5-high')).toBe(true)
    expect(models.isClaudeModel(catalog, 'gpt-5.6-sol-ultra')).toBe(false)
    expect(models.isClaudeModel(null, 'opus-5-max')).toBe(true)
  })

  it('runs the sign-in canary on the cheapest Claude row', () => {
    expect(models.canaryClaudeModel(catalog)?.identity).toBe('opus-5-xhigh')
    const museOnly = { ...catalog, models: catalog.models.filter((row: any) => row.provider === 'muse') }
    expect(models.canaryClaudeModel(museOnly)).toBeNull()
  })
})

describe('resolving the slots against the live catalog', () => {
  it('seeds the three models from the review default and a family-diverse panel', () => {
    expect(models.resolveSlots(catalog, undefined)).toEqual({
      primary: 'opus-5-xhigh',
      secondary: 'gpt-6-astra-ultra',
      tertiary: 'grok-4.6-xhigh',
      notes: [],
    })
    // A primary from another family walks the debate participants from it outward.
    expect(models.resolveSlots(catalog, { primary: 'grok-4.6-xhigh' })).toMatchObject({
      primary: 'grok-4.6-xhigh',
      secondary: 'opus-5-max',
      tertiary: 'gpt-6-astra-ultra',
    })
    // Fewer families than seats: the panel is still three different models.
    const claudeOnly = { ...catalog, review_providers: ['claude'] }
    expect(models.seedReviewers(claudeOnly, 'opus-5-max')).toEqual({ secondary: 'opus-5-xhigh', tertiary: 'fable-5.1-max' })
  })

  it('keeps stored slot models and replaces a retired one with its seed', () => {
    const stored = { primary: 'opus-5-max', secondary: 'muse-spark-1.3-contributor-max', tertiary: 'gemini-3.8-flash-high' }
    expect(models.resolveSlots(catalog, stored)).toEqual({ ...stored, notes: [] })
    const resolved = models.resolveSlots(catalog, { ...stored, tertiary: 'gemini-3.1-pro-high' })
    expect(resolved.tertiary).toBe('grok-4.6-xhigh')
    expect(resolved.notes).toEqual(['gemini-3.1-pro-high is no longer in the catalog; using grok-4.6-xhigh.'])
  })

  it('replaces a retired primary past the saved later slots instead of repeating one', () => {
    // The review default already sits in Secondary; the replacement must skip it.
    expect(models.resolveSlots(catalog, { primary: 'opus-4.8-max', secondary: 'opus-5-xhigh', tertiary: 'gemini-3.8-flash-high' })).toEqual({
      primary: 'gpt-6-astra-ultra',
      secondary: 'opus-5-xhigh',
      tertiary: 'gemini-3.8-flash-high',
      notes: ['opus-4.8-max is no longer in the catalog; using gpt-6-astra-ultra.'],
    })
  })

  it('seeds a missing seat past the stored picks instead of repeating one', () => {
    // The tertiary seed for this primary is the stored secondary itself.
    expect(models.resolveSlots(catalog, { primary: 'opus-5-xhigh', secondary: 'grok-4.6-xhigh' })).toEqual({
      primary: 'opus-5-xhigh',
      secondary: 'grok-4.6-xhigh',
      tertiary: 'gpt-6-astra-ultra',
      notes: [],
    })
  })
})

describe('resolving a place against the slots', () => {
  const slots = { primary: 'opus-5-max', secondary: 'grok-4.6-xhigh', tertiary: 'gpt-6-astra-ultra' }

  it('runs every place on Primary until it picks another slot', () => {
    expect(models.resolvePlace(catalog, 'chat', {})).toEqual({ slot: 'primary', model: 'opus-5-xhigh', notes: [] })
    expect(models.resolvePlace(catalog, 'pr_approve', {})).toEqual({ slot: 'primary', model: 'opus-5-xhigh', notes: [] })
    const settings = { slots, places: { pr_approve: { slot: 'tertiary' } } } as never
    expect(models.resolvePlace(catalog, 'pr_approve', settings)).toEqual({ slot: 'tertiary', model: 'gpt-6-astra-ultra', notes: [] })
    expect(models.resolvePlace(catalog, 'chat', settings)).toEqual({ slot: 'primary', model: 'opus-5-max', notes: [] })
  })

  it('moves a place to the first following slot it can run, and says so', () => {
    const settings = { slots, places: { pr_approve: { slot: 'secondary' } } } as never
    // Grok cannot review on the narrow catalog; the tertiary Codex model can.
    const resolved = models.resolvePlace(narrow, 'pr_approve', settings)
    expect(resolved).toEqual({
      slot: 'tertiary',
      model: 'gpt-6-astra-ultra',
      notes: ['PR approval cannot run grok-4.6-xhigh; using gpt-6-astra-ultra.'],
    })
  })

  it('falls back to the place seed when no slot model can run there', () => {
    const unusable = { primary: 'grok-4.6-xhigh', secondary: 'grok-4.6-high', tertiary: 'gemini-3.8-flash-high' }
    expect(models.resolvePlace(narrow, 'pr_approve', { slots: unusable })).toEqual({
      slot: 'primary',
      model: 'opus-5-xhigh',
      notes: ['PR approval cannot run grok-4.6-xhigh; using opus-5-xhigh.'],
    })
  })

  it('lists the reviewers Behaviors asks for, the place slot first', () => {
    expect(models.slotPanel(catalog, 'pr_review', slots, 'primary', 1)).toEqual([
      { slot: 'primary', model: 'opus-5-max', recovery: 'grok-4.6-xhigh' },
    ])
    expect(models.slotPanel(catalog, 'pr_review', slots, 'primary', 2)).toEqual([
      { slot: 'primary', model: 'opus-5-max', recovery: 'grok-4.6-xhigh' },
      { slot: 'secondary', model: 'grok-4.6-xhigh', recovery: 'gpt-6-astra-ultra' },
    ])
    expect(models.slotPanel(catalog, 'pr_review', slots, 'primary', 7).map((r) => r.slot)).toEqual(['primary', 'secondary', 'tertiary'])
    // A panel starting past Primary runs fewer than asked when the slots run out.
    expect(models.slotPanel(catalog, 'pr_review', slots, 'secondary', 3)).toEqual([
      { slot: 'secondary', model: 'grok-4.6-xhigh', recovery: 'gpt-6-astra-ultra' },
      { slot: 'tertiary', model: 'gpt-6-astra-ultra', recovery: 'gpt-6-astra-ultra' },
    ])
    // A panel never launches a model the place cannot run.
    expect(models.slotPanel(narrow, 'pr_review', slots, 'primary', 3)).toEqual([
      { slot: 'primary', model: 'opus-5-max', recovery: 'gpt-6-astra-ultra' },
      { slot: 'tertiary', model: 'gpt-6-astra-ultra', recovery: 'gpt-6-astra-ultra' },
    ])
  })

  it("recovers with the next runnable slot, else Caller's own recovery", () => {
    expect(models.recoveryModel(catalog, 'pr_approve', slots, 'primary')).toBe('grok-4.6-xhigh')
    expect(models.recoveryModel(catalog, 'pr_approve', slots, 'tertiary')).toBe('gpt-6-astra-ultra')
    expect(models.recoveryModel(narrow, 'pr_approve', slots, 'primary')).toBe('gpt-6-astra-ultra')
  })
})

describe('validating what the settings pane saves', () => {
  it('accepts slot models and place slots, and returns only those', () => {
    const next = models.validateModelSettings(catalog, {
      slots: { primary: 'gemini-3.8-flash-high', tertiary: 'opus-5-max' },
      places: { pr_review: { slot: 'secondary', extra: 'ignored' } },
    })
    expect(next).toEqual({
      slots: { primary: 'gemini-3.8-flash-high', tertiary: 'opus-5-max' },
      places: { pr_review: { slot: 'secondary' } },
    })
  })

  it('accepts a partial save of either half', () => {
    expect(models.validateModelSettings(catalog, { slots: { secondary: 'grok-4.6-xhigh' } }))
      .toEqual({ slots: { secondary: 'grok-4.6-xhigh' } })
    expect(models.validateModelSettings(catalog, { places: { chat: { slot: 'tertiary' } } }))
      .toEqual({ places: { chat: { slot: 'tertiary' } } })
    expect(models.validateModelSettings(catalog, {})).toEqual({})
  })

  it('refuses two slots running the same model', () => {
    expect(() => models.validateModelSettings(catalog, { slots: { primary: 'opus-5-max', tertiary: 'opus-5-max' } }))
      .toThrow(/model slots primary and tertiary must be different models/)
    expect(() => models.assertSlotsDistinct({ primary: 'opus-5-max', secondary: 'opus-5-max' })).toThrow(/must be different models/)
    expect(() => models.assertSlotsDistinct({ primary: 'opus-5-max' })).not.toThrow()
  })

  it.each([
    [{ slots: { primary: 'opus' } }, /model slot primary must be a model from the catalog/],
    [{ slots: { fourth: 'opus-5-max' } }, /unknown model slot fourth/],
    [{ slots: 'opus-5-max' }, /must be an object of primary, secondary and tertiary/],
    [{ places: { chat: { slot: 'default' } } }, /Chat slot must be primary, secondary or tertiary/],
    [{ places: { canary: { slot: 'primary' } } }, /unknown model place canary/],
    [{ places: 'primary' }, /model places must be an object of places/],
    [{ chat: { default: 'opus-5-max', fallback: 'opus-5-xhigh' } }, /unknown models section chat/],
    ['opus-5-max', /object with slots and places/],
  ])('rejects %j', (value, message) => {
    expect(() => models.validateModelSettings(catalog, value)).toThrow(message)
  })
})

describe('migrating per-place choices into slots', () => {
  it('folds the review panels into the slots and points each place at its old default', () => {
    // Chat's own default is the fourth distinct identity; the three slots
    // cannot hold it, so Chat follows Primary.
    expect(models.migrateLegacyModelSettings({
      pr_review: { default: 'opus-5-max', fallback: 'gpt-6-astra-ultra', secondary: 'grok-4.6-xhigh', tertiary: 'muse-spark-1.3-contributor-max' },
      pr_approve: { default: 'grok-4.6-xhigh', fallback: 'opus-5-xhigh' },
      chat: { default: 'gemini-3.8-flash-high', fallback: 'opus-5-max' },
    })).toEqual({
      slots: { primary: 'opus-5-max', secondary: 'grok-4.6-xhigh', tertiary: 'muse-spark-1.3-contributor-max' },
      places: { pr_review: { slot: 'primary' }, pr_approve: { slot: 'secondary' }, chat: { slot: 'primary' } },
    })
  })

  it('keeps the fallbacks when fewer than three defaults were chosen', () => {
    expect(models.migrateLegacyModelSettings({
      pr_approve: { default: 'gpt-6-astra-ultra', fallback: 'opus-5-xhigh' },
    })).toEqual({
      slots: { primary: 'gpt-6-astra-ultra', secondary: 'opus-5-xhigh' },
      places: { pr_approve: { slot: 'primary' } },
    })
  })

  it('ignores places without a default and fallback, and returns nothing for none', () => {
    expect(models.migrateLegacyModelSettings({ chat: { default: 'opus-5-max' } })).toEqual({})
    expect(models.migrateLegacyModelSettings({})).toEqual({})
  })
})

describe('the Issue review place', () => {
  const issueOnly = { ...catalog, issue_review_providers: ['claude', 'grok'] }

  it('runs its slot, and draws its panel from the issue review providers', () => {
    expect(models.placeProviders(catalog, 'issue_review')).toEqual(['antigravity', 'claude', 'codex', 'grok', 'muse'])
    const slots = { primary: 'opus-5-max', secondary: 'muse-spark-1.3-contributor-max', tertiary: 'grok-4.6-xhigh' }
    expect(models.resolvePlace(issueOnly, 'issue_review', { slots })).toEqual({ slot: 'primary', model: 'opus-5-max', notes: [] })
    // Muse cannot run an issue review on the narrowed catalog; the panel skips it.
    expect(models.slotPanel(issueOnly, 'issue_review', slots, 'primary', 3)).toEqual([
      { slot: 'primary', model: 'opus-5-max', recovery: 'grok-4.6-xhigh' },
      { slot: 'tertiary', model: 'grok-4.6-xhigh', recovery: 'gpt-6-astra-ultra' },
    ])
  })

  it('says Caller must be updated, and keeps the choice, when Caller has no issue review', () => {
    const settings = { slots: { primary: 'grok-4.6-xhigh', secondary: 'opus-5-max' }, places: { issue_review: { slot: 'secondary' } } } as never
    const resolved = models.resolvePlace(PRE_ISSUE_REVIEW_CATALOG as any, 'issue_review', settings)
    expect(resolved).toEqual({ slot: 'secondary', model: 'opus-5-max', notes: ['Update Caller: Issue review is unavailable.'] })
  })
})

it('does not reuse an in-flight old catalogue after discovery invalidates it', async () => {
  let release!: (value: { stdout: string, stderr: string }) => void
  mocks.runFile.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const old = models.loadCatalog()
  models.invalidateCatalog()
  const next = { ...CATALOG, models: CATALOG.models.map(row => ({ ...row,
    identity: row.identity.replace('opus-5-', 'opus-5.5-'),
    selector: row.selector.replace(/^claude-opus-5$/, 'claude-opus-5-5'),
  })) }
  mocks.runFile.mockResolvedValueOnce({ stdout: JSON.stringify(next), stderr: '' })
  const fresh = models.loadCatalog()
  expect(mocks.runFile).toHaveBeenCalledTimes(2)
  expect(await fresh).toEqual(next)
  release({ stdout: CATALOG_STDOUT, stderr: '' })
  await old
  expect(await models.loadCatalog()).toEqual(next)
})
