import { patchContent } from '../dom-patch'
import { addSite, describeSite, fetchSites, removeSite, starterDescription, type SiteView } from '../publishing'
import './publishing-settings.css'

// Settings → Publishing: the websites Editor documents are published to
// (docs/Publishing.md). One row per site: its name, its repository, and Ready
// or what is wrong with its description. A repository without publish.yaml is
// described here instead, in the same YAML.

export interface PublishingSection {
  readonly element: HTMLElement
  refresh(): Promise<void>
}

const CONFIRM_MS = 4_000

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}

interface Draft {
  text: string
  error: string
  saving: boolean
}

/** Whether the site is described here rather than by its repository. */
function describable(site: SiteView): boolean {
  return site.source !== 'repository' && (site.state !== 'unavailable' || site.description !== undefined)
}

function siteHtml(site: SiteView, draft: Draft | undefined, confirming: boolean): string {
  const name = site.site ?? site.repo.split('/')[1]
  const state = site.state === 'ready'
    ? `<div class="pb-site-state pb-site-state-ready">Ready${site.source === 'settings' ? ' · described here' : ''}</div>`
    : `<div class="pb-site-state pb-site-state-problem">${escapeHtml(site.problem ?? 'Unavailable')}</div>`
  const actions = [
    describable(site) && !draft ? `<button type="button" class="st-clear" data-describe>${site.description !== undefined ? 'Edit' : 'Describe'}</button>` : '',
    `<button type="button" class="st-clear${confirming ? ' pb-confirm' : ''}" data-remove>${confirming ? 'Confirm remove' : 'Remove'}</button>`,
  ].join('')
  const editor = draft ? `
    <div class="pb-describe">
      <textarea class="pb-description" rows="12" spellcheck="false" autocomplete="off" aria-label="${escapeHtml(`publish.yaml for ${site.repo}`)}"></textarea>
      <div class="pb-describe-row">
        <button type="button" class="st-save" data-save${draft.saving ? ' disabled' : ''}>${draft.saving ? 'Saving…' : 'Save'}</button>
        <button type="button" class="st-clear" data-cancel>Cancel</button>
      </div>
      ${draft.error ? `<div class="st-help st-help-error" role="alert">${escapeHtml(draft.error)}</div>` : ''}
    </div>` : ''
  return `
    <div class="pb-site" data-key="${escapeHtml(site.repo)}">
      <div class="pb-site-head">
        <span class="pb-site-name">${escapeHtml(name)}</span>
        <span class="pb-site-repo">${escapeHtml(site.repo)}</span>
        <span class="pb-site-actions">${actions}</span>
      </div>
      ${state}
      ${site.warning ? `<div class="pb-site-warning">${escapeHtml(site.warning)}</div>` : ''}
      ${editor}
    </div>`
}

