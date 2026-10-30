import { patchContent } from '../dom-patch'
import { shortTime } from '../clock'
import { effectiveTimezone } from '../config'
import { locateReview, REVIEW_INTERVAL_MS, type ArticleReview, type ArticleReviews } from '../publishing-review'
import { closeInlineThread, inlineThreadSubjectInView } from './editor-inline-thread'
import type { ChatSubject } from '../../server/chat/protocol'

interface Host {
  view: HTMLElement
  document: HTMLElement
  text(): string
  range(start: number, end: number): Range | null
  beforeOpen(): void
  openThread(review: ArticleReview, render: (section: HTMLElement) => void): void
}

const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
// GitHub URLs are remote data too. Never put an arbitrary protocol in an href.
const link = (value: string) => /^https:\/\/github\.com\//.test(value) ? escape(value) : '#'
const empty = (): ArticleReviews => ({ reviews: [], checkedAt: null, active: false, stale: false, problems: [] })

/** Only this visible document drives synchronization; geometry and typing are local. */
export class EditorReviews {
  private slug: string | null = null
  private data = empty()
  private timer?: ReturnType<typeof setTimeout>
  private pending?: Promise<void>
  private generation = 0
  private revision = 0
  private running = false
  private selected: string | null = null
  /** The thread section the GitHub conversation renders into, while open. */
  private section: HTMLElement | null = null
  private actions = new Set<string>()
  private error = ''
  private drafts = new Map<string, string>()
  private list: HTMLElement
  private overlay: HTMLElement

