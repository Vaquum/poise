// Saved model configurations (Settings → Models): named sets of model choices
// to switch between in one step, for example when a provider's quota runs out.
// Using one saves its choices through Settings' own validation.

import { getMeta, setMeta } from './db'
import { type Catalog, type ModelSettings, validateModelSettings } from './models'

const KEY = 'model_presets'
export const MAX_MODEL_PRESETS = 12
const MAX_NAME = 40

export interface ModelPreset {
  name: string
  models: ModelSettings
  savedAt: string
}

export function listModelPresets(): ModelPreset[] {
  const raw = getMeta(KEY)
  if (!raw) return []
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return [] }
  if (!Array.isArray(parsed)) return []
  return parsed.filter((preset): preset is ModelPreset => typeof preset?.name === 'string'
    && typeof preset?.savedAt === 'string' && typeof preset?.models === 'object' && preset.models !== null)
}

function presetName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!name || name.length > MAX_NAME) throw new Error(`Name the configuration in 1 to ${MAX_NAME} characters`)
  return name
}

/** Saves the choices under the name, replacing a configuration of the same name. */
export function saveModelPreset(body: unknown, catalog: Catalog, now = new Date()): ModelPreset[] {
  const { name: given, models } = (body ?? {}) as { name?: unknown, models?: unknown }
  const name = presetName(given)
  const choices = validateModelSettings(catalog, models)
  if (!Object.keys(choices).length) throw new Error('A configuration needs at least one model choice')
  const others = listModelPresets().filter((preset) => preset.name.toLowerCase() !== name.toLowerCase())
  if (others.length >= MAX_MODEL_PRESETS) throw new Error(`Keep at most ${MAX_MODEL_PRESETS} configurations; delete one first`)
  const next = [...others, { name, models: choices, savedAt: now.toISOString() }].sort((a, b) => a.name.localeCompare(b.name))
  setMeta(KEY, JSON.stringify(next))
  return next
}

export function deleteModelPreset(body: unknown): ModelPreset[] {
  const name = presetName((body as { name?: unknown } | null)?.name)
  const next = listModelPresets().filter((preset) => preset.name.toLowerCase() !== name.toLowerCase())
  setMeta(KEY, JSON.stringify(next))
  return next
}
