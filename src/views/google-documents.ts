import { escapeGoogleHtml as escape, GOOGLE_CHANGED, googleCall, googleDocument, googlePath, googleReview, type GoogleSettings } from '../google'
import type { GoogleChangeReview, GoogleDocumentView } from '../../server/google/types'
import type { PublishPanelHost } from './editor-publish'

export function mountGooglePublish(panel: HTMLElement, host: PublishPanelHost): void {
  const element = document.createElement('section'); element.className = 'google-publish'
  panel.append(element)
  let busy = false
  element.innerHTML = '<h3>Google Docs</h3><p class="google-publish-status" role="status">Reading Google accounts…</p><select aria-label="Google publishing account"></select><button type="button" class="composer-add" disabled>Publish to Google</button><button type="button" class="ep-link google-settings">Connect accounts</button>'
  const status = element.querySelector<HTMLElement>('[role="status"]')!, select = element.querySelector('select')!, publish = element.querySelector<HTMLButtonElement>('.composer-add')!
  const slug = host.slug()
  element.querySelector('.google-settings')!.addEventListener('click', () => window.dispatchEvent(new CustomEvent('poise:open-settings', { detail: { section: 'accounts' } })))
  void googleCall<GoogleSettings>('/api/google/accounts').then(settings => {
    select.innerHTML = settings.accounts.filter(a => a.connected).map(a => `<option value="${escape(a.id)}">${escape(a.email)}</option>`).join('')
    status.textContent = select.options.length ? 'Publishes a private Markdown file editable in Google Docs.' : 'Connect a Google account in Settings → Accounts.'
    publish.disabled = !select.options.length
  }).catch(error => { status.textContent = (error as Error).message })
  publish.addEventListener('click', () => {
    if (busy || !slug || host.slug() !== slug) return
    busy = true; publish.disabled = true; select.disabled = true
    const accountId = select.value
    void (async () => {
      try {
        if (!await host.flush()) throw new Error('Save the document before publishing.')
        if (host.slug() !== slug) throw new Error('The open document changed.')
        const localVersion = host.version()
        if (!localVersion) throw new Error('Reload the document before publishing.')
        await googleCall(googlePath(slug, 'publish'), { accountId, localVersion })
        status.textContent = 'Published. The same Google document will receive future updates.'
        publish.textContent = 'Update Google document'
        window.dispatchEvent(new CustomEvent(GOOGLE_CHANGED))
      } catch (error) { status.textContent = (error as Error).message }
      finally { busy = false; publish.disabled = false; select.disabled = false }
    })()
  })
}

