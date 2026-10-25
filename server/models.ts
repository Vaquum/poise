// The model catalog and where Poise uses it.
//
// Caller owns the names: `agent-interface --models` exports one row per
// identity (<family>-<version>-<effort>) with the provider CLI behind it and
// the default per Caller behavior. Poise never spells a model name itself; it
// reads this catalog, lets the user pick the three slot models once — Primary,
// Secondary, Tertiary — and resolves every place against the live catalog on
// every launch — a refresh can retire an identity overnight.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { runFile } from './process'
import { agentInterfaceRoot } from '../scripts/caller.mjs'

export interface CatalogModel {
  identity: string
  provider: string
  selector: string
  effort: string
}

export interface Catalog {
  schema_version: number
  path: string
  models: CatalogModel[]
  behaviors: Record<string, string>
  debate_participants: string[]
  review_providers: string[]
  // Providers Caller can run with full access for an issue review; absent
  // from a Caller that has no issue review.
  issue_review_providers?: string[]
  policy: string
}

export function assertMuseContributor(selector: unknown): asserts selector is string {
  if (typeof selector !== 'string' || selector !== selector.trim() || !/^muse-[a-z0-9.-]+-contributor$/.test(selector)) {
    throw new Error('Muse requires an explicit contributor model selector; ordinary Muse models are prohibited')
  }
}

export const REVIEW_POLICY = 'bounded-v1'
const CATALOG_TTL_MS = 60_000
const CATALOG_PROBE_TIMEOUT_MS = 30_000

// The Claude models Caller used before identities carried their provider.
// Only the calls log still shows them; new rows always resolve via the catalog.
const RETIRED_CLAUDE_PREFIXES = ['opus-', 'fable-', 'sonnet-', 'haiku-']

export function agentInterfaceCwd(): string {
  return agentInterfaceRoot()
}

let cached: { at: number, catalog: Catalog } | null = null
let pending: Promise<Catalog> | null = null
let generation = 0

export function invalidateCatalog(): void {
  cached = null
  generation++
  pending = null
}

function parseCatalog(stdout: string): Catalog {
  let data: any
  try { data = JSON.parse(stdout) } catch { throw new Error('Update Caller: the model catalog is unavailable') }
  if (data?.schema_version !== 2 || !Array.isArray(data.models) || !data.models.length
    || typeof data.behaviors !== 'object' || !Array.isArray(data.review_providers)) {
    throw new Error('Update Caller: the model catalog is unavailable')
  }
  for (const row of data.models) {
    if (typeof row?.identity !== 'string' || typeof row.provider !== 'string') {
      throw new Error('Update Caller: the model catalog is unavailable')
    }
  }
  for (const row of data.models) {
    if (row.provider === 'muse') assertMuseContributor(row.selector)
  }
  return data as Catalog
}

