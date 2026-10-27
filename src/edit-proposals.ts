import { escapeHtml } from './markdown'
import type { EditDecision } from '../server/chat/protocol'

// Proposed document edits: the JSON reply contract Editor sessions are
// asked to use, and the cards it renders as. A pure module the client and
// the server both import — the server re-parses a stored message with the
// same parser the transcript renders with, so a card index means the same
// on both sides.

export interface EditProposal {
  description?: string
  context_before?: string
  old: string
  new: string
  context_after?: string
}

export interface StructuredReply {
  chat: string
  edits?: EditProposal[]
  reply?: string
}

// Try to interpret an agent reply as a StructuredReply. Returns null on any
// deviation — non-JSON or a missing `chat` field — and the caller falls back
// to plain rendering. Invalid `edits` items are skipped, not fatal: `old`
// and `new` must both be strings (empty allowed — that's how insertions and
// deletions are expressed); the optional fields are coerced or dropped. A
// card index points into the filtered list.
export function tryParseStructuredReply(text: string): StructuredReply | null {
  const t = (text || '').trim()
  if (!t.startsWith('{')) return null
  let parsed: any
  try { parsed = JSON.parse(t) } catch { return null }
  if (!parsed || typeof parsed !== 'object') return null
  if (typeof parsed.chat !== 'string') return null
  const out: StructuredReply = { chat: parsed.chat }
  if (Array.isArray(parsed.edits)) {
    const edits: EditProposal[] = []
    for (const e of parsed.edits) {
      if (!e || typeof e !== 'object') continue
      if (typeof e.old !== 'string' || typeof e.new !== 'string') continue
      edits.push({
        description: typeof e.description === 'string' ? e.description : undefined,
        context_before: typeof e.context_before === 'string' ? e.context_before : undefined,
        old: e.old,
        new: e.new,
        context_after: typeof e.context_after === 'string' ? e.context_after : undefined,
      })
    }
    if (edits.length) out.edits = edits
  }
  if (typeof parsed.reply === 'string' && parsed.reply) out.reply = parsed.reply
  return out
}

// Render a parsed reply's cards. `key` prefixes each card's opaque DOM id;
// `states` carries the recorded decision per card index. Read-only cards show
// badges instead of buttons, with one Open in Editor button for the group.
// The suggested reply renders only for review sessions.
export function renderEditCards(
  reply: StructuredReply,
  key: string,
  states: ReadonlyMap<number, EditDecision>,
  options: { readOnly: boolean, review: boolean, deciding?: ReadonlySet<number> },
): string {
  const parts: string[] = []
  if (reply.edits?.length) {
    const cards = reply.edits.map((e, idx) => {
      const cardKey = `${key}:${idx}`
      const state = states.get(idx) || 'pending'
      const disabled = options.deciding?.has(idx) ? ' disabled' : ''
      const showOld = e.old.length > 0
      const showNew = e.new.length > 0
      const kind = showOld && showNew ? 'replace' : showOld ? 'delete' : 'insert'
      const desc = e.description
        ? `<div class="chat-edit-card-desc">${escapeHtml(e.description)}</div>`
        : ''
      const oldRow = showOld
        ? `<div class="chat-edit-card-old"><span class="chat-edit-card-mark" aria-hidden="true">−</span><span class="chat-edit-card-text">${escapeHtml(e.old)}</span></div>`
        : ''
      const newRow = showNew
        ? `<div class="chat-edit-card-new"><span class="chat-edit-card-mark" aria-hidden="true">+</span><span class="chat-edit-card-text">${escapeHtml(e.new)}</span></div>`
        : ''
      // Action row: accept / decline buttons, plus a state badge that takes
      // their place once a decision is made. Conflict keeps the buttons live
      // so the person can re-try after editing the doc back into a state
      // where `old` is findable again. Read-only cards show badges only.
      const badge = state === 'applied'
        ? '<span class="chat-edit-card-badge chat-edit-card-badge-applied">Applied</span>'
        : state === 'declined'
          ? '<span class="chat-edit-card-badge chat-edit-card-badge-declined">Declined</span>'
          : state === 'conflict'
            ? '<span class="chat-edit-card-badge chat-edit-card-badge-conflict">Conflict — text not found</span>'
            : ''
      const actions = !options.readOnly && (state === 'pending' || state === 'conflict')
        ? `<div class="chat-edit-card-actions">${badge}`
          + `<button type="button" class="chat-edit-card-btn chat-edit-card-decline" data-edit-decline${disabled}>Decline</button>`
          + `<button type="button" class="chat-edit-card-btn chat-edit-card-accept" data-edit-accept${disabled}>Accept</button></div>`
        : badge ? `<div class="chat-edit-card-actions">${badge}</div>` : ''
      return `<div class="chat-edit-card" data-kind="${kind}" data-state="${state}" data-card-key="${escapeHtml(cardKey)}" data-old="${escapeHtml(e.old)}" data-new="${escapeHtml(e.new)}" data-context-before="${escapeHtml(e.context_before || '')}" data-context-after="${escapeHtml(e.context_after || '')}" data-description="${escapeHtml(e.description || '')}">${desc}${oldRow}${newRow}${actions}</div>`
    }).join('')
    parts.push(`<div class="chat-edit-cards">${cards}</div>`)
  }
  if (options.review && reply.reply) {
    parts.push('<div class="chat-edit-cards"><div class="chat-edit-card" data-kind="reply">'
      + '<div class="chat-edit-card-desc">Suggested GitHub reply</div>'
      + `<div class="chat-edit-card-text">${escapeHtml(reply.reply)}</div>`
      + (options.readOnly
        ? ''
        : `<div class="chat-edit-card-actions"><button type="button" class="chat-edit-card-btn" data-use-suggested-reply data-reply="${escapeHtml(reply.reply)}">Use as reply</button></div>`)
      + '</div></div>')
  }
  if (options.readOnly && (reply.edits?.length || (options.review && reply.reply))) {
    parts.push('<div class="chat-edit-card-actions"><button type="button" class="chat-edit-card-btn" data-open-in-editor>Open in Editor</button></div>')
  }
  return parts.join('')
}

// Read an EditProposal back out of a `.chat-edit-card` DOM element. Mirrors
// the data-* attrs written by renderEditCards — the DOM is the source of
// truth, so cards re-rendered during reflows still produce the same value.
// Structural so the server build, which has no DOM library, still checks.
export function editFromCard(card: { dataset: Record<string, string | undefined> }): EditProposal {
  return {
    description: card.dataset.description || undefined,
    context_before: card.dataset.contextBefore || undefined,
    old: card.dataset.old || '',
    new: card.dataset.new || '',
    context_after: card.dataset.contextAfter || undefined,
  }
}
