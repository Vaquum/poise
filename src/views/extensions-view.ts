// Extensions: the MCP servers Poise chats can use. Installed is a grid of
// servers by workspace; Directory is Poise's mirror of the official MCP
// Registry; Custom adds a remote URL or a local command and previews exactly
// what each agent receives. Secrets are write-only: no response carries one,
// so an edit replaces only what is typed.

import './extensions.css'
import { patchContent } from '../dom-patch'
import { watchPanel } from '../motion'
import { escapeHtml as esc } from '../markdown'
import {
  AGENT_LABEL, forAcp, forClaude, forCodex, forMuse, nameFrom, parseImport, reaches,
  type DirectoryEntry, type DirectoryStatus, type ImportedServer, type InstallOption, type ResolvedServer, type ServerEvent, type ServerView, type Workspace,
} from '../../server/extensions/types'
import type { AgentId } from '../../server/chat/protocol'

type Tab = 'installed' | 'directory' | 'custom'
type Kind = 'any' | 'remote' | 'local'
interface Data { servers: ServerView[], workspaces: Workspace[], directory: DirectoryStatus }
interface Results { entries: DirectoryEntry[], total: number, featured: boolean, status: DirectoryStatus }
interface Row { name: string, value: string, secret: boolean, set: boolean }
interface Form {
  mode: 'add' | 'edit'
  id?: string
  /** The stored name an edit keeps: agents' tool names, and unique (an import may have made it `docs-2`). */
  name: string
  source: 'custom' | 'directory'
  kind: 'remote' | 'local' | 'json'
  title: string
  url: string
  transport: 'http' | 'sse'
  auth: 'none' | 'oauth' | 'token' | 'headers'
  token: string
  tokenSet: boolean
  headers: Row[]
  command: string
  args: string[]
  env: Row[]
  on: Set<string>
  newWorkspaces: boolean
  json: string
  imported: ImportedServer[] | null
  importError: string
  error: string
  busy: boolean
}
type Panel =
  | { kind: 'server', id: string, tab: 'overview' | 'tools' | 'activity', events?: ServerEvent[], confirm?: boolean, error?: string, busy?: boolean }
  | { kind: 'entry', name: string, step: 'about' | 'setup', option: string, values: Record<string, string>, on: Set<string>, newWorkspaces: boolean, error?: string, busy?: boolean }

const PAGE = 48
const SECRET = '‹secret›'
const TONES = ['var(--a1)', 'var(--a2)', 'var(--a3)', 'var(--a4)', 'var(--a5)', 'var(--a6)', 'var(--a7)', 'var(--a8)']
const CHEVRON = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M4.5 2.5 8 6l-3.5 3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
const LOCK = '<svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true"><rect x="2.6" y="5.4" width="6.8" height="4.8" rx="1" stroke="currentColor" stroke-width="1.2"/><path d="M4.2 5.4V4a1.8 1.8 0 0 1 3.6 0v1.4" stroke="currentColor" stroke-width="1.2"/></svg>'

let view: HTMLElement
let panelEl: HTMLElement
let initialized = false
let active = false
let tab: Tab = 'installed'
let data: Data | null = null
let loadError = ''
let query = ''
let kind: Kind = 'any'
let results: Results | null = null
let shown = PAGE
let searchTimer = 0
let pollTimer = 0
let notice: { text: string, tone: 'info' | 'error' } | null = null
let agent: AgentId = 'claude'
let panel: Panel | null = null
let form = blankForm()

function blankForm(): Form {
  return {
    mode: 'add', name: '', source: 'custom', kind: 'remote', title: '', url: '', transport: 'http', auth: 'none', token: '', tokenSet: false,
    headers: [{ name: '', value: '', secret: true, set: false }], command: '', args: [''], env: [{ name: '', value: '', secret: false, set: false }],
    on: new Set(data?.workspaces.map((workspace) => workspace.id) ?? []), newWorkspaces: true, json: '', imported: null, importError: '', error: '', busy: false,
  }
}

async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(path, { method, cache: 'no-store', ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) })
  const text = await response.text()
  let parsed: { error?: string } | null = null
  try { parsed = text ? JSON.parse(text) : null } catch { /* reported below */ }
  if (!response.ok) throw new Error(parsed?.error || `Extensions answered ${response.status}.`)
  return parsed as T
}

function tone(text: string): string {
  let hash = 0
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return TONES[hash % TONES.length]
}

function tile(title: string, large = false): string {
  const letter = title.replace(/[^A-Za-z0-9]/g, '')[0]?.toUpperCase() || '?'
  return `<span class="ext-tile${large ? ' ext-tile-lg' : ''}" style="--tile:${tone(title)}" aria-hidden="true">${esc(letter)}</span>`
}

function stateText(server: ServerView): { tone: string, text: string } {
  const anywhere = server.enabled.default || Object.values(server.enabled.workspaces).some(Boolean)
  switch (server.status.state) {
    case 'connected': return { tone: anywhere ? 'ok' : 'idle', text: `Connected · ${server.status.toolCount ?? 0} tool${server.status.toolCount === 1 ? '' : 's'}${anywhere ? '' : ' · off everywhere'}` }
    case 'signin': return { tone: 'warn', text: 'Needs sign-in' }
    case 'failed': return { tone: 'error', text: server.transport === 'stdio' ? 'Failed to start' : 'Cannot connect' }
    case 'checking': return { tone: 'busy', text: 'Checking…' }
    default: return { tone: 'idle', text: 'Not checked yet' }
  }
}

function connection(server: Pick<ServerView, 'transport' | 'command' | 'url'>): string {
  return server.transport === 'stdio' ? `Local · ${server.command}` : `Remote · ${server.transport === 'sse' ? 'SSE' : 'Streamable HTTP'}`
}

function enabledIn(server: ServerView, workspace: string): boolean {
  return server.enabled.workspaces[workspace] ?? server.enabled.default
}

function scopeText(server: ServerView, workspaces: Workspace[]): string {
  const on = workspaces.filter((workspace) => enabledIn(server, workspace.id))
  if (!on.length && !server.enabled.default) return 'Off in every workspace'
  if (on.length === workspaces.length && server.enabled.default) return 'Every workspace, and new ones'
  return `${on.map((workspace) => workspace.label).join(', ') || 'No current workspace'}${server.enabled.default ? ', and new workspaces' : ''}`
}

// ── Loading ────────────────────────────────────────────────────────────

async function load(): Promise<void> {
  try {
    data = await api<Data>('/api/extensions')
    loadError = ''
  } catch (error) {
    loadError = (error as Error).message
  }
  render()
  schedulePoll()
}

async function search(): Promise<void> {
  const params = new URLSearchParams({ q: query, kind, limit: String(shown) })
  try {
    results = await api<Results>(`/api/extensions/directory?${params}`)
    if (data) data.directory = results.status
  } catch (error) {
    notice = { text: (error as Error).message, tone: 'error' }
  }
  render()
  schedulePoll()
}

