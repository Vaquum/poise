import type { AllowedLogin, User, WorkspaceRecord } from './store.js'
import type { DiskReport } from './disk.js'

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

/** Inter, as Poise itself loads it; the page CSP admits this origin for styles and fonts. */
export const FONT_ORIGIN = 'https://rsms.me'

// Poise's own design tokens (src/style.css), light and dark, so the pages before the workspace look like
// the workspace. The browser's colour scheme picks the theme: the one chosen in Poise is kept by the
// workspace host's browser storage, which the apex cannot read.
const STYLE = `
  :root {
    color-scheme: light;
    --bg: #F7F8F9; --surface: #EEF0F2; --hover: #DEE2E6; --hairline: #DEE2E6; --border: #C5CBD1;
    --text: #2F353D; --text-secondary: #5C636D; --text-tertiary: #8E959E;
    --n0: #F7F8F9; --n5: #5C636D; --n6: #2F353D; --a1: #3A72B0; --a5: #B85048;
    --e-3: 0 12px 24px rgba(22, 26, 32, .14), 0 4px 8px rgba(22, 26, 32, .06);
    --ease: cubic-bezier(0.2, 0, 0, 1);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      color-scheme: dark;
      --bg: #161A20; --surface: #1C2129; --hover: #2F353D; --hairline: #2F353D; --border: #5C636D;
      --text: #DEE2E6; --text-secondary: #C5CBD1; --text-tertiary: #8E959E;
      --n0: #161A20; --n5: #C5CBD1; --n6: #DEE2E6;
      --e-3: 0 12px 24px rgba(0, 0, 0, .55), 0 4px 8px rgba(0, 0, 0, .35);
    }
  }
  *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
  html { font-size: 15px; background: var(--bg); -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
  body {
    min-height: 100vh; min-height: 100dvh; display: grid; place-items: center; padding: 48px 16px;
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; line-height: 1.5;
    color: var(--text); background: var(--bg);
  }
  main { width: min(400px, 100%); display: flex; flex-direction: column; gap: 20px; animation: enter 250ms var(--ease) both; }
  main.wide { width: min(960px, 100%); }
  @keyframes enter { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
  .brand { text-align: center; font-size: 1.25rem; font-weight: 600; letter-spacing: -0.015em; color: var(--text); }
  .card {
    display: flex; flex-direction: column; gap: 12px; padding: 24px;
    background: var(--surface); border: 1px solid var(--hairline); border-radius: 8px; box-shadow: var(--e-3);
  }
  .label {
    font-size: 0.625rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em;
    color: var(--text-tertiary); padding-bottom: 6px; border-bottom: 1px solid var(--border);
  }
  h1 { font-size: 1rem; font-weight: 600; line-height: 1.35; color: var(--text); }
  p { font-size: 0.8125rem; color: var(--text-secondary); }
  strong { font-weight: 600; color: var(--text); }
  .muted { font-size: 0.75rem; color: var(--text-tertiary); }
  .error { color: var(--a5); }
  .footer { text-align: center; font-size: 0.6875rem; color: var(--text-tertiary); }
  a { color: var(--text-secondary); text-decoration: underline; text-underline-offset: 2px; }
  a:hover { color: var(--text); }
  code { font-family: 'SF Mono', 'JetBrains Mono', Menlo, monospace; font-size: 0.75rem; }
  .actions { display: flex; flex-direction: column; gap: 8px; margin-top: 4px; }
  .actions form { display: flex; flex-direction: column; }
  .button, button {
    display: inline-block; padding: 8px 14px; font: inherit; font-size: 0.75rem; font-weight: 600; line-height: 1.5;
    text-align: center; text-decoration: none; cursor: pointer; border-radius: 8px;
    color: var(--n0); background: var(--n5); border: 1px solid var(--n5);
    transition: background 180ms ease, border-color 180ms ease, color 180ms ease;
  }
  .button:hover, button:hover { color: var(--n0); background: var(--n6); border-color: var(--n6); }
  .button.secondary, button.secondary { color: var(--text-secondary); background: var(--surface); border-color: var(--border); }
  .button.secondary:hover, button.secondary:hover { color: var(--text); background: var(--surface); border-color: var(--text-tertiary); }
  button.danger { color: var(--a5); background: var(--surface); border-color: var(--border); }
  button.danger:hover { color: var(--a5); background: var(--surface); border-color: var(--a5); }
  :focus-visible { outline: 2px solid var(--a1); outline-offset: 2px; }
  :focus:not(:focus-visible) { outline: none; }
  .loader { display: flex; justify-content: center; gap: 6px; padding: 8px 0; }
  .loader span { width: 5px; height: 5px; border-radius: 999px; background: var(--text-tertiary); animation: pulse 1s ease-in-out infinite; }
  .loader span:nth-child(2) { animation-delay: 0.15s; }
  .loader span:nth-child(3) { animation-delay: 0.3s; }
  @keyframes pulse { 0%, 100% { opacity: 0.2; transform: scale(0.8); } 50% { opacity: 1; transform: scale(1); } }
  form.inline { display: inline; }
  .row { display: flex; gap: 8px; align-items: center; }
  input[type=text] {
    flex: 1; min-width: 0; padding: 8px 10px; font-family: 'SF Mono', 'JetBrains Mono', Menlo, monospace; font-size: 0.75rem;
    color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: 8px; outline: none;
  }
  input[type=text]:focus { border-color: var(--text); }
  table { width: 100%; border-collapse: collapse; }
  th {
    text-align: left; font-size: 0.6875rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em;
    color: var(--text-tertiary); padding: 0 12px 10px 0; border-bottom: 1px solid var(--border);
  }
  td { padding: 11px 12px 11px 0; font-size: 0.8125rem; vertical-align: top; border-bottom: 1px solid var(--hairline); }
  td form.inline + form.inline { margin-left: 4px; }
  @media (prefers-reduced-motion: reduce) { main, .loader span { animation: none; } }
`

