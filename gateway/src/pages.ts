import type { AllowedLogin, Device, User, WorkspaceRecord } from './store.js'

/** Markup that is already safe to emit. Everything else interpolated into `html` is escaped. */
export class Html {
  constructor(readonly value: string) {}
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function render(value: unknown): string {
  if (value instanceof Html) return value.value
  if (Array.isArray(value)) return value.map(render).join('')
  if (value === null || value === undefined || value === false) return ''
  return escapeHtml(String(value))
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0]
  values.forEach((value, index) => {
    out += render(value) + strings[index + 1]
  })
  return new Html(out)
}

const STYLE = `
  :root { color-scheme: light dark; --fg: #1d1d1f; --muted: #6e6e73; --bg: #f5f5f7; --card: #fff; --line: #d2d2d7; --accent: #0a66d8; --danger: #c4231a; }
  @media (prefers-color-scheme: dark) { :root { --fg: #f5f5f7; --muted: #a1a1a6; --bg: #111113; --card: #1c1c1f; --line: #38383d; --accent: #4c9aff; --danger: #ff6961; } }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--fg); background: var(--bg); }
  main { max-width: 760px; margin: 0 auto; padding: 48px 16px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 24px; margin-bottom: 16px; }
  h1 { font-size: 22px; margin: 0 0 12px; }
  h2 { font-size: 17px; margin: 0 0 12px; }
  p { margin: 0 0 12px; }
  .muted { color: var(--muted); }
  .error { color: var(--danger); }
  a { color: var(--accent); }
  .button, button { display: inline-block; font: inherit; padding: 8px 14px; border-radius: 8px; border: 1px solid var(--accent); background: var(--accent); color: #fff; text-decoration: none; cursor: pointer; }
  button.secondary { background: transparent; color: var(--accent); }
  button.danger { background: transparent; color: var(--danger); border-color: var(--danger); }
  form.inline { display: inline; }
  input[type=text] { font: inherit; padding: 7px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); color: var(--fg); }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { font-weight: 600; color: var(--muted); font-size: 13px; }
  nav { display: flex; gap: 16px; flex-wrap: wrap; }
  code { font: 13px ui-monospace, Menlo, monospace; }
`