/** Status checks and the directory sync run in the background; follow them while visible. */
function schedulePoll(): void {
  clearTimeout(pollTimer)
  if (!active) return
  const checking = data?.servers.some((server) => server.status.state === 'checking')
  const syncing = (results?.status ?? data?.directory)?.syncing
  if (!checking && !syncing) return
  pollTimer = window.setTimeout(() => { void (tab === 'directory' && syncing ? Promise.all([load(), search()]) : load()) }, 2000)
}

// ── Rendering ──────────────────────────────────────────────────────────

function shell(): void {
  view.innerHTML = `<header class="view-header" tabindex="-1" aria-label="Extensions controls"><div class="filter-cluster" id="extensions-filters"></div></header>
    <main class="ext-main" id="extensions-main"></main>`
  panelEl = document.createElement('aside')
  panelEl.id = 'extensions-panel'
  panelEl.setAttribute('aria-label', 'Extension details')
  document.body.appendChild(panelEl)
  watchPanel(panelEl, () => panelEl.classList.contains('open'), 1)
  view.addEventListener('click', onClick)
  panelEl.addEventListener('click', onClick)
  view.addEventListener('input', onInput)
  panelEl.addEventListener('input', onInput)
  view.addEventListener('change', onChange)
  panelEl.addEventListener('change', onChange)
  document.addEventListener('keydown', (event) => { if (active && event.key === 'Escape' && panel) { panel = null; render() } })
  view.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement
    if ((event.key === 'Enter' || event.key === ' ') && target.matches('article[data-entry], tr[data-open]')) { event.preventDefault(); target.click() }
  })
}

function render(): void {
  if (!initialized) return
  const count = data?.servers.length ?? 0
  const total = (results?.status ?? data?.directory)?.count ?? 0
  patchContent(view.querySelector('#extensions-filters')!, `
    <div class="range-picker" role="tablist" aria-label="Extensions">
      <button type="button" role="tab" data-tab="installed" class="${tab === 'installed' ? 'active' : ''}" aria-selected="${tab === 'installed'}">Installed${count ? ` · ${count}` : ''}</button>
      <button type="button" role="tab" data-tab="directory" class="${tab === 'directory' ? 'active' : ''}" aria-selected="${tab === 'directory'}">Directory</button>
      <button type="button" role="tab" data-tab="custom" class="${tab === 'custom' ? 'active' : ''}" aria-selected="${tab === 'custom'}">Custom server</button>
    </div>
    ${tab === 'directory' ? `<div class="search-cluster"><input class="search-input" id="extensions-search" type="search" value="${esc(query)}" placeholder="Search ${total ? total.toLocaleString() : 'the'} servers…" aria-label="Search the directory" autocomplete="off" spellcheck="false"></div>
    <div class="range-picker" role="group" aria-label="Kind">${(['any', 'remote', 'local'] as const).map((value) => `<button type="button" data-kind="${value}" class="${kind === value ? 'active' : ''}">${value === 'any' ? 'Any' : value === 'remote' ? 'Remote' : 'Local'}</button>`).join('')}</div>` : ''}`)
  const main = view.querySelector<HTMLElement>('#extensions-main')!
  const banner = notice ? `<p class="st-help st-help-${notice.tone} ext-notice" role="status">${esc(notice.text)}</p>` : ''
  patchContent(main, banner + (loadError ? `<p class="st-help st-help-error">${esc(loadError)}</p>` : !data ? '<div class="loader" role="status" aria-label="Loading extensions"><span></span><span></span><span></span></div>'
    : tab === 'installed' ? installedHtml(data) : tab === 'directory' ? directoryHtml() : customHtml()))
  renderPanel()
}

function installedHtml(current: Data): string {
  if (!current.servers.length) {
    return `<div class="ext-empty"><p>No extensions yet. Chats get the MCP servers you add here, in the workspaces you choose.</p>
      <div class="st-row"><button type="button" class="st-save" data-tab="directory">Browse the directory</button><button type="button" class="st-clear" data-tab="custom">Add a custom server</button></div></div>`
  }
  const selected = panel?.kind === 'server' ? panel.id : ''
  return `<p class="st-help st-help-info ext-lead">Switch a server on for each workspace. Every chat there gets it — Claude, Codex, Muse and Grok alike — from its next turn.</p>
    <div class="ext-table-wrap"><table class="ext-matrix" aria-label="Extensions by workspace">
      <thead><tr><th class="ext-col-server">Server</th><th class="ext-col-status">Status</th>
        ${current.workspaces.map((workspace) => `<th class="ext-col-ws"><code>${esc(workspace.label)}</code></th>`).join('')}
        <th class="ext-col-ws ext-col-new" title="Workspaces chats use for the first time start with this switch">New workspaces</th><th class="ext-col-go"></th></tr></thead>
      <tbody>${current.servers.map((server) => {
        const state = stateText(server)
        return `<tr data-id="${server.id}" data-open="${server.id}" tabindex="0" class="${server.id === selected ? 'is-selected' : ''}">
          <td class="ext-col-server"><div class="ext-server">${tile(server.title)}<div><b>${esc(server.title)}</b><span>${server.source === 'directory' ? 'Directory' : 'Custom'} · ${esc(server.transport === 'stdio' ? `Local · ${server.command ?? ''}` : 'Remote')}</span></div></div></td>
          <td class="ext-col-status"><span class="ext-state ext-state-${state.tone}">${esc(state.text)}</span>${server.status.state === 'signin' ? ` <button type="button" class="ext-link" data-sign-in="${server.id}">Sign in</button>` : ''}</td>
          ${current.workspaces.map((workspace) => `<td class="ext-col-ws"><label class="toggle" title="${esc(server.title)} in ${esc(workspace.label)}"><input type="checkbox" data-switch="${server.id}" data-workspace="${esc(workspace.id)}" ${enabledIn(server, workspace.id) ? 'checked' : ''} aria-label="${esc(server.title)} in ${esc(workspace.label)}"><span class="toggle-slider"></span></label></td>`).join('')}
          <td class="ext-col-ws ext-col-new"><label class="toggle"><input type="checkbox" data-default="${server.id}" ${server.enabled.default ? 'checked' : ''} aria-label="${esc(server.title)} in new workspaces"><span class="toggle-slider"></span></label></td>
          <td class="ext-col-go">${CHEVRON}</td></tr>`
      }).join('')}</tbody></table></div>
    <p class="st-help st-help-info">A workspace is the repository a chat works in; chats without one share Poise · local. Turning a server off, or removing it, applies from each chat's next turn.</p>`
}