export function publishingSection(): PublishingSection {
  const element = document.createElement('div')
  element.className = 'pb-settings'
  element.innerHTML = `
    <div class="tp-group-label" data-help="Websites Editor documents are published to, as pull requests. Each says how it takes a post in publish.yaml at the root of its repository." tabindex="0">Sites</div>
    <div class="pb-sites" aria-live="polite"></div>
    <div class="tp-section">
      <div class="st-org-add-row">
        <input type="text" class="st-input pb-repo" aria-label="Repository to publish to" autocomplete="off" spellcheck="false" placeholder="owner/repository" />
        <button type="button" class="st-clear pb-add">Add</button>
      </div>
      <div class="st-help st-help-info pb-status" role="status"></div>
    </div>`
  const list = element.querySelector<HTMLElement>('.pb-sites')!
  const input = element.querySelector<HTMLInputElement>('.pb-repo')!
  const addButton = element.querySelector<HTMLButtonElement>('.pb-add')!
  const status = element.querySelector<HTMLElement>('.pb-status')!
  let sites: SiteView[] = []
  let loaded = false
  let generation = 0
  const drafts = new Map<string, Draft>()
  let confirming: { repo: string, timer: ReturnType<typeof setTimeout> } | null = null

  const say = (text: string, kind: 'info' | 'error' = 'info') => {
    status.textContent = text
    status.className = `st-help st-help-${kind} pb-status`
  }

  const render = () => {
    if (!loaded) {
      patchContent(list, '<div class="st-help st-help-info">Reading your sites…</div>')
      return
    }
    patchContent(list, sites.length
      ? sites.map((site) => siteHtml(site, drafts.get(site.repo), confirming?.repo === site.repo)).join('')
      : '<div class="st-help st-help-info">No sites yet. Add a repository below.</div>')
    // A textarea's typed value is not markup: put each draft back after the patch.
    for (const [repo, draft] of drafts) {
      const area = list.querySelector<HTMLTextAreaElement>(`[data-key="${CSS.escape(repo)}"] .pb-description`)
      if (area && area.value !== draft.text) area.value = draft.text
    }
  }

  const refresh = async () => {
    const mine = ++generation
    try {
      const next = await fetchSites()
      if (mine !== generation) return
      sites = next
      loaded = true
      if (status.classList.contains('st-help-error')) say('')
    } catch (error) {
      if (mine !== generation) return
      loaded = true
      say((error as Error).message, 'error')
    }
    render()
  }

  const replace = (site: SiteView) => {
    sites = sites.map((s) => (s.repo.toLowerCase() === site.repo.toLowerCase() ? site : s))
  }

  const add = async () => {
    const repo = input.value.trim()
    if (!repo) { input.focus(); return }
    addButton.disabled = true
    say('Reading the repository…')
    try {
      const site = await addSite(repo)
      generation++
      sites = [...sites.filter((s) => s.repo.toLowerCase() !== site.repo.toLowerCase()), site]
      loaded = true
      input.value = ''
      say('')
      if (site.state === 'missing') drafts.set(site.repo, { text: starterDescription(site.repo), error: '', saving: false })
      render()
    } catch (error) {
      say((error as Error).message, 'error')
    } finally {
      addButton.disabled = false
    }
  }

  const save = async (repo: string) => {
    const draft = drafts.get(repo)
    if (!draft || draft.saving) return
    draft.saving = true
    draft.error = ''
    render()
    try {
      const site = await describeSite(repo, draft.text)
      generation++
      drafts.delete(repo)
      replace(site)
    } catch (error) {
      draft.error = (error as Error).message
    } finally {
      draft.saving = false
      render()
    }
  }

  const remove = async (repo: string) => {
    if (confirming) clearTimeout(confirming.timer)
    confirming = null
    try {
      await removeSite(repo)
      generation++
      sites = sites.filter((s) => s.repo !== repo)
      drafts.delete(repo)
      render()
    } catch (error) {
      say((error as Error).message, 'error')
    }
  }

  addButton.addEventListener('click', () => { void add() })
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); void add() }
  })
  list.addEventListener('input', (event) => {
    const area = (event.target as HTMLElement).closest<HTMLTextAreaElement>('.pb-description')
    const repo = area?.closest<HTMLElement>('[data-key]')?.dataset.key
    const draft = repo ? drafts.get(repo) : undefined
    if (area && draft) draft.text = area.value
  })
  list.addEventListener('click', (event) => {
    const target = event.target as HTMLElement
    const repo = target.closest<HTMLElement>('[data-key]')?.dataset.key
    if (!repo) return
    if (target.closest('[data-describe]')) {
      const site = sites.find((s) => s.repo === repo)
      drafts.set(repo, { text: site?.description ?? starterDescription(repo), error: '', saving: false })
      render()
      list.querySelector<HTMLTextAreaElement>(`[data-key="${CSS.escape(repo)}"] .pb-description`)?.focus()
    } else if (target.closest('[data-cancel]')) {
      drafts.delete(repo)
      render()
    } else if (target.closest('[data-save]')) {
      void save(repo)
    } else if (target.closest('[data-remove]')) {
      if (confirming?.repo !== repo) {
        if (confirming) clearTimeout(confirming.timer)
        confirming = { repo, timer: setTimeout(() => { confirming = null; render() }, CONFIRM_MS) }
        render()
        return
      }
      void remove(repo)
    }
  })

  render()
  return { element, refresh }
}