export function page(title: string, body: Html, options: { refreshSeconds?: number } = {}): string {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${options.refreshSeconds ? html`<meta http-equiv="refresh" content="${options.refreshSeconds}">` : ''}
<title>${title} · Poise</title>
<style>${new Html(STYLE)}</style>
</head>
<body><main>${body}</main></body>
</html>
`.value
}

export function messagePage(title: string, message: string, link?: { href: string; label: string }): string {
  return page(title, html`<div class="card">
<h1>${title}</h1>
<p>${message}</p>
${link ? html`<p><a href="${link.href}">${link.label}</a></p>` : ''}
</div>`)
}

export function signInPage(): string {
  return page('Sign in', html`<div class="card">
<h1>Poise</h1>
<p>Sign in with your GitHub account to open your workspace.</p>
<p><a class="button" href="/auth/login">Sign in with GitHub</a></p>
</div>`)
}

export function homePage(input: { user: User; isAdmin: boolean; workspaceHref: string; workspaceHost: string; csrf: string }): string {
  return page('Poise', html`<div class="card">
<h1>Poise</h1>
<p>Signed in as <strong>${input.user.login}</strong>.</p>
<p><a class="button" href="${input.workspaceHref}">Open your workspace</a></p>
<p class="muted">Your workspace lives at <code>${input.workspaceHost}</code>.</p>
</div>
<div class="card">
<nav>
<a href="/link">Pair Poise Link</a>
<a href="/link/devices">Paired devices</a>
${input.isAdmin ? html`<a href="/admin">Admin</a>` : ''}
</nav>
</div>
${signOutForm('/auth/logout', input.csrf)}`)
}

function signOutForm(action: string, csrf: string): Html {
  return html`<form method="post" action="${action}">
<input type="hidden" name="csrf" value="${csrf}">
<button class="secondary" type="submit">Sign out</button>
</form>`
}

export function signOutPage(action: string, csrf: string): string {
  return page('Sign out', html`<div class="card">
<h1>Sign out of Poise?</h1>
<p>This signs you out of the gateway and of your workspace in this browser.</p>
${signOutForm(action, csrf)}
</div>`)
}

export function startingPage(input: { workspaceHost: string; lastError: string | null; problem: string | null }): string {
  return page('Starting your workspace', html`<div class="card">
<h1>Starting your workspace…</h1>
<p>Your Poise at <code>${input.workspaceHost}</code> is starting. This page reloads by itself when it is ready.</p>
${input.lastError ? html`<p class="error">The last start failed: ${input.lastError}</p>` : ''}
${input.problem ? html`<p class="error">${input.problem}</p>` : ''}
</div>`, { refreshSeconds: 2 })
}

export function linkPage(csrf: string, notice?: { text: string; error: boolean }): string {
  return page('Pair Poise Link', html`<div class="card">
<h1>Pair Poise Link</h1>
<p>Type the code Poise Link shows you, then approve it to let that computer receive your snippets and alerts.</p>
${notice ? html`<p class="${notice.error ? 'error' : ''}">${notice.text}</p>` : ''}
<form method="post" action="/link">
<input type="hidden" name="csrf" value="${csrf}">
<p><input type="text" name="user_code" placeholder="XXXX-XXXX" autocomplete="off" autocapitalize="characters" spellcheck="false" required></p>
<p>
<button type="submit" name="decision" value="approve">Approve</button>
<button class="danger" type="submit" name="decision" value="deny">Deny</button>
</p>
</form>
<p><a href="/link/devices">Paired devices</a> · <a href="/">Home</a></p>
</div>`)
}

function when(ms: number | null): string {
  return ms === null ? 'never' : new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
}

export function devicesPage(devices: Device[], csrf: string): string {
  const rows = devices.map((device) => html`<tr>
<td>${device.label ?? 'Poise Link'}</td>
<td>${when(device.createdAt)}</td>
<td>${when(device.lastUsedAt)}</td>
<td>${device.revokedAt === null
    ? html`<form class="inline" method="post" action="/link/devices/revoke">
<input type="hidden" name="csrf" value="${csrf}">
<input type="hidden" name="id" value="${device.id}">
<button class="danger" type="submit">Revoke</button>
</form>`
    : html`<span class="muted">Revoked ${when(device.revokedAt)}</span>`}</td>
</tr>`)
  return page('Paired devices', html`<div class="card">
<h1>Paired devices</h1>
${devices.length === 0
    ? html`<p class="muted">No devices are paired with your workspace.</p>`
    : html`<table><tr><th>Device</th><th>Paired</th><th>Last used</th><th></th></tr>${rows}</table>`}
<p><a href="/link">Pair another device</a> · <a href="/">Home</a></p>
</div>`)
}

export interface AdminWorkspaceView {
  state: string
  image: string
}

export interface AdminView {
  csrf: string
  users: User[]
  allowed: AllowedLogin[]
  admins: string[]
  allowedOrgs: string[]
  workspaces: Map<string, AdminWorkspaceView> | null
  records: Map<string, WorkspaceRecord>
  dockerError: string | null
}

function actionButton(csrf: string, action: string, handle: string, label: string, style = 'secondary'): Html {
  return html`<form class="inline" method="post" action="/admin/workspaces/${action}">
<input type="hidden" name="csrf" value="${csrf}">
<input type="hidden" name="handle" value="${handle}">
<button class="${style}" type="submit">${label}</button>
</form>`
}

export function adminPage(view: AdminView): string {
  const userRows = view.users.map((user) => {
    const workspace = view.workspaces?.get(user.handle)
    const record = view.records.get(user.handle)
    return html`<tr>
<td><strong>${user.login}</strong>${view.admins.includes(user.handle) ? html` <span class="muted">admin</span>` : ''}<br><span class="muted">last sign-in ${when(user.lastLoginAt)}</span></td>
<td>${view.workspaces === null ? html`<span class="muted">unknown</span>` : workspace ? workspace.state : 'not created'}
${record?.lastError ? html`<br><span class="error">${record.lastError}</span>` : ''}</td>
<td>${workspace ? html`<code>${workspace.image}</code>` : ''}</td>
<td>${actionButton(view.csrf, 'start', user.handle, 'Start')} ${actionButton(view.csrf, 'stop', user.handle, 'Stop')} ${actionButton(view.csrf, 'restart', user.handle, 'Restart')}</td>
</tr>`
  })
  const allowRows = view.allowed.map((entry) => html`<tr>
<td>${entry.handle}</td>
<td>${entry.source === 'env' ? 'POISE_ALLOWED_USERS' : html`added by ${entry.addedBy ?? 'an admin'}`}</td>
<td>${entry.source === 'env'
    ? html`<span class="muted">Remove it from POISE_ALLOWED_USERS</span>`
    : html`<form class="inline" method="post" action="/admin/allow/remove">
<input type="hidden" name="csrf" value="${view.csrf}">
<input type="hidden" name="login" value="${entry.handle}">
<button class="danger" type="submit">Remove</button>
</form>`}</td>
</tr>`)
  return page('Admin', html`<div class="card">
<h1>Users and workspaces</h1>
${view.dockerError ? html`<p class="error">Docker Engine: ${view.dockerError}</p>` : ''}
${view.users.length === 0
    ? html`<p class="muted">Nobody has signed in yet.</p>`
    : html`<table><tr><th>User</th><th>Workspace</th><th>Image</th><th></th></tr>${userRows}</table>`}
</div>
<div class="card">
<h2>Allowed logins</h2>
<p class="muted">Admins (${view.admins.join(', ')}) may always sign in.${view.allowedOrgs.length > 0 ? ` Members of ${view.allowedOrgs.join(', ')} may sign in too.` : ''}</p>
${view.allowed.length > 0 ? html`<table><tr><th>Login</th><th>Source</th><th></th></tr>${allowRows}</table>` : ''}
<form method="post" action="/admin/allow">
<input type="hidden" name="csrf" value="${view.csrf}">
<p><input type="text" name="login" placeholder="GitHub login" autocomplete="off" spellcheck="false" required> <button type="submit">Allow</button></p>
</form>
<p><a href="/">Home</a></p>
</div>`)
}