function directoryHtml(): string {
  const status = results?.status ?? data?.directory
  const synced = status?.completedAt ? `updated ${new Date(status.completedAt).toLocaleString()}` : 'not synced yet'
  const head = `<div class="ext-directory-status"><span class="st-help st-help-info">From the official MCP Registry · ${(status?.count ?? 0).toLocaleString()} servers, ${status?.syncing ? 'syncing now…' : synced}.</span>
    <button type="button" class="ext-link" data-sync ${status?.syncing ? 'disabled' : ''}>Refresh</button></div>
    ${status?.error ? `<p class="st-help st-help-warn">The last sync stopped: ${esc(status.error)} It resumes from where it stopped.</p>` : ''}`
  if (!results) return head + '<div class="loader" role="status" aria-label="Loading the directory"><span></span><span></span><span></span></div>'
  if (!results.entries.length) {
    return head + `<div class="ext-empty"><p>${status?.count ? 'Nothing in the directory matches.' : 'The directory is empty until the first sync finishes.'}</p><div class="st-row"><button type="button" class="st-clear" data-tab="custom">Add it as a custom server</button></div></div>`
  }
  const installed = new Set(data?.servers.map((server) => server.registry?.name).filter(Boolean))
  const selected = panel?.kind === 'entry' ? panel.name : ''
  return head + `${results.featured ? '<div class="tp-group-label">Featured, then everything</div>' : ''}
    <div class="ext-grid">${results.entries.map((entry) => {
      const remote = entry.options.some((option) => option.kind === 'remote')
      const local = entry.options.some((option) => option.kind === 'package')
      const runnable = entry.options.some((option) => !option.unsupported)
      const keyed = entry.options.some((option) => option.inputs.some((input) => input.secret))
      return `<article class="ext-card${entry.name === selected ? ' is-selected' : ''}" data-entry="${esc(entry.name)}" tabindex="0">
        <div class="ext-card-top">${tile(entry.title, true)}<div><b>${esc(entry.title)}</b><span>${esc(entry.publisher)}</span></div></div>
        <p>${esc(entry.description || 'No description.')}</p>
        <div class="ext-card-foot">
          ${remote ? '<span class="ext-badge">Remote</span>' : ''}${local ? '<span class="ext-badge">Local</span>' : ''}${keyed ? '<span class="ext-badge">Needs a key</span>' : ''}
          ${installed.has(entry.name) ? '<span class="ext-added">Added</span>' : runnable ? `<button type="button" class="st-clear ext-add" data-add="${esc(entry.name)}">Add</button>` : '<span class="ext-badge ext-badge-quiet">Custom only</span>'}
        </div></article>`
    }).join('')}</div>
    ${results.total > results.entries.length ? `<div class="st-row ext-more"><button type="button" class="st-clear" data-more>Show more (${(results.total - results.entries.length).toLocaleString()} left)</button></div>` : ''}`
}

function workspacePicker(on: Set<string>, newWorkspaces: boolean, scope: string): string {
  const workspaces = data?.workspaces ?? []
  return `<div class="ext-checks" data-scope="${scope}">${workspaces.map((workspace) => `<label class="ext-check"><input type="checkbox" data-ws="${esc(workspace.id)}" ${on.has(workspace.id) ? 'checked' : ''}><code>${esc(workspace.label)}</code></label>`).join('')}
    <label class="ext-check"><input type="checkbox" data-ws-new ${newWorkspaces ? 'checked' : ''}><span>New workspaces</span></label></div>`
}

function rowsHtml(rows: Row[], list: 'env' | 'headers', locked: boolean): string {
  return rows.map((row, index) => `<div class="ext-pair">
    <input class="st-input" value="${esc(row.name)}" placeholder="${list === 'env' ? 'NAME' : 'Header-Name'}" data-list="${list}" data-field="name" data-index="${index}" aria-label="${list === 'env' ? 'Variable name' : 'Header name'}" autocomplete="off" spellcheck="false" ${locked ? 'disabled' : ''}>
    <input class="st-input" type="${row.secret ? 'password' : 'text'}" value="${esc(row.value)}" placeholder="${row.secret && row.set ? 'Saved — type to replace' : 'value'}" data-list="${list}" data-field="value" data-index="${index}" aria-label="Value" autocomplete="off" spellcheck="false">
    <button type="button" class="ext-icon-btn${row.secret ? ' is-on' : ''}" data-secret="${list}" data-index="${index}" aria-pressed="${row.secret}" title="${row.secret ? 'Secret: stored write-only' : 'Mark as secret'}" ${locked ? 'disabled' : ''}>${LOCK}</button>
    <button type="button" class="ext-icon-btn" data-remove-row="${list}" data-index="${index}" aria-label="Remove" ${locked ? 'disabled' : ''}>&times;</button></div>`).join('')
}