interface Host {
  view: HTMLElement
  flush(): Promise<boolean>
  imported(slug: string, content: string, version: string): Promise<void>
  freeze(frozen: boolean): void
}
export class GoogleDocuments {
  private element = document.createElement('details')
  private slug: string | null = null
  private generation = 0
  private refreshRevision = 0
  private timer?: ReturnType<typeof setTimeout>
  private data: GoogleDocumentView | null = null
  private review: { accountId: string, value: GoogleChangeReview } | null = null
  private busy = false
  private stopped = false
  private error = ''
  private actionError = ''
  constructor(private host: Host) {
    this.element.className = 'google-documents'
    this.element.hidden = true
    host.view.querySelector('.editor-bar')!.after(this.element)
    window.addEventListener(GOOGLE_CHANGED, () => { void this.refresh() })
    this.element.addEventListener('click', event => {
      const action = (event.target as HTMLElement).closest<HTMLElement>('[data-google-action]')
      if (action && !this.busy) void this.act(action.dataset.googleAction!, action.dataset.account ?? '')
    })
  }
  load(slug: string | null): void {
    this.generation++; this.slug = slug; this.data = null; this.review = null; this.error = ''; this.actionError = ''; this.element.hidden = true
    clearTimeout(this.timer)
    if (slug) void this.refresh()
  }
  stop(): void { this.stopped = true; clearTimeout(this.timer) }
  resume(): void { this.stopped = false; if (this.slug) void this.refresh() }
  private visible(): boolean { return !this.stopped && !this.host.view.hidden && !!this.slug }
  async refresh(): Promise<void> {
    clearTimeout(this.timer)
    if (!this.visible() || this.busy) return
    const generation = this.generation, slug = this.slug!, revision = ++this.refreshRevision
    try {
      const data = await googleDocument(slug)
      if (generation !== this.generation || revision !== this.refreshRevision) return
      this.data = data; this.error = ''; this.render()
    } catch (error) { if (generation === this.generation && revision === this.refreshRevision) { this.error = (error as Error).message; this.render() } }
    finally { if (this.visible() && revision === this.refreshRevision) this.timer = setTimeout(() => { void this.refresh() }, 60_000) }
  }
  private render(): void {
    const publications = this.data?.publications ?? []
    this.element.hidden = !publications.length && !this.error && !this.actionError
    if (this.element.hidden) return
    const count = publications.reduce((n, p) => n + p.comments.length, 0)
    const controls = publications.map(p => `<section class="google-publication"><a href="${escape(p.url)}" target="_blank" rel="noopener noreferrer">${escape(p.title)}</a><span>${escape(p.email)}</span><p>${this.error || p.remoteChanged === null ? 'Google status unavailable.' : p.remoteChanged ? 'Google version changed — review before publishing.' : p.localChanged ? 'Poise draft has unpublished changes.' : 'Published version matches.'}</p>${p.problem ? `<p role="alert">${escape(p.problem)}</p>` : ''}<button type="button" data-google-action="review" data-account="${escape(p.accountId)}"${!p.connected || this.busy ? ' disabled' : ''}>Review Google changes</button>${p.comments.map(c => `<article class="google-comment"><strong>${escape(c.author)}</strong>${c.resolved ? ' · Resolved' : ''}${c.start === null ? ' · Passage unavailable' : ''}<blockquote>${escape(c.quote)}</blockquote><p>${escape(c.body)}</p>${(c.replies ?? []).map(reply => `<div class="google-comment-reply"><strong>${escape(reply.author)}</strong><p>${escape(reply.body)}</p></div>`).join('')}</article>`).join('')}</section>`).join('')
    const review = this.review ? '<section class="google-change-review"><h3>Review Google changes</h3><p>Import replaces this Poise draft and saves its previous text in Google history. Other destinations are updated only when you publish.</p><div class="google-compare"><section><h4>Poise draft</h4><pre class="google-local"></pre></section><section><h4>Google version</h4><pre class="google-remote"></pre></section></div><button type="button" data-google-action="import">Import Google version</button><button type="button" data-google-action="publish-reviewed">Publish Poise version instead</button><button type="button" data-google-action="cancel">Keep Poise draft</button></section>' : ''
    const summary = this.data ? `Google Docs · ${count} comment${count === 1 ? '' : 's'}${publications.some(p => p.remoteChanged) ? ' · Updates available' : ''}` : 'Google Docs · Status unavailable'
    this.element.innerHTML = `<summary>${summary}</summary><div class="google-document-body"><button type="button" data-google-action="refresh"${this.busy ? ' disabled' : ''}>Refresh Google</button>${this.actionError || this.error ? `<p role="alert">${escape(this.actionError || this.error)}</p>` : ''}${controls}${review}</div>`
    if (!this.data && this.error) this.element.open = true
    if (this.review) {
      this.element.querySelector('.google-local')!.textContent = this.review.value.localText
      this.element.querySelector('.google-remote')!.textContent = this.review.value.remoteText
      this.element.open = true
    }
  }
  private async act(action: string, accountId: string): Promise<void> {
    if (!this.slug) return
    if (action === 'refresh') return this.refresh()
    if (action === 'cancel') { this.review = null; this.actionError = ''; this.render(); return }
    const generation = this.generation, slug = this.slug
    this.busy = true; this.error = ''; this.actionError = ''; this.refreshRevision++
    if (action === 'import' && this.review) this.host.freeze(true)
    try {
      if (!await this.host.flush()) throw new Error('Save the Poise draft before reviewing Google changes.')
      if (generation !== this.generation) return
      if (action === 'review') {
        const value = await googleReview(slug, accountId)
        if (generation === this.generation) this.review = { accountId, value }
      } else if (action === 'publish-reviewed' && this.review) {
        const data = await googleCall<GoogleDocumentView>(googlePath(slug, 'publish'), { accountId: this.review.accountId, localVersion: this.review.value.localVersion, reviewedRemoteSha: this.review.value.remoteSha, fileId: this.review.value.fileId, connectionVersion: this.review.value.connectionVersion })
        if (generation === this.generation) { this.data = data; this.review = null }
      } else if (action === 'import' && this.review) {
        const imported = await googleCall<{ content: string, version: string }>(googlePath(slug, 'import'), { accountId: this.review.accountId, localVersion: this.review.value.localVersion, remoteSha: this.review.value.remoteSha, fileId: this.review.value.fileId, connectionVersion: this.review.value.connectionVersion })
        this.review = null
        await this.host.imported(slug, imported.content, imported.version)
      }
    } catch (error) { if (generation === this.generation) this.actionError = (error as Error).message }
    finally { this.host.freeze(false); this.busy = false; this.render(); void this.refresh() }
  }
}
