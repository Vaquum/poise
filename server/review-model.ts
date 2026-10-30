import { claudeAuth } from './claude-auth'
import { MODEL_SLOTS, REVIEW_POLICY, type Catalog, type ModelSlot, type ResolvedSlots, isClaudeModel, isPlaceModel, loadCatalog, placeProviders, randomDrawStillValid as drawStillValid, randomPanel, recoveryModel, resolvePlace, resolveSlots, slotPanel } from './models'
import { getModelSettings } from './settings'

export { REVIEW_POLICY }

export interface ReviewChoice {
  model: string
  recovery: string
  slot: ModelSlot
  catalog: Catalog
}

export type ReviewPlace = 'pr_review' | 'pr_approve' | 'issue_review'

// Older Caller versions silently ignore --model on PR behaviors and know
// nothing of identities, and a Caller without --issue-review lists no issue
// review providers. Prove support before launching so the selected model can
// never silently become another one.
async function supportedCatalog(place: ReviewPlace): Promise<Catalog> {
  const catalog = await loadCatalog()
  if (place === 'issue_review') {
    if (!placeProviders(catalog, place)?.length) throw new Error('Update Caller: issue review is unavailable')
  } else if (catalog.policy !== REVIEW_POLICY) {
    throw new Error('Update Caller: PR review model selection is unavailable')
  }
  return catalog
}

export async function reviewChoice(place: ReviewPlace, random: () => number = Math.random): Promise<ReviewChoice> {
  const catalog = await supportedCatalog(place)
  const settings = getModelSettings()
  const stored = settings.places?.[place]?.slot ?? 'primary'
  const resolved = resolvePlace(catalog, place, settings, random)
  const slots = resolveSlots(catalog, settings.slots)
  if (stored === 'random') {
    // Recovery is another runnable the run has not tried, drawn at random.
    const remaining = MODEL_SLOTS.filter((slot) => slot !== resolved.slot && isPlaceModel(catalog, place, slots[slot]))
    const recovery = remaining.length > 0
      ? slots[remaining[Math.floor(random() * remaining.length) % remaining.length]]
      : recoveryModel(catalog, place, slots, resolved.slot)
    return { model: resolved.model, recovery, slot: resolved.slot, catalog }
  }
  return { model: resolved.model, recovery: recoveryModel(catalog, place, slots, resolved.slot), slot: resolved.slot, catalog }
}

export interface ReviewPanel {
  reviewers: Array<{ slot: ModelSlot, model: string, recovery: string }>
  catalog: Catalog
}

// The reviewers of a new pull request or issue, the place's slot first: as
// many of the following slots as Behaviors asks for, each with the recovery
// model after its own slot. A Random place draws N distinct runnable slots in
// shuffled order instead. When no slot model can run there, the one
// launchable resolution still reviews.
export async function reviewPanel(
  count: number,
  place: 'pr_review' | 'issue_review' = 'pr_review',
  random: () => number = Math.random,
): Promise<ReviewPanel> {
  const catalog = await supportedCatalog(place)
  const settings = getModelSettings()
  const stored = settings.places?.[place]?.slot ?? 'primary'
  const start = resolvePlace(catalog, place, settings, random)
  const slots = resolveSlots(catalog, settings.slots)
  const reviewers = stored === 'random'
    ? randomPanel(catalog, place, slots, count, random)
    : slotPanel(catalog, place, slots, start.slot, count)
  if (reviewers.length === 0) {
    reviewers.push({ slot: start.slot, model: start.model, recovery: recoveryModel(catalog, place, slots, start.slot) })
  }
  return { reviewers, catalog }
}

// Whether launching this identity needs the Claude.ai sign-in Poise monitors.
export function needsClaude(catalog: Catalog | null, identity: string): boolean {
  return isClaudeModel(catalog, identity)
}

// Revalidation for a prepared Random draw against the live configuration:
// true while the place still draws at random and the prepared model is still
// one of its runnable slot models. Callers use this instead of comparing two
// draws, which vary by design.
export async function randomDrawStillValid(place: ReviewPlace, model: string): Promise<boolean> {
  const catalog = await loadCatalog()
  return drawStillValid(catalog, place, getModelSettings(), model)
}

// Fallback for non-review places: when the wanted model is a Claude model and
// the sign-in is not ready, the first following slot on another provider
// still launches. When every later slot is Claude too, the wanted model
// stands and the sign-in gate says so.
export function launchable(
  catalog: Catalog,
  requested: string | undefined,
  resolved: { slot: ModelSlot, model: string },
  slots: ResolvedSlots,
): string {
  const wanted = requested || resolved.model
  if (!isClaudeModel(catalog, wanted) || claudeAuth.snapshot().status === 'authenticated') return wanted
  for (const slot of MODEL_SLOTS.slice(MODEL_SLOTS.indexOf(resolved.slot) + 1)) {
    if (!isClaudeModel(catalog, slots[slot])) return slots[slot]
  }
  return wanted
}
