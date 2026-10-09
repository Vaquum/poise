import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CATALOG } from './model-catalog-fixture'

// Saved model configurations (server/model-presets.ts): named sets of model
// choices, validated like Settings' own save, kept in the meta table.
const mocks = vi.hoisted(() => ({ store: new Map<string, string>() }))

vi.mock('../server/db', () => ({
  getMeta: (k: string) => mocks.store.get(k) ?? null,
  setMeta: (k: string, v: string) => { mocks.store.set(k, v) },
}))

const { deleteModelPreset, listModelPresets, saveModelPreset, MAX_MODEL_PRESETS } = await import('../server/model-presets')
const catalog = CATALOG as never
const CHAT = { chat: { default: 'grok-4.6-xhigh', fallback: 'opus-5-max' } }
const NOW = new Date('2026-10-09T12:00:00Z')

beforeEach(() => mocks.store.clear())

describe('saved model configurations', () => {
  it('saves the choices under a name, replaces one of the same name, and deletes it', () => {
    expect(listModelPresets()).toEqual([])
    expect(saveModelPreset({ name: ' Quota day ', models: CHAT }, catalog, NOW)).toEqual([{ name: 'Quota day', models: CHAT, savedAt: NOW.toISOString() }])
    const other = { chat: { default: 'opus-5-max', fallback: 'grok-4.6-high' } }
    saveModelPreset({ name: 'Normal', models: other }, catalog, NOW)
    expect(saveModelPreset({ name: 'quota DAY', models: other }, catalog, NOW).map((preset) => [preset.name, preset.models])).toEqual([
      ['Normal', other], ['quota DAY', other],
    ])
    expect(deleteModelPreset({ name: 'normal' }).map((preset) => preset.name)).toEqual(['quota DAY'])
    expect(listModelPresets().map((preset) => preset.name)).toEqual(['quota DAY'])
  })

  it('refuses a missing or long name, choices the catalog does not have, and none at all', () => {
    expect(() => saveModelPreset({ name: '  ', models: CHAT }, catalog)).toThrow(/Name the configuration/)
    expect(() => saveModelPreset({ name: 'x'.repeat(41), models: CHAT }, catalog)).toThrow(/Name the configuration/)
    expect(() => saveModelPreset({ name: 'Bad', models: { chat: { default: 'no-such-model', fallback: 'opus-5-max' } } }, catalog)).toThrow(/catalog/)
    expect(() => saveModelPreset({ name: 'Empty', models: {} }, catalog)).toThrow(/at least one model choice/)
    expect(listModelPresets()).toEqual([])
  })

  it('keeps at most twelve, and ignores a stored value it cannot read', () => {
    for (let i = 0; i < MAX_MODEL_PRESETS; i++) saveModelPreset({ name: `Set ${i}`, models: CHAT }, catalog)
    expect(() => saveModelPreset({ name: 'One more', models: CHAT }, catalog)).toThrow(/at most 12/)
    expect(saveModelPreset({ name: 'Set 3', models: CHAT }, catalog)).toHaveLength(MAX_MODEL_PRESETS)
    mocks.store.set('model_presets', 'not json')
    expect(listModelPresets()).toEqual([])
  })
})