export async function loadCatalog(options: { fresh?: boolean } = {}): Promise<Catalog> {
  if (!options.fresh && cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.catalog
  if (pending) return pending
  const epoch = generation
  pending = (async () => {
    try {
      const { stdout } = await runFile('agent-interface', ['--models'], {
        cwd: agentInterfaceCwd(),
        timeoutMs: CATALOG_PROBE_TIMEOUT_MS,
      })
      const catalog = parseCatalog(stdout)
      if (epoch === generation) cached = { at: Date.now(), catalog }
      return catalog
    } finally {
      if (epoch === generation) pending = null
    }
  })()
  return pending
}

export function catalogModel(catalog: Catalog, identity: string): CatalogModel | null {
  return catalog.models.find((m) => m.identity === identity) || null
}

export function isClaudeModel(catalog: Catalog | null, identity: string): boolean {
  const row = catalog ? catalogModel(catalog, identity) : null
  if (row) return row.provider === 'claude'
  return RETIRED_CLAUDE_PREFIXES.some((prefix) => identity.startsWith(prefix))
}

export function isReviewModel(catalog: Catalog, identity: string): boolean {
  const row = catalogModel(catalog, identity)
  return !!row && catalog.review_providers.includes(row.provider)
}

// Claude effort tiers, lowest first. The sign-in canary proves the
// subscription on the cheapest row rather than a hardcoded model name.
const CLAUDE_EFFORT_LADDER = ['low', 'medium', 'high', 'xhigh', 'max']

/** The cheapest Claude row for the sign-in canary; null when the catalog names none. */
export function canaryClaudeModel(catalog: Catalog): CatalogModel | null {
  const rank = (effort: string): number => {
    const index = CLAUDE_EFFORT_LADDER.indexOf(effort)
    return index < 0 ? CLAUDE_EFFORT_LADDER.length : index
  }
  let best: CatalogModel | null = null
  for (const row of catalog.models) {
    if (row.provider !== 'claude') continue
    if (!best || rank(row.effort) < rank(best.effort)) best = row
  }
  return best
}

// The providers a place can launch; null when every catalog provider can.
export function placeProviders(catalog: Catalog, place: ModelPlace): string[] | null {
  if (place === 'issue_review') return catalog.issue_review_providers ?? []
  return MODEL_PLACES.find((p) => p.key === place)!.review ? catalog.review_providers : null
}

export function isPlaceModel(catalog: Catalog, place: ModelPlace, identity: string): boolean {
  const row = catalogModel(catalog, identity)
  const providers = placeProviders(catalog, place)
  return !!row && (providers === null || providers.includes(row.provider))
}

// Every place in Poise that launches a model, with the Caller behavior whose
// catalog default seeds it when no slot model can run there. Each place picks
// a slot — Primary, Secondary or Tertiary — never a model; the slot models are
// chosen once, and changing one changes it everywhere. `review` places follow
// the providers the catalog lists as reviewing (every one of them since Caller
// #39). Reviewer places run a panel: Behaviors decides how many of the slots,
// starting at the place's slot, review each new pull request or issue, at the
// same time.
export const MODEL_PLACES = [
  {
    key: 'chat',
    label: 'Chat',
    why: 'New chats in Chat and chats started from Current cards.',
    review: false,
    reviewers: false,
    seed: 'author_content',
  },
  {
    key: 'editor',
    label: 'Editor chat',
    why: 'Document, passage and review chats in the Editor. /content and /consensus use the Caller defaults listed below.',
    review: false,
    reviewers: false,
    seed: 'author_content',
  },
  {
    key: 'pr_review',
    label: 'PR review',
    why: 'Automatic and manual reviews, including replays. The next slot takes over once if Claude hits its output limit. When Behaviors asks for more than one reviewer, the following slots review each new pull request alongside it, at the same time.',
    review: true,
    reviewers: true,
    seed: 'pr_review',
  },
  {
    key: 'pr_approve',
    label: 'PR approval',
    why: 'Automatic approvals and approval replays. The next slot takes over once if Claude hits its output limit.',
    review: true,
    reviewers: false,
    seed: 'pr_approve',
  },
  {
    key: 'issue_review',
    label: 'Issue review',
    why: 'Review New Issues and its replays. Each reviewer runs its own CLI with full access in a fresh checkout and comments as the review agent. When Behaviors asks for more than one reviewer, the following slots review each new issue alongside it, at the same time. The next slot takes over once if Claude hits its output limit.',
    review: true,
    reviewers: true,
    seed: 'pr_review',
  },
] as const

export type ModelSlot = 'primary' | 'secondary' | 'tertiary'
export const MODEL_SLOTS: readonly ModelSlot[] = ['primary', 'secondary', 'tertiary']
// Panels, the ledger and claim keys name reviewer positions with the same
// three slots: a panel reviewer runs a slot model.
export type ReviewerSlot = ModelSlot
export const REVIEWER_SLOTS: readonly ReviewerSlot[] = MODEL_SLOTS

export function isModelSlot(value: unknown): value is ModelSlot {
  return value === 'primary' || value === 'secondary' || value === 'tertiary'
}

export type ModelPlace = typeof MODEL_PLACES[number]['key']
export const MODEL_PLACE_KEYS = MODEL_PLACES.map((p) => p.key) as ModelPlace[]

// Stored: the three models chosen once, and the slot each place runs. Either
// half may be missing or partial; resolution seeds what is not there.
export interface ModelSlotChoices {
  primary?: string
  secondary?: string
  tertiary?: string
}

export interface ModelPlaceChoice {
  slot: ModelSlot
}

export interface ModelSettings {
  slots?: ModelSlotChoices
  places?: Partial<Record<ModelPlace, ModelPlaceChoice>>
}

export function isModelPlace(value: string): value is ModelPlace {
  return (MODEL_PLACE_KEYS as string[]).includes(value)
}

// Stored choices are validated against the catalog at save time; a later
// refresh can still retire one, so every read resolves again and says so.
export interface ResolvedSlots {
  primary: string
  secondary: string
  tertiary: string
  notes: string[]
}

// The extra reviewers Poise proposes until the user picks: the debate
// participants are one top-effort model per family, so walking them from the
// default's family outward gives a panel of different families. Never the
// default itself; a family already on the panel only when nothing else is left.
export function seedReviewers(catalog: Catalog, primary: string, place: ModelPlace = 'pr_review'): { secondary: string, tertiary: string } {
  const candidates = [...catalog.debate_participants, ...catalog.models.map((m) => m.identity)]
    .filter((identity, index, all) => all.indexOf(identity) === index && identity !== primary && isPlaceModel(catalog, place, identity))
  const chosen: string[] = []
  const providers = new Set([catalogModel(catalog, primary)?.provider])
  for (const identity of candidates) {
    if (chosen.length === 2) break
    const provider = catalogModel(catalog, identity)!.provider
    if (providers.has(provider)) continue
    providers.add(provider)
    chosen.push(identity)
  }
  for (const identity of candidates) {
    if (chosen.length === 2) break
    if (!chosen.includes(identity)) chosen.push(identity)
  }
  return { secondary: chosen[0] ?? primary, tertiary: chosen[1] ?? chosen[0] ?? primary }
}

// The three slot models, resolved against the live catalog: what was chosen
// while the catalog still has it, else the review default and a family-diverse
// panel seeded from it — the same three the PR review place used to seed.
export function resolveSlots(catalog: Catalog, stored: ModelSlotChoices | undefined): ResolvedSlots {
  const seedPrimary = catalog.behaviors.pr_review
  const notes: string[] = []
  const usable = (identity: string | undefined) => !!identity && !!catalogModel(catalog, identity)
  let primary = stored?.primary
  if (!usable(primary)) {
    // Like the later seats, the replacement must not repeat a saved pick:
    // the retired primary's seed may already sit in Secondary or Tertiary.
    const kept = [stored?.secondary, stored?.tertiary]
    const primarySeeds = seedReviewers(catalog, seedPrimary)
    const replacement = [seedPrimary, primarySeeds.secondary, primarySeeds.tertiary]
      .find((candidate) => usable(candidate) && !kept.includes(candidate)) ?? seedPrimary
    if (primary) notes.push(`${primary} is no longer in the catalog; using ${replacement}.`)
    primary = replacement
  }
  const seeds = seedReviewers(catalog, primary!)
  const resolved: Record<ModelSlot, string> = { primary: primary!, secondary: '', tertiary: '' }
  for (const slot of ['secondary', 'tertiary'] as const) {
    let identity = stored?.[slot]
    if (!usable(identity)) {
      // A seed may repeat a stored pick — partial slots, or a legacy pair
      // migrated into them — so a later seat takes the next seed instead.
      const seed = [seeds[slot], seeds.secondary, seeds.tertiary]
        .find((candidate) => candidate !== resolved.primary && candidate !== resolved.secondary)
        ?? seeds[slot]
      if (identity) notes.push(`${identity} is no longer in the catalog; using ${seed}.`)
      identity = seed
    }
    resolved[slot] = identity!
  }
  return { ...resolved, notes }
}

export interface ResolvedPlace {
  slot: ModelSlot
  model: string
  notes: string[]
}

// What a place launches: its slot's model when the place can run it, else the
// first following slot's model it can run, else the place's Caller seed —
// every read resolves to something launchable, and says what moved.
export function resolvePlace(catalog: Catalog, place: ModelPlace, settings: ModelSettings): ResolvedPlace {
  const spec = MODEL_PLACES.find((p) => p.key === place)!
  const slots = resolveSlots(catalog, settings.slots)
  const chosen = settings.places?.[place]?.slot ?? 'primary'
  // A Caller without the place's capability can launch none of its models;
  // keep what was chosen for when it can, and say why nothing runs meanwhile.
  if (placeProviders(catalog, place)?.length === 0) {
    return { slot: chosen, model: slots[chosen], notes: [...slots.notes, `Update Caller: ${spec.label} is unavailable.`] }
  }
  for (const slot of MODEL_SLOTS.slice(MODEL_SLOTS.indexOf(chosen))) {
    if (isPlaceModel(catalog, place, slots[slot])) {
      const notes = [...slots.notes]
      if (slot !== chosen) notes.push(`${spec.label} cannot run ${slots[chosen]}; using ${slots[slot]}.`)
      return { slot, model: slots[slot], notes }
    }
  }
  const seed = catalog.behaviors[spec.seed]
  return { slot: chosen, model: seed, notes: [...slots.notes, `${spec.label} cannot run ${slots[chosen]}; using ${seed}.`] }
}

// The reviewers of a new pull request or issue: the place's slot first, then
// the following slots it can run, as many as Behaviors asks for. A panel
// starting past Primary runs fewer than asked when the slots run out; it
// never wraps, and it never launches a model the place cannot run.
export function slotPanel(
  catalog: Catalog,
  place: ModelPlace,
  slots: { primary: string, secondary: string, tertiary: string },
  start: ModelSlot,
  count: number,
): Array<{ slot: ModelSlot, model: string, recovery: string }> {
  return MODEL_SLOTS
    .slice(MODEL_SLOTS.indexOf(start))
    .filter((slot) => isPlaceModel(catalog, place, slots[slot]))
    .slice(0, Math.max(1, Math.min(MODEL_SLOTS.length, count)))
    .map((slot) => ({ slot, model: slots[slot], recovery: recoveryModel(catalog, place, slots, slot) }))
}

// The recovery model Caller switches to after a Claude output limit: the
// first following slot's model the place can run, else Caller's own recovery.
export function recoveryModel(
  catalog: Catalog,
  place: ModelPlace,
  slots: { primary: string, secondary: string, tertiary: string },
  after: ModelSlot,
): string {
  for (const slot of MODEL_SLOTS.slice(MODEL_SLOTS.indexOf(after) + 1)) {
    if (isPlaceModel(catalog, place, slots[slot])) return slots[slot]
  }
  return catalog.behaviors.review_recovery
}

export function assertSlotsDistinct(slots: ModelSlotChoices | undefined): void {
  const seen = new Map<string, ModelSlot>()
  for (const slot of MODEL_SLOTS) {
    const identity = slots?.[slot]
    if (!identity) continue
    const clash = seen.get(identity)
    if (clash) throw new Error(`model slots ${clash} and ${slot} must be different models`)
    seen.set(identity, slot)
  }
}

export function validateModelSettings(catalog: Catalog, models: unknown): ModelSettings {
  if (typeof models !== 'object' || models === null || Array.isArray(models)) {
    throw new Error('models must be an object with slots and places')
  }
  const next: ModelSettings = {}
  const raw = models as Record<string, unknown>
  for (const key of Object.keys(raw)) {
    if (key !== 'slots' && key !== 'places') throw new Error(`unknown models section ${key}`)
  }
  if (raw.slots !== undefined) {
    if (typeof raw.slots !== 'object' || raw.slots === null || Array.isArray(raw.slots)) {
      throw new Error('model slots must be an object of primary, secondary and tertiary')
    }
    const slots: ModelSlotChoices = {}
    for (const [slot, identity] of Object.entries(raw.slots as Record<string, unknown>)) {
      if (!isModelSlot(slot)) throw new Error(`unknown model slot ${slot}`)
      if (typeof identity !== 'string' || !catalogModel(catalog, identity)) {
        throw new Error(`model slot ${slot} must be a model from the catalog`)
      }
      slots[slot] = identity
    }
    assertSlotsDistinct(slots)
    if (Object.keys(slots).length > 0) next.slots = slots
  }
  if (raw.places !== undefined) {
    if (typeof raw.places !== 'object' || raw.places === null || Array.isArray(raw.places)) {
      throw new Error('model places must be an object of places')
    }
    const places: Partial<Record<ModelPlace, ModelPlaceChoice>> = {}
    for (const [place, value] of Object.entries(raw.places as Record<string, unknown>)) {
      if (!isModelPlace(place)) throw new Error(`unknown model place ${place}`)
      const spec = MODEL_PLACES.find((p) => p.key === place)!
      const slot = (value as { slot?: unknown } | null)?.slot
      if (!isModelSlot(slot)) throw new Error(`${spec.label} slot must be primary, secondary or tertiary`)
      places[place] = { slot }
    }
    if (Object.keys(places).length > 0) next.places = places
  }
  return next
}

// Stored before slots: each place named its own default, fallback and panel.
// Fold those into the three slots, most deliberate first — the review panels,
// then every place's default, then the fallbacks — and point each place at
// the slot holding its old default, or Primary when none does.
export function migrateLegacyModelSettings(raw: Record<string, unknown>): ModelSettings {
  const at = (place: ModelPlace, field: string): string | undefined => {
    const value = (raw[place] as Record<string, unknown> | undefined)?.[field]
    return typeof value === 'string' && value ? value : undefined
  }
  const places = MODEL_PLACE_KEYS.filter((place) => at(place, 'default') && at(place, 'fallback'))
  if (places.length === 0) return {}
  const candidates = [
    ...(['pr_review', 'issue_review'] as const).flatMap((place) => [at(place, 'default'), at(place, 'secondary'), at(place, 'tertiary')]),
    ...MODEL_PLACE_KEYS.map((place) => at(place, 'default')),
    ...MODEL_PLACE_KEYS.map((place) => at(place, 'fallback')),
  ].filter((identity, index, all) => !!identity && all.indexOf(identity) === index) as string[]
  const slots: ModelSlotChoices = {}
  for (const [index, slot] of MODEL_SLOTS.entries()) {
    if (candidates[index]) slots[slot] = candidates[index]
  }
  const slotOf = new Map<string, ModelSlot>()
  for (const [index, slot] of MODEL_SLOTS.entries()) {
    if (candidates[index]) slotOf.set(candidates[index], slot)
  }
  const mapped: Partial<Record<ModelPlace, ModelPlaceChoice>> = {}
  for (const place of places) {
    mapped[place] = { slot: slotOf.get(at(place, 'default')!) ?? 'primary' }
  }
  return { slots, places: mapped }
}

// The daily refresh (scripts/refresh-models.mjs, run by Poise itself at 07:00
// in the saved timezone) leaves its last report here; the settings pane shows
// when the catalog was last checked.
export function catalogReportPath(): string {
  return process.env.POISE_MODEL_CATALOG_REPORT || join(homedir(), '.poise', 'model-catalog.json')
}

export async function readCatalogReport(): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(catalogReportPath(), 'utf8'))
  } catch {
    return null
  }
}

export async function writeCatalogReport(report: Record<string, unknown>): Promise<void> {
  const path = catalogReportPath()
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const staged = `${path}.${process.pid}.tmp`
  await writeFile(staged, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  await rename(staged, path)
}