function customHtml(): string {
  const f = form
  const locked = f.source === 'directory'
  const kinds = ([['remote', 'Remote URL'], ['local', 'Local command'], ...(f.mode === 'add' ? [['json', 'Paste JSON']] : [])] as Array<[Form['kind'], string]>)
  const head = `<h2 class="ext-title">${f.mode === 'edit' ? `Edit ${esc(f.title)}` : 'Add a custom server'}</h2>
    <p class="st-help st-help-info ext-lead">${f.mode === 'edit' && locked ? 'The directory sets how this server runs; change its values, its name or its secrets.' : 'A server the directory does not list: a remote URL with its authentication, or a command Poise runs in each chat’s checkout.'}</p>
    <div class="range-picker ext-kind" role="group" aria-label="Server type">${kinds.map(([value, label]) => `<button type="button" data-form-kind="${value}" class="${f.kind === value ? 'active' : ''}" ${f.mode === 'edit' && value !== f.kind ? 'disabled' : ''}>${label}</button>`).join('')}</div>`
  if (f.kind === 'json') return head + importHtml()
  const fields = f.kind === 'remote' ? `
      <div class="tp-section"><label class="tp-label" for="ext-url">URL</label><input id="ext-url" class="st-input" data-form="url" value="${esc(f.url)}" placeholder="https://example.com/mcp" autocomplete="off" spellcheck="false" ${locked ? 'disabled' : ''}></div>
      <div class="tp-section"><label class="tp-label">Transport</label><div class="range-picker" role="group">${(['http', 'sse'] as const).map((value) => `<button type="button" data-transport="${value}" class="${f.transport === value ? 'active' : ''}" ${locked ? 'disabled' : ''}>${value === 'http' ? 'Streamable HTTP' : 'SSE (legacy)'}</button>`).join('')}</div>
        ${f.transport === 'sse' ? '<p class="st-help st-help-warn">Codex and Muse chats take Streamable HTTP only; Claude and Grok chats take SSE too.</p>' : ''}</div>
      <div class="tp-section"><label class="tp-label">Authentication</label><div class="range-picker" role="group">${(['none', 'oauth', 'token', 'headers'] as const).map((value) => `<button type="button" data-auth="${value}" class="${f.auth === value ? 'active' : ''}">${{ none: 'None', oauth: 'OAuth sign-in', token: 'Token', headers: 'Headers' }[value]}</button>`).join('')}</div>
        ${f.auth === 'oauth' ? '<p class="st-help st-help-info">After saving, sign in from the server’s details. Poise registers itself with the server, keeps the sign-in and renews it.</p>'
          : f.auth === 'token' ? `<input class="st-input" type="password" data-form="token" value="${esc(f.token)}" placeholder="${f.tokenSet ? 'Saved — type to replace' : 'Bearer token'}" aria-label="Bearer token" autocomplete="off"><p class="st-help st-help-info">${LOCK} Sent as <code>Authorization: Bearer …</code>. Stored write-only: never shown again, never in logs or transcripts.</p>`
          : f.auth === 'headers' ? `${rowsHtml(f.headers, 'headers', false)}<button type="button" class="ext-link ext-add-row" data-add-row="headers">Add header</button>` : ''}</div>`
    : `
      <div class="tp-section"><label class="tp-label" for="ext-command">Command</label><input id="ext-command" class="st-input" data-form="command" value="${esc(f.command)}" placeholder="npx" autocomplete="off" spellcheck="false" ${locked ? 'disabled' : ''}></div>
      <div class="tp-section"><label class="tp-label">Arguments</label>${f.args.map((arg, index) => `<div class="ext-pair ext-pair-1"><input class="st-input" value="${esc(arg)}" data-arg="${index}" aria-label="Argument ${index + 1}" autocomplete="off" spellcheck="false" ${locked ? 'disabled' : ''}><button type="button" class="ext-icon-btn" data-remove-arg="${index}" aria-label="Remove argument" ${locked ? 'disabled' : ''}>&times;</button></div>`).join('')}
        ${locked ? '' : '<button type="button" class="ext-link ext-add-row" data-add-arg>Add argument</button>'}</div>
      <div class="tp-section"><label class="tp-label">Environment</label>${rowsHtml(f.env, 'env', locked)}${locked ? '' : '<button type="button" class="ext-link ext-add-row" data-add-row="env">Add variable</button>'}
        <p class="st-help st-help-info">The server runs in each chat’s checkout. Locked values are secrets: stored write-only and kept out of logs and transcripts.</p></div>`
  const form_ = `<div class="ext-form">
      <div class="tp-section"><label class="tp-label" for="ext-title">Name</label><input id="ext-title" class="st-input" data-form="title" value="${esc(f.title)}" placeholder="${f.kind === 'remote' ? 'Ops tools' : 'Orders database'}" autocomplete="off" spellcheck="false">
        <p class="st-help st-help-info">Agents see its tools as <code>mcp__${esc(agentName(f))}__…</code>.</p></div>
      ${fields}
      ${f.mode === 'add' ? `<div class="tp-group-label">Use it in</div>${workspacePicker(f.on, f.newWorkspaces, 'form')}` : ''}
      ${f.error ? `<p class="st-help st-help-error">${esc(f.error)}</p>` : ''}
      <div class="st-row"><button type="button" class="st-save" data-save ${f.busy ? 'disabled' : ''}>${f.mode === 'edit' ? 'Save' : 'Add server'}</button><button type="button" class="st-clear" data-cancel>Cancel</button></div>
    </div>`
  return head + `<div class="ext-custom">${form_}${previewHtml(previewServers())}</div>`
}

function importHtml(): string {
  const f = form
  return `<div class="ext-custom"><div class="ext-form">
    <div class="tp-section"><label class="tp-label" for="ext-json">Configuration</label>
      <textarea id="ext-json" class="st-input ext-json" rows="12" data-form="json" spellcheck="false" placeholder='{ "mcpServers": { "name": { "command": "npx", "args": ["-y", "…"] } } }'>${esc(f.json)}</textarea>
      <p class="st-help st-help-info">The <code>mcpServers</code> block from Claude Desktop, Cursor or VS Code. Values whose names or shapes look like keys or tokens are stored as secrets.</p></div>
    ${f.importError ? `<p class="st-help st-help-error">${esc(f.importError)}</p>` : ''}
    ${f.imported ? `<div class="ext-imported">${f.imported.map(({ spec, secrets }) => `<div class="ext-imported-row"><b>${esc(spec.title)}</b>
      <span>${spec.transport === 'stdio' ? `Local <code>${esc([spec.command, ...(spec.args ?? [])].join(' '))}</code>` : `Remote <code>${esc(spec.url ?? '')}</code>`}</span>
      ${Object.keys(secrets).length ? `<span class="ext-secret-note">${LOCK} ${esc(Object.keys(secrets).map((slot) => slot.slice(slot.indexOf(':') + 1)).join(', '))} stored as secret${Object.keys(secrets).length > 1 ? 's' : ''}</span>` : ''}</div>`).join('')}</div>
      <div class="tp-group-label">Use them in</div>${workspacePicker(f.on, f.newWorkspaces, 'form')}` : ''}
    <div class="st-row">${f.imported
      ? `<button type="button" class="st-save" data-import ${f.busy ? 'disabled' : ''}>Import ${f.imported.length} server${f.imported.length === 1 ? '' : 's'}</button>`
      : '<button type="button" class="st-save" data-read-json>Read configuration</button>'}<button type="button" class="st-clear" data-cancel>Cancel</button></div>
    </div>${previewHtml((f.imported ?? []).map(({ spec, secrets }) => masked(spec, Object.keys(secrets))))}</div>`
}

/** A definition as an agent would receive it, secrets shown as placeholders. */
function masked(spec: ImportedServer['spec'], secretSlots: string[] = []): ResolvedServer {
  const values = (fields: ImportedServer['spec']['env'], prefix: string) => Object.fromEntries((fields ?? []).map((field) => [field.name, field.secret || secretSlots.includes(`${prefix}:${field.name}`) ? SECRET : field.value ?? '']))
  const headers = values(spec.headers, 'header')
  if (spec.auth === 'oauth') headers.Authorization = `Bearer ${SECRET}`
  return spec.transport === 'stdio'
    ? { id: '', name: spec.name, title: spec.title, transport: 'stdio', command: spec.command, args: spec.args, env: values(spec.env, 'env') }
    : { id: '', name: spec.name, title: spec.title, transport: spec.transport, url: spec.url, headers }
}

function previewServers(): ResolvedServer[] {
  const f = form
  if (f.kind === 'json') return []
  const name = nameFrom(f.title || (f.kind === 'remote' ? hostOf(f.url) : f.command) || 'server')
  if (f.kind === 'local') {
    return [{ id: '', name, title: f.title, transport: 'stdio', command: f.command || 'npx', args: f.args.filter((arg) => arg.trim()), env: Object.fromEntries(f.env.filter((row) => row.name.trim()).map((row) => [row.name.trim(), row.secret ? SECRET : row.value])) }]
  }
  const headers: Record<string, string> = f.auth === 'token' || f.auth === 'oauth' ? { Authorization: `Bearer ${SECRET}` }
    : f.auth === 'headers' ? Object.fromEntries(f.headers.filter((row) => row.name.trim()).map((row) => [row.name.trim(), row.secret ? SECRET : row.value])) : {}
  return [{ id: '', name, title: f.title, transport: f.transport, url: f.url || 'https://example.com/mcp', headers }]
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.split('.').slice(-2, -1)[0] ?? '' } catch { return '' }
}