  constructor(private host: Host) {
    this.list = document.createElement('section')
    this.list.className = 'editor-review-list'
    this.list.setAttribute('aria-label', 'Article reviews')
    this.list.hidden = true
    host.view.querySelector('.editor-page')!.before(this.list)
    this.overlay = document.createElement('div')
    this.overlay.className = 'editor-annotations editor-review-overlay'
    host.view.querySelector('.editor-page')!.appendChild(this.overlay)
    this.list.addEventListener('click', (event) => this.click(event))
    this.overlay.addEventListener('click', (event) => {
      const id = (event.target as HTMLElement).closest<HTMLElement>('[data-review]')?.dataset.review
      if (id) this.open(id)
    })
    // A suggested reply fills the reply box; it posts nothing by itself. The
    // textarea is restored from drafts, and act() posts it, so replacing the
    // entry and re-rendering is the whole implementation.
    window.addEventListener('chat:use-suggested-reply', (event) => {
      const detail = (event as CustomEvent<{ subject: ChatSubject, text: string }>).detail
      if (detail?.subject?.surface !== 'editor-review') return
      this.drafts.set(detail.subject.key, detail.text)
      if (this.slug && detail.subject.key.startsWith(`${this.slug}:`)) this.render()
    })
    document.addEventListener('visibilitychange', () => {
      clearTimeout(this.timer)
      if (this.visible()) void this.synchronize()
      else this.close()
    })
    // The app initializes a view before making it visible. Resume on the
    // actual visibility transition, including returns to an existing draft.
    new MutationObserver(() => {
      if (this.visible()) void this.synchronize()
      else { clearTimeout(this.timer); this.close() }
    }).observe(host.view, { attributes: true, attributeFilter: ['hidden'] })
    window.addEventListener('focus', () => { if (this.visible()) void this.synchronize() })
    window.addEventListener('resize', () => this.renderMarks())
    // Escape and outside presses close the thread, but never from inside it:
    // the thread owns its own Escape and buttons. Editing the document or
    // working in the side pane (a moved thread, Use as reply) keeps it.
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return
      const target = (event.target as HTMLElement).closest?.('.editor-inline-thread, #editor-doc, #chat-side-pane')
      if (target) return
      this.close()
    })
    document.addEventListener('mousedown', (event) => {
      const target = event.target as HTMLElement
      if (target.closest('.editor-inline-thread, #editor-doc, #chat-side-pane')) return
      if (!this.list.contains(target) && !target.closest('[data-review]')) this.close()
    }, true)
  }

  private visible(): boolean { return this.running && !!this.slug && !this.host.view.hidden && !document.hidden }
  private get busy(): boolean { return !!this.slug && this.actions.has(this.slug) }

  async load(slug: string): Promise<void> {
    const generation = ++this.generation
    const revision = this.revision
    this.running = true
    this.slug = slug
    this.data = empty()
    this.error = ''
    this.close()
    clearTimeout(this.timer)
    this.render()
    try {
      const data = await this.request(slug)
      if (generation !== this.generation || revision !== this.revision) return
      this.data = data
      this.render()
    } catch (error) {
      if (generation !== this.generation || revision !== this.revision) return
      this.error = (error as Error).message
      this.render()
    }
    if (generation === this.generation) void this.synchronize()
  }

  resume(): void { this.running = true; if (this.visible()) void this.synchronize() }
  stop(): void { this.running = false; clearTimeout(this.timer); this.close() }
  clear(): void { this.stop(); this.slug = null; this.generation++; this.data = empty(); this.render() }

  private async request(slug: string, endpoint = '', body?: unknown): Promise<ArticleReviews> {
    const response = await fetch(`/api/editor/doc/${encodeURIComponent(slug)}/reviews${endpoint}`, body === undefined ? undefined : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    const data = await response.json() as ArticleReviews & { error?: string }
    if (!response.ok) throw new Error(data.error ?? `Reviews answered ${response.status}.`)
    if (!Array.isArray(data.reviews) || !Array.isArray(data.problems)) throw new Error('The article review response is unreadable.')
    return data
  }

  async synchronize(force = false, polling = false): Promise<void> {
    if (!this.visible() || this.busy) return
    // A switched document must schedule its own sync after the previous request finishes.
    if (this.pending) {
      const generation = this.generation
      await this.pending
      if (this.visible() && generation === this.generation) return this.synchronize(force, polling)
      return
    }
    const generation = this.generation
    const revision = this.revision
    const slug = this.slug!
    const operation = (async () => {
      try {
        const data = await this.request(slug, '/sync', { force, poll: polling })
        if (generation !== this.generation || revision !== this.revision) return
        this.data = data
        this.error = ''
      } catch (error) {
        if (generation !== this.generation || revision !== this.revision) return
        this.error = (error as Error).message
      } finally {
        if (generation === this.generation) this.render()
      }
    })()
    this.pending = operation
    try { await operation } finally { this.pending = undefined; if (this.visible()) this.schedule() }
  }

  private schedule(): void {
    clearTimeout(this.timer)
    if (!this.visible() || !this.data.active) return
    const delay = Math.max(REVIEW_INTERVAL_MS, this.data.retryAt ? Date.parse(this.data.retryAt) - Date.now() : 0)
    this.timer = setTimeout(() => { void this.synchronize(false, true) }, delay)
  }

  private location(review: ArticleReview): { start: number, end: number } | null {
    return review.anchor ? locateReview(this.host.text(), review.anchor) : null
  }

  renderMarks(): void {
    this.overlay.replaceChildren()
    if (!this.slug || !this.running) return
    const page = this.overlay.parentElement!.getBoundingClientRect()
    for (const review of this.data.reviews) {
      if (review.resolved) continue
      const at = this.location(review)
      const range = at && this.host.range(at.start, at.end)
      if (!range) continue
      for (const rect of range.getClientRects()) {
        if (rect.width < 0.5) continue
        const mark = document.createElement('div')
        mark.className = 'annotation-mark editor-review-mark'
        mark.dataset.review = review.id
        mark.title = `Review · ${review.site} · @${review.messages[0]?.author}: ${review.messages[0]?.body}`
        Object.assign(mark.style, { left: `${rect.left - page.left}px`, top: `${rect.top - page.top}px`, width: `${rect.width}px`, height: `${rect.height}px` })
        this.overlay.appendChild(mark)
      }
    }
    // Editing can orphan a passage; update the open section without losing
    // its reply draft. The private surface lives outside this container.
    if (this.selected) this.renderSection()
  }

  private render(): void {
    const count = this.data.reviews.filter((review) => review.kind === 'thread' && !review.resolved).length
    this.list.hidden = !this.data.checkedAt && !this.data.reviews.length && !this.data.problems.length && !this.error
    patchContent(this.list, `<details><summary>Review comments${count ? ` · ${count} unresolved` : ''}</summary>
      <div class="editor-review-status"><button type="button" data-action="refresh"${this.busy ? ' disabled' : ''}>Refresh reviews</button>
      <span>${this.data.checkedAt ? `${this.data.stale ? 'Cached' : 'Checked'} ${escape(shortTime(this.data.checkedAt, effectiveTimezone(), Date.now()))}` : 'Not synchronized'}</span></div>
      ${[...this.data.problems, ...(this.error ? [this.error] : [])].map((problem) => `<p role="alert">${escape(problem)}</p>`).join('')}
      ${!this.data.reviews.length ? '<p>No review comments yet.</p>' : ''}
      ${this.data.reviews.map((review) => `<button type="button" class="editor-review-item" data-key="${escape(review.id)}" data-review="${escape(review.id)}">
        <span>Review · ${escape(review.site)} · #${review.pr} · @${escape(review.messages[0]?.author ?? '')}${review.resolved ? ' · Resolved' : review.outdated ? ' · Outdated' : ''}</span>
        <span>${escape(review.messages[0]?.body.slice(0, 160) ?? '')}</span></button>`).join('')}</details>`)
    this.renderMarks()
  }

  /** Open the review's thread, from its underline, its list item, or Back. */
  open(id: string): void {
    const review = this.data.reviews.find((item) => item.id === id)
    if (!review) return
    const key = `${this.slug}:${id}`
    this.host.beforeOpen()
    this.selected = id
    this.error = ''
    this.host.openThread(review, (section) => {
      section.classList.add('editor-review-thread')
      section.addEventListener('click', (event) => this.click(event))
      section.addEventListener('input', () => {
        const input = section.querySelector<HTMLTextAreaElement>('.editor-review-reply')
        this.drafts.set(key, input?.value ?? '')
      })
      this.section = section
      this.renderSection()
    })
  }

  private close(): void {
    const subject = inlineThreadSubjectInView()
    if (subject?.surface === 'editor-review' && this.selected && subject.key === `${this.slug}:${this.selected}`) closeInlineThread()
    this.selected = null
    this.section = null
  }

  private renderSection(): void {
    if (!this.section) return
    const review = this.data.reviews.find((item) => item.id === this.selected)
    if (!review) { this.close(); return }
    const located = this.location(review)
    patchContent(this.section, `<div class="editor-annotation-row"><strong>Review · ${escape(review.site)}</strong></div>
      <a href="${link(review.prUrl)}" target="_blank" rel="noopener noreferrer">PR #${review.pr}</a>
      <span class="editor-review-state">${review.resolved ? 'Resolved' : review.outdated ? 'Outdated · unresolved' : review.kind === 'thread' ? 'Unresolved' : 'Document feedback'}${this.data.stale ? ' · Cached' : ''}</span>
      ${review.anchor ? `<blockquote>${escape(review.anchor.quote)}</blockquote>` : ''}
      ${!located ? `<p class="editor-review-location">${escape(review.anchor ? 'Passage changed or ambiguous — comment retained here.' : review.location ?? 'Document feedback')}</p>` : ''}
      <div class="editor-review-messages">${review.messages.map((message) => `<article data-key="${escape(message.id)}"><a href="${link(message.url)}" target="_blank" rel="noopener noreferrer">@${escape(message.author)}</a><time datetime="${escape(message.createdAt)}">${escape(shortTime(message.createdAt, effectiveTimezone(), Date.now()))}</time><p>${escape(message.body)}</p></article>`).join('')}</div>
      ${[...this.data.problems, ...(this.error ? [this.error] : [])].map((problem) => `<p role="alert">${escape(problem)}</p>`).join('')}
      ${review.canReply ? `<label>Reply on GitHub<textarea aria-label="Reply on GitHub" class="editor-annotation-text editor-review-reply" maxlength="65536"${this.busy ? ' disabled' : ''}></textarea></label>` : ''}
      <div class="editor-review-actions">${review.canReply ? `<button type="button" data-action="reply"${this.busy ? ' disabled' : ''}>Reply on GitHub</button>` : ''}
      ${review.canResolve && !review.resolved ? `<button type="button" data-action="resolve"${this.busy ? ' disabled' : ''}>Resolve thread</button>` : ''}</div>`)
    const input = this.section.querySelector<HTMLTextAreaElement>('.editor-review-reply')
    const draft = this.drafts.get(`${this.slug}:${review.id}`) ?? ''
    if (input && input.value !== draft) input.value = draft
  }

  private click(event: MouseEvent): void {
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>('button')
    if (!target) return
    if (target.dataset.review) { this.open(target.dataset.review); return }
    const action = target.dataset.action
    if (action === 'refresh') { void this.synchronize(true); return }
    const review = this.data.reviews.find((item) => item.id === this.selected)
    if (!review || this.busy) return
    if (action === 'reply' || action === 'resolve') void this.act(review, action)
  }

  private async act(review: ArticleReview, action: 'reply' | 'resolve'): Promise<void> {
    const slug = this.slug!
    const generation = this.generation
    const key = `${slug}:${review.id}`
    const body = this.drafts.get(key) ?? ''
    if (action === 'reply' && !body.trim()) { this.error = 'Write a reply first.'; this.renderSection(); return }
    this.actions.add(slug)
    this.revision++
    this.error = ''
    this.renderSection()
    try {
      const data = await this.request(slug, '/action', { id: review.id, action, ...(action === 'reply' ? { body } : {}) })
      if (action === 'reply' && this.drafts.get(key) === body) this.drafts.delete(key)
      if (generation !== this.generation) return
      this.data = data
    } catch (error) { if (generation === this.generation) this.error = (error as Error).message }
    finally {
      this.actions.delete(slug)
      if (this.slug === slug) this.revision++
      if (generation === this.generation) { this.render(); this.schedule() }
      else if (this.slug === slug) { this.render(); void this.synchronize() }
    }
  }
}
