import { describe, expect, it, vi } from 'vitest'
import { catalogueAgents } from '../../server/chat/catalog-agents'
import { catalogueFamilies, familyForIdentity, quickSessionModel, quickSessionRequest, consoleModelLabel } from '../../src/chat-catalog'
import { CATALOG } from '../model-catalog-fixture'

describe('Chat uses the whole catalogue', () => {
  it('includes all five providers and every identity even when an adapter is unavailable', async () => {
    const probe = vi.fn(async () => ({ ok: true }))
    const agents = await catalogueAgents(CATALOG, true, probe)
    expect(agents.map(a => a.id)).toEqual(['claude', 'codex', 'grok', 'antigravity', 'muse'])
    expect(agents.flatMap(a => a.models.map(m => m.identity))).toEqual(CATALOG.models.map(m => m.identity))
    expect(agents.find(a => a.id === 'antigravity')).toMatchObject({ available: false, efforts: ['high', 'medium'], reason: expect.stringContaining('permission/question') })
    expect(probe).toHaveBeenCalledTimes(4)
  })

  it('does not drop models merely because their provider is signed out', async () => {
    const agents = await catalogueAgents(CATALOG, false, async () => ({ ok: false, reason: 'sign-in needed' }))
    expect(agents.every(a => !a.available)).toBe(true)
    expect(agents.flatMap(a => a.models)).toHaveLength(CATALOG.models.length)
  })

  it('groups model families without combining their effort variants', async () => {
    const agents = await catalogueAgents(CATALOG, true, async () => ({ ok: true }))
    const families = catalogueFamilies(agents)
    for (const row of CATALOG.models) {
      const family = familyForIdentity(families, row.identity)!
      expect(family.agent.id).toBe(row.provider)
      expect(family.models.find(m => m.effort === row.effort)).toEqual(row)
      expect(family.models.every(m => m.selector === row.selector)).toBe(true)
    }
    expect(familyForIdentity(families, 'gemini-3.8-flash-medium')?.models.map(m => m.effort)).toEqual(['high', 'medium'])
    expect(familyForIdentity(families, 'gpt-6-astra-ultra')?.models.map(m => m.effort)).toEqual(['ultra', 'max'])
  })
})


describe('Fresh console model policy', () => {
  it('sends the saved Chat default with its actual effort', async () => {
    const agents = await catalogueAgents(CATALOG, true, async () => ({ ok: true }))
    expect(quickSessionRequest(agents, undefined, 'opus-5-max')).toEqual({ agent: 'claude', model: 'opus-5-max', effort: 'max' })
    expect(quickSessionModel(agents, 'opus-5-max')).toMatchObject({ identity: 'opus-5-max', effort: 'max' })
  })
  it('sends a non-Claude saved default without switching providers', async () => {
    const agents = await catalogueAgents(CATALOG, true, async () => ({ ok: true }))
    expect(quickSessionRequest(agents, undefined, 'grok-4.6-high')).toEqual({ agent: 'grok', model: 'grok-4.6-high', effort: 'high' })
    expect(quickSessionRequest(agents, undefined, 'gpt-6-astra-ultra')).toEqual({ agent: 'codex', model: 'gpt-6-astra-ultra', effort: 'ultra' })
  })
  it('keeps a deliberate console choice instead of the saved default', async () => {
    const agents = await catalogueAgents(CATALOG, true, async () => ({ ok: true }))
    expect(quickSessionRequest(agents, 'gpt-6-astra-max', 'opus-5-max')).toEqual({ agent: 'codex', model: 'gpt-6-astra-max', effort: 'max' })
  })
  it('does not substitute another model when the saved default has retired', async () => {
    const agents = await catalogueAgents(CATALOG, true, async () => ({ ok: true }))
    expect(() => quickSessionRequest(agents, undefined, 'retired-model-max')).toThrow(/not in the current catalogue/)
    expect(quickSessionModel(agents, 'retired-model-max')).toBeUndefined()
  })
  it('does not silently fall back when the default provider is unavailable', async () => {
    const agents = await catalogueAgents(CATALOG, false, async () => ({ ok: true }))
    expect(() => quickSessionRequest(agents, undefined, 'opus-5-max')).toThrow(/unavailable/)
    expect(quickSessionRequest(agents, undefined, 'grok-4.6-high')).toEqual({ agent: 'grok', model: 'grok-4.6-high', effort: 'high' })
  })
})


describe('Console model selection', () => {
  it('resolves every launchable catalogue variant, not just the default', async () => {
    const agents = await catalogueAgents(CATALOG, true, async () => ({ ok: true }))
    for (const agent of agents.filter(a => a.available)) for (const model of agent.models) {
      expect(quickSessionRequest(agents, model.identity)).toEqual({ agent: agent.id, model: model.identity, effort: model.effort })
    }
  })
  it('keeps unavailable and retired selections from silently becoming a different model', async () => {
    const agents = await catalogueAgents(CATALOG, true, async () => ({ ok: true }))
    expect(() => quickSessionRequest(agents, 'gemini-3.8-flash-high')).toThrow(/unavailable/)
    expect(() => quickSessionRequest(agents, 'retired-model-max')).toThrow(/not in the current catalogue/)
  })
  it('labels the actual family and effort without changing catalogue identities', () => {
    expect(consoleModelLabel('opus-5-high')).toBe('Opus 5 · High')
    expect(consoleModelLabel('gpt-6-astra-max')).toBe('GPT 6 Astra · Max')
    expect(consoleModelLabel('muse-spark-1.3-contributor-xhigh')).toBe('Muse Spark 1.3 Contributor · Extra high')
  })
})

// Discovery retires concrete identities; the server re-resolves the saved
// default, and the console sends that resolution verbatim.
it('sends a re-resolved default verbatim without rewriting explicit choices', async () => {
  const models = [
    { identity: 'opus-5.5-max', provider: 'claude', selector: 'claude-opus-5-5', effort: 'max' },
    { identity: 'opus-5.5-high', provider: 'claude', selector: 'claude-opus-5-5', effort: 'high' },
  ]
  const agents = await catalogueAgents({ ...CATALOG, models }, true, async () => ({ ok: true }))
  expect(quickSessionRequest(agents, undefined, 'opus-5.5-max')).toMatchObject({ model: 'opus-5.5-max', effort: 'max' })
  expect(() => quickSessionRequest(agents, undefined, 'opus-5-max')).toThrow(/not in the current catalogue/)
  expect(quickSessionRequest(agents, 'opus-5.5-high', 'opus-5.5-max')).toMatchObject({ model: 'opus-5.5-high' })
  agents.find(a => a.id === 'claude')!.models = models.slice(0, 1)
  expect(() => quickSessionRequest(agents, 'opus-5.5-high', 'opus-5.5-max')).toThrow(/not in the current catalogue/)
  expect(consoleModelLabel('opus-5.5-high')).toBe('Opus 5.5 · High')
})