export function page(title: string, body: Html, options: { refreshSeconds?: number; wide?: boolean; footer?: string } = {}): string {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
${options.refreshSeconds ? html`<meta http-equiv="refresh" content="${options.refreshSeconds}">` : ''}
<title>${title} · Poise</title>
<link rel="stylesheet" href="${FONT_ORIGIN}/inter/inter.css">
<style>${new Html(STYLE)}</style>
</head>
<body><main${options.wide ? html` class="wide"` : ''}>
<div class="brand">Poise</div>
${body}
${options.footer ? html`<div class="footer">${options.footer}</div>` : ''}
</main></body>
</html>
`.value
}

export function messagePage(title: string, message: string, link?: { href: string; label: string }): string {
  return page(title, html`<div class="card">
<h1>${title}</h1>
<p>${message}</p>
${link ? html`<div class="actions"><a class="button" href="${link.href}">${link.label}</a></div>` : ''}
</div>`)
}

export function signInPage(domain: string): string {
  return page('Sign in', html`<div class="card">
<div class="label">Welcome</div>
<h1>Sign in</h1>
<p>Use your GitHub account to open your Poise workspace.</p>
<div class="actions"><a class="button" href="/auth/login">Sign in with GitHub</a></div>
</div>`, { footer: domain })
}

export function homePage(input: { user: User; workspaceHref: string; workspaceHost: string; csrf: string }): string {
  return page('Poise', html`<div class="card">
<div class="label">Your workspace</div>
<h1>Signed in as ${input.user.login}</h1>
<p>Your workspace lives at <code>${input.workspaceHost}</code>. Devices, sign-ins and everything else are in its Settings.</p>
<div class="actions">
<a class="button" href="${input.workspaceHref}">Open your workspace</a>
${signOutForm('/auth/logout', input.csrf)}
</div>
</div>`)
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
<div class="actions">${signOutForm(action, csrf)}</div>
</div>`)
}

export function startingPage(input: { workspaceHost: string; lastError: string | null; problem: string | null; adminHref: string | null }): string {
  return page('Starting your workspace', html`<div class="card">
<div class="label">Your workspace</div>
<h1>Starting your workspace…</h1>
<p>Your Poise at <code>${input.workspaceHost}</code> is starting. This page reloads by itself when it is ready.</p>
<div class="loader" aria-hidden="true"><span></span><span></span><span></span></div>
${input.lastError ? html`<p class="error">The last start failed: ${input.lastError}</p>` : ''}
${input.problem ? html`<p class="error">${input.problem}</p>` : ''}
${input.adminHref && input.lastError ? html`<p class="muted">As an admin you can restart it from the <a href="${input.adminHref}">admin page</a>.</p>` : ''}
</div>`, { refreshSeconds: 2 })
}

/** While a workspace restarts onto a new release; Poise's own page shows the same over itself. */
export function updatingPage(input: { workspaceHost: string }): string {
  return page('Updating Poise', html`<div class="card">
<div class="label">Your workspace</div>
<h1>Updating to the latest version…</h1>
<p>Your Poise at <code>${input.workspaceHost}</code> is restarting on its new version. Running agents and reviews carry on. This page reloads by itself in a few seconds.</p>
<div class="loader" aria-hidden="true"><span></span><span></span><span></span></div>
</div>`, { refreshSeconds: 2 })
}