function previewHtml(servers: ResolvedServer[]): string {
  const shape = agent === 'claude' ? { comment: '// Claude Agent SDK: setMcpServers(), over the control channel', value: forClaude(servers) }
    : agent === 'codex' ? { comment: '// Codex app-server: thread/start config', value: forCodex(servers) }
    : agent === 'muse' ? { comment: '// Muse: session/start config.mcpServers', value: forMuse(servers) }
    : { comment: '// Grok (ACP): session/new mcpServers', value: forAcp(servers, { http: true, sse: true }) }
  const value = 'config' in shape.value && 'skipped' in shape.value ? shape.value.config : 'mcpServers' in shape.value ? shape.value.mcpServers : shape.value
  const skipped = 'skipped' in shape.value ? shape.value.skipped as Array<{ name: string, reason: string }> : []
  const code = esc(JSON.stringify(value, null, 2)).split(esc(SECRET)).join(`<span class="ext-code-secret">${esc(SECRET)}</span>`)
  return `<aside class="ext-preview" aria-label="What chats receive">
    <div class="ext-preview-head"><span>What chats receive</span><div class="range-picker" role="group" aria-label="Agent">${(['claude', 'codex', 'muse', 'grok'] as const).map((id) => `<button type="button" data-agent="${id}" class="${agent === id ? 'active' : ''}">${AGENT_LABEL[id]}</button>`).join('')}</div></div>
    <pre class="ext-code"><span class="ext-code-dim">${esc(shape.comment)}</span>\n${servers.length ? code : '<span class="ext-code-dim">// Fill in the server to see it here.</span>'}${skipped.map((entry) => `\n<span class="ext-code-warn">// Not sent: ${esc(entry.reason)}</span>`).join('')}</pre>
    <p class="st-help st-help-info ext-preview-note">${LOCK} Secrets show as <code>${esc(SECRET)}</code>. Poise fills them in only when it starts the agent, and keeps them out of logs, transcripts and this page.</p></aside>`
}

function renderPanel(): void {
  if (!panelEl) return
  const open = !!panel && active
  panelEl.classList.toggle('open', open)
  view.classList.toggle('ext-panel-open', open)
  if (!open || !panel) return
  patchContent(panelEl, panel.kind === 'server' ? serverPanelHtml(panel) : entryPanelHtml(panel))
}

function serverPanelHtml(p: Extract<Panel, { kind: 'server' }>): string {
  const server = data?.servers.find((candidate) => candidate.id === p.id)
  if (!server) return '<div class="tp-body"><p class="st-help st-help-info">This extension was removed.</p></div>'
  const state = stateText(server)
  const tools = server.status.tools ?? []
  const rows: Array<[string, string]> = server.transport === 'stdio'
    ? [['Command', `<code>${esc([server.command, ...(server.args ?? [])].join(' '))}</code>`], ['Runs in', 'Each chat’s checkout']]
    : [['URL', `<code>${esc(server.url ?? '')}</code>`], ['Transport', server.transport === 'sse' ? 'SSE' : 'Streamable HTTP']]
  for (const field of server.env ?? []) rows.push([field.name, field.secret ? `<span class="ext-secret-note">${LOCK} ${field.set ? 'Saved' : 'Missing'}</span>` : `<code>${esc(field.value ?? '')}</code>`])
  for (const field of server.headers ?? []) rows.push([field.name, field.secret ? `<span class="ext-secret-note">${LOCK} ${field.set ? 'Saved' : 'Missing'}</span>` : `<code>${esc(field.value ?? '')}</code>`])
  if (server.auth === 'oauth') rows.push(['Sign-in', server.signedIn ? 'Signed in' : 'Not signed in'])
  const body = p.tab === 'tools'
    ? (tools.length ? `<div class="ext-tools">${tools.map((tool) => `<div><code>${esc(tool.name)}</code>${tool.description ? `<span>${esc(tool.description)}</span>` : ''}</div>`).join('')}</div>` : '<p class="st-help st-help-info">Tools appear after a successful check.</p>')
    : p.tab === 'activity'
      ? (p.events ? (p.events.length ? `<div class="ext-log">${p.events.map((event) => `<div class="ext-log-${event.level}"><time>${esc(new Date(event.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }))}</time><span>${esc(event.text)}</span></div>`).join('')}</div>` : '<p class="st-help st-help-info">Nothing yet.</p>') : '<div class="loader" role="status" aria-label="Loading activity"><span></span><span></span><span></span></div>')
      : `<div class="ext-status"><span class="ext-state ext-state-${state.tone}">${esc(state.text)}</span>${server.status.checkedAt ? `<span class="st-help st-help-info">Checked ${esc(new Date(server.status.checkedAt).toLocaleString())}</span>` : ''}</div>
        ${server.status.error ? `<p class="st-help st-help-error">${esc(server.status.error)}</p>` : ''}
        ${server.auth === 'oauth' || server.status.state === 'signin' ? `<div class="st-row st-row-tight">${server.signedIn ? '<button type="button" class="st-clear" data-sign-out>Sign out</button>' : ''}<button type="button" class="${server.signedIn ? 'st-clear' : 'st-save'}" data-sign-in="${server.id}">${server.signedIn ? 'Sign in again' : `Sign in to ${esc(server.title)}`}</button></div>` : ''}
        <div class="tp-group-label">Connection</div>
        <div class="ext-facts">${rows.map(([key, value]) => `<div><span>${esc(key)}</span><div>${value}</div></div>`).join('')}</div>
        <div class="tp-group-label">Reaches</div>
        <div class="ext-reach">${reaches(server.transport).map((reach) => `<span class="ext-reach-chip${reach.ok ? '' : ' is-no'}" title="${esc(reach.reason ?? `Delivered to ${AGENT_LABEL[reach.agent]} chats`)}">${AGENT_LABEL[reach.agent]}</span>`).join('')}</div>
        <div class="tp-group-label">Workspaces</div>
        <p class="ext-scope">${esc(scopeText(server, data?.workspaces ?? []))}. <span class="st-help-info">Change it in the grid.</span></p>
        ${server.registry ? `<div class="tp-group-label">Directory</div><p class="ext-scope"><code>${esc(server.registry.name)}</code> ${esc(server.registry.version)}${server.registry.websiteUrl ? ` · <a href="${esc(server.registry.websiteUrl)}" target="_blank" rel="noopener noreferrer">Website</a>` : ''}</p>` : ''}
        ${p.error ? `<p class="st-help st-help-error">${esc(p.error)}</p>` : ''}
        ${p.confirm ? `<div class="ext-confirm"><p>Remove ${esc(server.title)}? Chats lose its tools from their next turn and its saved secrets are erased.</p><div class="st-row st-row-tight"><button type="button" class="st-save ext-danger" data-remove-yes>Remove</button><button type="button" class="st-clear" data-remove-no>Cancel</button></div></div>`
          : `<div class="st-row"><button type="button" class="st-clear" data-edit>Edit</button><button type="button" class="st-clear" data-check ${server.status.state === 'checking' ? 'disabled' : ''}>Check now</button><button type="button" class="st-clear ext-danger-quiet" data-remove>Remove</button></div>`}`
  return `<div class="tp-header">${tile(server.title, true)}<div class="ext-panel-title"><span class="tp-title">${esc(server.title)}</span><span class="st-help st-help-info">${esc(connection(server))}</span></div>
      <button type="button" class="tp-close" data-close aria-label="Close">&times;</button></div>
    <div class="tp-body"><div class="range-picker ext-panel-tabs" role="tablist">${(['overview', 'tools', 'activity'] as const).map((value) => `<button type="button" role="tab" data-panel-tab="${value}" class="${p.tab === value ? 'active' : ''}" aria-selected="${p.tab === value}">${value === 'overview' ? 'Overview' : value === 'tools' ? `Tools · ${server.status.toolCount ?? 0}` : 'Activity'}</button>`).join('')}</div>
      <div class="ext-panel-body">${body}</div></div>`
}

function entryPanelHtml(p: Extract<Panel, { kind: 'entry' }>): string {
  const entry = results?.entries.find((candidate) => candidate.name === p.name)
  if (!entry) return '<div class="tp-body"><p class="st-help st-help-info">This entry is no longer listed.</p></div>'
  const option = entry.options.find((candidate) => candidate.id === p.option) ?? entry.options[0]
  const added = data?.servers.find((server) => server.registry?.name === entry.name)
  const optionHtml = (candidate: InstallOption) => `<label class="ext-option${candidate.unsupported ? ' is-off' : ''}"><input type="radio" name="ext-option" data-option="${candidate.id}" ${candidate.id === option.id ? 'checked' : ''} ${candidate.unsupported ? 'disabled' : ''}>
    <span><b>${candidate.kind === 'remote' ? `Remote · ${candidate.transport === 'sse' ? 'SSE' : 'Streamable HTTP'}` : 'Local package'}</b><code>${esc(candidate.summary)}</code>${candidate.unsupported ? `<em>${esc(candidate.unsupported)}</em>` : ''}</span></label>`
  const setup = p.step === 'setup' && !added && !option.unsupported
  const body = added
    ? `<p class="st-help st-help-ok">Added. <button type="button" class="ext-link" data-open="${added.id}">Show it in Installed</button></p>`
    : setup
      ? `${entry.options.length > 1 ? `<div class="tp-group-label">How to run it</div><div class="ext-options">${entry.options.map(optionHtml).join('')}</div>` : ''}
        ${option.inputs.length ? `<div class="tp-group-label">Set up</div>${option.inputs.map((input) => `<div class="tp-section"><label class="tp-label">${esc(input.label)}${input.required ? '' : ' <span class="st-help-info">(optional)</span>'}</label>
          ${input.choices ? `<select class="st-select" data-input="${esc(input.key)}">${['', ...input.choices].map((choice) => `<option value="${esc(choice)}" ${(p.values[input.key] ?? input.default ?? '') === choice ? 'selected' : ''}>${esc(choice || 'Choose…')}</option>`).join('')}</select>`
            : `<input class="st-input" type="${input.secret ? 'password' : 'text'}" data-input="${esc(input.key)}" value="${esc(p.values[input.key] ?? '')}" placeholder="${esc(input.default ?? '')}" autocomplete="off" spellcheck="false">`}
          ${input.description ? `<p class="st-help st-help-info">${esc(input.description)}</p>` : ''}${input.secret ? `<p class="st-help st-help-info">${LOCK} Secret: stored write-only.</p>` : ''}</div>`).join('')}`
          : `<p class="st-help st-help-info">${option.kind === 'remote' ? 'Needs nothing to start. If the server asks for a sign-in, Poise shows a Sign in button after adding it.' : 'Needs no setup.'}</p>`}
        <div class="tp-group-label">Use it in</div>${workspacePicker(p.on, p.newWorkspaces, 'entry')}
        ${p.error ? `<p class="st-help st-help-error">${esc(p.error)}</p>` : ''}
        <div class="st-row"><button type="button" class="st-save" data-install ${p.busy ? 'disabled' : ''}>Add ${esc(entry.title)}</button><button type="button" class="st-clear" data-step="about">Back</button></div>`
      : `<div class="ext-options">${entry.options.map(optionHtml).join('')}</div>
        ${entry.options.some((candidate) => !candidate.unsupported) ? '<div class="st-row"><button type="button" class="st-save" data-step="setup">Add to Poise</button></div>' : '<p class="st-help st-help-warn">Poise cannot run this server as listed. Add it as a custom server instead.</p>'}`
  return `<div class="tp-header">${tile(entry.title, true)}<div class="ext-panel-title"><span class="tp-title">${esc(entry.title)}</span><span class="st-help st-help-info">${esc(entry.publisher)} · v${esc(entry.version)}</span></div>
      <button type="button" class="tp-close" data-close aria-label="Close">&times;</button></div>
    <div class="tp-body"><p class="ext-description">${esc(entry.description || 'No description.')}</p>
      <div class="ext-facts"><div><span>Registry</span><div><code>${esc(entry.name)}</code></div></div>${entry.websiteUrl ? `<div><span>Website</span><div><a href="${esc(entry.websiteUrl)}" target="_blank" rel="noopener noreferrer">${esc(entry.websiteUrl)}</a></div></div>` : ''}${entry.repositoryUrl ? `<div><span>Source</span><div><a href="${esc(entry.repositoryUrl)}" target="_blank" rel="noopener noreferrer">${esc(entry.repositoryUrl)}</a></div></div>` : ''}</div>
      ${body}</div>`
}

// ── Actions ────────────────────────────────────────────────────────────

function enabledFrom(on: Set<string>, newWorkspaces: boolean) {
  return { default: newWorkspaces, workspaces: Object.fromEntries((data?.workspaces ?? []).map((workspace) => [workspace.id, on.has(workspace.id)])) }
}

function formRequest(): { spec: Record<string, unknown>, secrets: Record<string, string> } {
  const f = form
  const secrets: Record<string, string> = {}
  const rows = (list: Row[], prefix: 'env' | 'header') => list.filter((row) => row.name.trim()).map((row) => {
    const name = row.name.trim()
    if (!row.secret) return { name, value: row.value, secret: false }
    if (row.value) secrets[`${prefix}:${name}`] = row.value
    return { name, secret: true }
  })
  const title = f.title.trim()
  const base = { name: agentName(f), title, source: f.source }
  if (f.kind === 'local') return { spec: { ...base, transport: 'stdio', command: f.command.trim(), args: f.args.filter((arg) => arg.trim()), env: rows(f.env, 'env'), auth: 'none' }, secrets }
  const headers = f.auth === 'token' ? [{ name: 'Authorization', secret: true }] : f.auth === 'headers' ? rows(f.headers, 'header') : []
  if (f.auth === 'token' && f.token) secrets['header:Authorization'] = `Bearer ${f.token.trim()}`
  return { spec: { ...base, transport: f.transport, url: f.url.trim(), headers, auth: f.auth === 'oauth' ? 'oauth' : 'none' }, secrets }
}

/** What agents call the server: kept on edit, derived from the title when adding. */
function agentName(f: Form): string {
  return f.mode === 'edit' && f.name ? f.name : nameFrom(f.title.trim() || 'name')
}

function editForm(server: ServerView): Form {
  const onlyToken = (server.headers ?? []).length === 1 && server.headers![0].name.toLowerCase() === 'authorization' && server.headers![0].secret
  const row = (field: { name: string, value?: string, secret: boolean, set?: boolean }): Row => ({ name: field.name, value: field.value ?? '', secret: field.secret, set: !!field.set })
  return {
    ...blankForm(), mode: 'edit', id: server.id, name: server.name, source: server.source, kind: server.transport === 'stdio' ? 'local' : 'remote', title: server.title,
    url: server.url ?? '', transport: server.transport === 'sse' ? 'sse' : 'http',
    auth: server.auth === 'oauth' ? 'oauth' : onlyToken ? 'token' : (server.headers ?? []).length ? 'headers' : 'none',
    tokenSet: onlyToken && !!server.headers![0].set,
    headers: (server.headers ?? []).length && !onlyToken ? server.headers!.map(row) : [{ name: '', value: '', secret: true, set: false }],
    command: server.command ?? '', args: server.args?.length ? [...server.args] : [''], env: server.env?.length ? server.env.map(row) : [{ name: '', value: '', secret: false, set: false }],
  }
}

function replaceServer(updated: ServerView): void {
  if (!data) return
  const index = data.servers.findIndex((server) => server.id === updated.id)
  if (index >= 0) data.servers[index] = updated
  else data.servers.push(updated)
}

async function saveForm(): Promise<void> {
  form.busy = true; form.error = ''; render()
  try {
    const { spec, secrets } = formRequest()
    const saved = form.mode === 'edit'
      ? await api<ServerView>(`/api/extensions/servers/${form.id}`, 'PUT', { spec, secrets })
      : await api<ServerView>('/api/extensions/servers', 'POST', { spec, secrets, enabled: enabledFrom(form.on, form.newWorkspaces) })
    replaceServer(saved)
    notice = { text: `${saved.title} ${form.mode === 'edit' ? 'saved' : 'added'}. Chats pick it up from their next turn.`, tone: 'info' }
    form = blankForm(); tab = 'installed'; panel = { kind: 'server', id: saved.id, tab: 'overview' }
    await load()
  } catch (error) {
    form.error = (error as Error).message; form.busy = false; render()
  }
}

async function importJson(): Promise<void> {
  form.busy = true; render()
  try {
    const created = await api<{ servers: ServerView[] }>('/api/extensions/import', 'POST', { json: form.json, enabled: enabledFrom(form.on, form.newWorkspaces) })
    notice = { text: `Imported ${created.servers.map((server) => server.title).join(', ')}. Secrets were stored write-only.`, tone: 'info' }
    form = blankForm(); tab = 'installed'
    await load()
  } catch (error) {
    form.importError = (error as Error).message; form.busy = false; render()
  }
}

async function install(p: Extract<Panel, { kind: 'entry' }>): Promise<void> {
  p.busy = true; p.error = ''; render()
  try {
    const entry = results!.entries.find((candidate) => candidate.name === p.name)!
    const option = entry.options.find((candidate) => candidate.id === p.option && !candidate.unsupported) ?? entry.options.find((candidate) => !candidate.unsupported)!
    const created = await api<ServerView>('/api/extensions/servers', 'POST', { install: { entry: entry.name, option: option.id, values: p.values }, enabled: enabledFrom(p.on, p.newWorkspaces) })
    replaceServer(created)
    notice = { text: `${created.title} added. Poise is checking it now.`, tone: 'info' }
    tab = 'installed'; panel = { kind: 'server', id: created.id, tab: 'overview' }
    await load()
  } catch (error) {
    p.error = (error as Error).message; p.busy = false; render()
  }
}

async function signIn(id: string): Promise<void> {
  try {
    const { authorizationUrl } = await api<{ authorizationUrl: string }>(`/api/extensions/servers/${id}/sign-in`, 'POST', { origin: location.origin })
    if (!/^https?:$/.test(new URL(authorizationUrl).protocol)) throw new Error('The sign-in page is not a web address.')
    location.assign(authorizationUrl)
  } catch (error) {
    notice = { text: (error as Error).message, tone: 'error' }; render()
  }
}

async function serverAction(id: string, path: string, method: string, body?: unknown): Promise<void> {
  const p = panel?.kind === 'server' ? panel : null
  try {
    const result = await api<ServerView | { ok: true }>(`/api/extensions/servers/${id}${path}`, method, body)
    if ('id' in result) replaceServer(result)
    await load()
  } catch (error) {
    if (p) { p.error = (error as Error).message } else notice = { text: (error as Error).message, tone: 'error' }
    render()
  }
}

async function loadEvents(p: Extract<Panel, { kind: 'server' }>): Promise<void> {
  try { p.events = (await api<{ events: ServerEvent[] }>(`/api/extensions/servers/${p.id}/events`)).events } catch (error) { p.error = (error as Error).message; p.events = [] }
  render()
}

function openTab(next: Tab): void {
  tab = next
  notice = null
  // A form nobody has touched picks up the workspaces known by now.
  if (next === 'custom' && form.mode === 'add' && !form.title && !form.url && !form.command && !form.json) form = blankForm()
  if (next === 'directory' && !results) void search()
  render()
}

function onClick(event: MouseEvent): void {
  const target = event.target as HTMLElement
  const el = target.closest<HTMLElement>('button, [data-entry], tr[data-open], a')
  if (!el || el.tagName === 'A') return
  const d = el.dataset
  if (d.tab) return openTab(d.tab as Tab)
  if (d.kind) { kind = d.kind as Kind; shown = PAGE; void search(); return }
  if ('sync' in d) { void api('/api/extensions/directory/sync', 'POST').then(() => search()); return }
  if ('more' in d) { shown += PAGE; void search(); return }
  if (d.add) { const entry = results?.entries.find((candidate) => candidate.name === d.add); if (entry) panel = { kind: 'entry', name: entry.name, step: 'setup', option: entry.options.find((option) => !option.unsupported)?.id ?? entry.options[0].id, values: {}, on: new Set(data?.workspaces.map((workspace) => workspace.id)), newWorkspaces: true }; render(); return }
  if (d.entry && el.tagName === 'ARTICLE') { const entry = results?.entries.find((candidate) => candidate.name === d.entry); if (entry) panel = { kind: 'entry', name: entry.name, step: 'about', option: entry.options.find((option) => !option.unsupported)?.id ?? entry.options[0].id, values: {}, on: new Set(data?.workspaces.map((workspace) => workspace.id)), newWorkspaces: true }; render(); return }
  if (d.open && !target.closest('label, input, button[data-sign-in]')) { tab = 'installed'; panel = { kind: 'server', id: d.open, tab: 'overview' }; render(); return }
  if ('close' in d) { panel = null; render(); return }
  if (d.signIn) { void signIn(d.signIn); return }
  if (d.agent) { agent = d.agent as AgentId; render(); return }
  if (d.formKind) { form.kind = d.formKind as Form['kind']; form.error = ''; render(); return }
  if (d.transport) { form.transport = d.transport as Form['transport']; render(); return }
  if (d.auth) { form.auth = d.auth as Form['auth']; render(); return }
  if (d.addRow) { (d.addRow === 'env' ? form.env : form.headers).push({ name: '', value: '', secret: d.addRow === 'headers', set: false }); render(); return }
  if (d.removeRow) { const list = d.removeRow === 'env' ? form.env : form.headers; list.splice(Number(d.index), 1); if (!list.length) list.push({ name: '', value: '', secret: d.removeRow === 'headers', set: false }); render(); return }
  if (d.secret) { const row = (d.secret === 'env' ? form.env : form.headers)[Number(d.index)]; row.secret = !row.secret; row.set = false; render(); return }
  if ('addArg' in d) { form.args.push(''); render(); return }
  if (d.removeArg) { form.args.splice(Number(d.removeArg), 1); if (!form.args.length) form.args.push(''); render(); return }
  if ('save' in d) { void saveForm(); return }
  if ('cancel' in d) { form = blankForm(); tab = 'installed'; render(); return }
  if ('readJson' in d) {
    try { form.imported = parseImport(form.json); form.importError = '' } catch (error) { form.imported = null; form.importError = (error as Error).message }
    render(); return
  }
  if ('import' in d) { void importJson(); return }
  if (panel?.kind === 'entry') {
    if (d.step) { panel.step = d.step as 'about' | 'setup'; render(); return }
    if ('install' in d) { void install(panel); return }
  }
  if (panel?.kind === 'server') {
    const id = panel.id
    if (d.panelTab) { panel.tab = d.panelTab as 'overview' | 'tools' | 'activity'; if (panel.tab === 'activity') { panel.events = undefined; void loadEvents(panel) } render(); return }
    if ('check' in d) { void serverAction(id, '/check', 'POST'); return }
    if ('signOut' in d) { void serverAction(id, '/sign-out', 'POST'); return }
    if ('remove' in d) { panel.confirm = true; render(); return }
    if ('removeNo' in d) { panel.confirm = false; render(); return }
    if ('removeYes' in d) { const server = data?.servers.find((candidate) => candidate.id === id); panel = null; notice = { text: `${server?.title ?? 'The server'} removed. Chats lose its tools from their next turn.`, tone: 'info' }; if (data) data.servers = data.servers.filter((candidate) => candidate.id !== id); void serverAction(id, '', 'DELETE'); return }
    if ('edit' in d) { const server = data?.servers.find((candidate) => candidate.id === id); if (server) { form = editForm(server); tab = 'custom'; panel = null; render() } return }
  }
}

function onInput(event: Event): void {
  const el = event.target as HTMLInputElement | HTMLTextAreaElement
  const d = el.dataset
  if (el.id === 'extensions-search') {
    query = el.value; shown = PAGE
    clearTimeout(searchTimer)
    searchTimer = window.setTimeout(() => void search(), 150)
    return
  }
  if (d.form) {
    (form as unknown as Record<string, string>)[d.form] = el.value
    if (d.form === 'json') { form.imported = null; form.importError = '' }
  } else if (d.arg !== undefined) form.args[Number(d.arg)] = el.value
  else if (d.list) (d.list === 'env' ? form.env : form.headers)[Number(d.index)][d.field as 'name' | 'value'] = el.value
  else if (d.input && panel?.kind === 'entry') { panel.values[d.input] = el.value; return }
  else return
  // Only the preview follows typing; the form itself is patched in place.
  const preview = view.querySelector('.ext-preview')
  if (preview) preview.outerHTML = previewHtml(previewServers())
  const hint = view.querySelector<HTMLElement>('#ext-title + .st-help code')
  if (hint) hint.textContent = `mcp__${agentName(form)}__…`
}

function onChange(event: Event): void {
  const el = event.target as HTMLInputElement
  const d = el.dataset
  if (d.switch) { void serverAction(d.switch, '/enabled', 'PUT', { workspace: d.workspace, on: el.checked }); return }
  if (d.default) { void serverAction(d.default, '/enabled', 'PUT', { default: el.checked }); return }
  if (d.option && panel?.kind === 'entry') { panel.option = d.option; render(); return }
  if (d.input && panel?.kind === 'entry' && el.tagName === 'SELECT') { panel.values[d.input] = el.value; return }
  const scope = el.closest<HTMLElement>('[data-scope]')?.dataset.scope
  const target = scope === 'entry' && panel?.kind === 'entry' ? panel : scope === 'form' ? form : null
  if (!target) return
  if ('wsNew' in d) target.newWorkspaces = el.checked
  else if (d.ws) { if (el.checked) target.on.add(d.ws); else target.on.delete(d.ws) }
}

// ── Lifecycle ──────────────────────────────────────────────────────────

let returnNotice: { text: string, tone: 'info' | 'error' } | null = null

/** The provider sends the browser back to /extensions/oauth?code&state:
 *  finish the sign-in, return to `/`, and open Extensions on that server. */
export async function finishExtensionSignIn(): Promise<boolean> {
  if (location.pathname !== '/extensions/oauth') return false
  const url = new URL(location.href)
  const body = { state: url.searchParams.get('state'), code: url.searchParams.get('code'), error: url.searchParams.get('error_description') || url.searchParams.get('error') }
  history.replaceState(null, '', '/')
  try {
    const server = await api<ServerView>('/api/extensions/oauth', 'POST', body)
    returnNotice = { text: `Signed in to ${server.title}. Chats pick it up from their next turn.`, tone: 'info' }
    panel = { kind: 'server', id: server.id, tab: 'overview' }
  } catch (error) {
    returnNotice = { text: (error as Error).message, tone: 'error' }
  }
  return true
}

export function initExtensionsView(): void {
  if (!initialized) { view = document.getElementById('view-extensions')!; shell(); initialized = true }
  active = true
  if (returnNotice) { notice = returnNotice; returnNotice = null; tab = 'installed' }
  render()
  void load()
  if (tab === 'directory') void search()
}

export function stopExtensionsRefresh(): void {
  if (!active) return
  active = false
  clearTimeout(pollTimer)
  clearTimeout(searchTimer)
  renderPanel()
}
