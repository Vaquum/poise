import { constants, closeSync, fstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { html, page } from './pages.js'

export const PUBLIC_PAGES_LIMIT = 128 * 1024
export const PUBLIC_PAGES_FILE = 'public-pages.json'

export interface PublicPages {
  version: 1
  appName: string
  contactEmail: string
  description: string
  privacy: string[]
  terms: string[]
}

function invalid(): never {
  throw new Error('Invalid public-pages.json: provide version 1, appName, contactEmail, description, and nonempty privacy/terms paragraph arrays; maximum 128 KiB. Supported substitutions: {{domain}}, {{origin}}, {{appName}}, {{contactEmail}}.')
}

function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)
}

function placeholders(value: string): boolean {
  return !value.replace(/\{\{(?:domain|origin|appName|contactEmail)\}\}/g, '').includes('{{')
}

/** Policy content is supplied and approved by the operator, never installed by an upgrade. */
export function parsePublicPages(input: string): PublicPages {
  if (Buffer.byteLength(input) > PUBLIC_PAGES_LIMIT) invalid()
  let value: unknown
  try { value = JSON.parse(input) } catch { invalid() }
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  const v = value as Record<string, unknown>
  const keys = ['version', 'appName', 'contactEmail', 'description', 'privacy', 'terms']
  if (Object.keys(v).length !== keys.length || Object.keys(v).some(k => !keys.includes(k)) || v.version !== 1) invalid()
  if (!text(v.appName, 100) || v.appName.includes('{{') || !text(v.contactEmail, 254) || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/.test(v.contactEmail)) invalid()
  if (!text(v.description, 4000) || !placeholders(v.description)) invalid()
  const paragraphs = (p: unknown): p is string[] => Array.isArray(p) && p.length > 0 && p.length <= 100 && p.every(x => text(x, 16_000) && placeholders(x))
  if (!paragraphs(v.privacy) || !paragraphs(v.terms)) invalid()
  return { version: 1, appName: v.appName, contactEmail: v.contactEmail, description: v.description, privacy: v.privacy, terms: v.terms }
}

export function loadPublicPages(dataDir: string): PublicPages | null {
  let fd: number
  try { fd = openSync(join(dataDir, PUBLIC_PAGES_FILE), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error('Cannot open public-pages.json in POISE_GATEWAY_DATA.')
  }
  try {
    if (!fstatSync(fd).isFile()) invalid()
    const buffer = Buffer.alloc(PUBLIC_PAGES_LIMIT + 1)
    let size = 0, count: number
    do { count = readSync(fd, buffer, size, buffer.length - size, null); size += count } while (count && size < buffer.length)
    if (size > PUBLIC_PAGES_LIMIT) invalid()
    let input: string
    try { input = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)) } catch { invalid() }
    return parsePublicPages(input)
  } finally { closeSync(fd) }
}

export function installPublicPages(dataDir: string, input: string): void {
  const value = parsePublicPages(input)
  const serialized = JSON.stringify(value)
  if (Buffer.byteLength(serialized) > PUBLIC_PAGES_LIMIT) invalid()
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const temp = join(dataDir, `.public-pages-${randomUUID()}.tmp`)
  writeFileSync(temp, serialized, { flag: 'wx', mode: 0o600 })
  try { renameSync(temp, join(dataDir, PUBLIC_PAGES_FILE)) }
  catch (error) { unlinkSync(temp); throw error }
}

function expand(value: string, p: PublicPages, origin: string): string {
  const variables: Record<string, string> = { domain: new URL(origin).hostname, origin, appName: p.appName, contactEmail: p.contactEmail }
  return value.replace(/\{\{(domain|origin|appName|contactEmail)\}\}/g, (_, key: string) => variables[key])
}

function links(p: PublicPages) {
  return html`<p><a href="/">${p.appName}</a> · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <a href="mailto:${encodeURIComponent(p.contactEmail)}">Contact</a></p>`
}

export function publicLandingPage(p: PublicPages, origin: string): string {
  return page(p.appName, html`<div class="card"><h1>${p.appName}</h1><p>${expand(p.description, p, origin)}</p><div class="actions"><a class="button" href="/auth/login">Sign in with GitHub</a></div>${links(p)}</div>`, { footer: new URL(origin).hostname })
}

export function publicPolicyPage(kind: 'privacy' | 'terms', p: PublicPages, origin: string): string {
  const title = kind === 'privacy' ? 'Privacy notice' : 'Service terms'
  return page(title, html`<div class="card"><h1>${title}</h1>${p[kind].map(paragraph => html`<p>${expand(paragraph, p, origin)}</p>`)}${links(p)}</div>`, { wide: true, footer: new URL(origin).hostname })
}