/** Poise Link's installer (link/install.sh), as published with the newest release. */
export const LINK_INSTALLER_URL = 'https://github.com/autonomio/poise/releases/latest/download/install.sh'
/** Where the Windows installers and every other Poise Link build are. */
export const LINK_RELEASES_URL = 'https://github.com/autonomio/poise/releases/latest'

export function when(ms: number | null): string {
  return ms === null ? 'never' : new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
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
  access: Map<string, string>
  dockerError: string | null
  /** What the gateway last measured of disk use; null before the first measurement. */
  disk: DiskReport | null
  /** POISE_WORKSPACE_DISK_BUDGET in bytes; 0 for none. */
  diskBudget: number
}

/** Bytes as a person reads them: 2.4 GB. */
export function size(bytes: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return unit === 0 ? `${value} bytes` : `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`
}

function diskLine(view: AdminView): Html | string {
  const { disk } = view
  if (!disk || disk.free === null || disk.total === null) return ''
  const text = `Server disk: ${size(disk.free)} free of ${size(disk.total)}, measured ${when(disk.measuredAt)}.`
  return disk.low ? html`<p class="error">${text} Less than a tenth is free.</p>` : html`<p class="muted">${text}</p>`
}

function workspaceDisk(view: AdminView, handle: string): Html | string {
  const bytes = view.disk?.workspaces.get(handle)
  if (bytes === undefined) return ''
  const over = view.diskBudget > 0 && bytes > view.diskBudget
  return over
    ? html`<br><span class="error">${size(bytes)} on disk, over its ${size(view.diskBudget)} budget</span>`
    : html`<br><span class="muted">${size(bytes)} on disk</span>`
}

function actionButton(csrf: string, action: string, handle: string, label: string, style = 'secondary'): Html {
  return html`<form class="inline" method="post" action="/admin/${action}">
<input type="hidden" name="csrf" value="${csrf}">
<input type="hidden" name="handle" value="${handle}">
<button class="${style}" type="submit">${label}</button>
</form>`
}

/**
 * The admin page at the apex. Admins use Settings → Admin in their workspace; this page stays for when
 * their own workspace cannot open, which is when it is needed most.
 */
export function adminPage(view: AdminView): string {
  const userRows = view.users.map((user) => {
    const workspace = view.workspaces?.get(user.handle)
    const record = view.records.get(user.handle)
    return html`<tr>
<td><strong>${user.login}</strong>${view.admins.includes(user.handle) ? html` <span class="muted">admin</span>` : ''}<br><span class="muted">${view.access.get(user.handle) ?? ''} · last sign-in ${when(user.lastLoginAt)}</span></td>
<td>${view.workspaces === null ? html`<span class="muted">unknown</span>` : workspace ? workspace.state : 'not created'}${workspaceDisk(view, user.handle)}
${record?.lastError ? html`<br><span class="error">${record.lastError}</span>` : ''}</td>
<td>${workspace ? html`<code>${workspace.image}</code>` : ''}</td>
<td>${actionButton(view.csrf, 'workspaces/start', user.handle, 'Start')} ${actionButton(view.csrf, 'workspaces/stop', user.handle, 'Stop')} ${actionButton(view.csrf, 'workspaces/restart', user.handle, 'Restart')}
${user.disabledAt === null
    ? actionButton(view.csrf, 'users/disable', user.handle, 'Disable', 'danger')
    : actionButton(view.csrf, 'users/enable', user.handle, 'Enable')}</td>
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
<div class="label">Users and workspaces</div>
${view.dockerError ? html`<p class="error">Docker Engine: ${view.dockerError}</p>` : ''}
${diskLine(view)}
${view.users.length === 0
    ? html`<p class="muted">Nobody has signed in yet.</p>`
    : html`<table><tr><th>User</th><th>Workspace</th><th>Image</th><th></th></tr>${userRows}</table>`}
</div>
<div class="card">
<div class="label">Allowed logins</div>
<p class="muted">Admins (${view.admins.join(', ')}) may always sign in.${view.allowedOrgs.length > 0 ? ` Members of ${view.allowedOrgs.join(', ')} may sign in too.` : ''}</p>
${view.allowed.length > 0 ? html`<table><tr><th>Login</th><th>Source</th><th></th></tr>${allowRows}</table>` : ''}
<form method="post" action="/admin/allow">
<input type="hidden" name="csrf" value="${view.csrf}">
<div class="row"><input type="text" name="login" placeholder="GitHub login" autocomplete="off" spellcheck="false" required> <button type="submit">Allow</button></div>
</form>
<p class="muted">The same controls are in Settings → Admin in your workspace. <a href="/">Home</a></p>
</div>`, { wide: true })
}
