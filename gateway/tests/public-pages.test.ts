import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installPublicPages, loadPublicPages, parsePublicPages, publicPolicyPage, PUBLIC_PAGES_LIMIT } from '../src/public-pages.js'
import { APEX, startHarness, workspaceHost, type Harness } from './harness.js'

const DATA = {
  version: 1, appName: 'Acme writing', contactEmail: 'help@acme.example',
  description: 'A private writing workspace at {{domain}}.',
  privacy: ['{{appName}} at {{origin}} uses Google only for requested document operations.', 'Contact {{contactEmail}}. <script>alert(1)</script>'],
  terms: ['Use only documents you are authorized to access.'],
}

describe('operator public page content', () => {
  const dirs: string[] = []
  const dir = () => { const d = mkdtempSync(join(tmpdir(), 'public-pages-')); dirs.push(d); return d }
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

  it('is absent by default and persists explicitly installed content without touching gateway data', () => {
    const d = dir()
    expect(loadPublicPages(d)).toBeNull()
    writeFileSync(join(d, 'gateway.db'), 'private state')
    installPublicPages(d, JSON.stringify(DATA))
    expect(loadPublicPages(d)).toEqual(DATA)
    installPublicPages(d, JSON.stringify({ ...DATA, appName: 'Updated operator name' }))
    expect(loadPublicPages(d)?.appName).toBe('Updated operator name')
    expect(readFileSync(join(d, 'gateway.db'), 'utf8')).toBe('private state')
  })

  it('rejects malformed, partial, oversized and unknown input without publishing or echoing contents', () => {
    const d = dir()
    for (const input of ['not-json-private-sentinel', '{}', JSON.stringify({ ...DATA, secret: 'private-sentinel' }), JSON.stringify({ ...DATA, privacy: [] }), JSON.stringify({ ...DATA, description: '{{secret}}' }), JSON.stringify({ ...DATA, contactEmail: 'x@example.com\nInjected' }), ' '.repeat(PUBLIC_PAGES_LIMIT + 1)]) {
      expect(() => installPublicPages(d, input)).toThrow('Invalid public-pages.json')
      expect(loadPublicPages(d)).toBeNull()
      try { parsePublicPages(input) } catch (e) { expect(String(e)).not.toContain('private-sentinel') }
    }
  })

  it('keeps accepted near-limit compact input readable after installation', () => {
    const d = dir()
    const content = { ...DATA, privacy: Array.from({ length: 100 }, () => 'a'.repeat(1305)) }
    const input = JSON.stringify(content)
    expect(Buffer.byteLength(input)).toBeLessThanOrEqual(PUBLIC_PAGES_LIMIT)
    expect(Buffer.byteLength(JSON.stringify(content, null, 2))).toBeGreaterThan(PUBLIC_PAGES_LIMIT)
    installPublicPages(d, input)
    expect(loadPublicPages(d)).toEqual(content)
    expect(readFileSync(join(d, 'public-pages.json')).byteLength).toBeLessThanOrEqual(PUBLIC_PAGES_LIMIT)
  })

  it('encodes accepted contact addresses as a mailto recipient, not URI syntax', () => {
    const contactEmail = 'help#team+support?subject=test%20&header=value@example.com'
    const rendered = publicPolicyPage('privacy', parsePublicPages(JSON.stringify({ ...DATA, contactEmail })), 'https://writing.example.org')
    expect(rendered).toContain(`href="mailto:${encodeURIComponent(contactEmail)}"`)
    const href = /href="(mailto:[^"]+)"/.exec(rendered)?.[1]
    expect(href).toBeDefined()
    const uri = new URL(href!)
    expect(uri.hash).toBe('')
    expect(uri.search).toBe('')
    expect(decodeURIComponent(uri.pathname)).toBe(contactEmail)
  })

  it('refuses symlinks, invalid UTF-8 and files beyond the bounded read', () => {
    const d = dir(), target = join(d, 'private.json'), file = join(d, 'public-pages.json')
    writeFileSync(target, JSON.stringify(DATA))
    symlinkSync(target, file)
    expect(() => loadPublicPages(d)).toThrow('Cannot open public-pages.json')
    rmSync(file)
    writeFileSync(file, Buffer.from([0xff]))
    expect(() => loadPublicPages(d)).toThrow('Invalid public-pages.json')
    writeFileSync(file, Buffer.alloc(PUBLIC_PAGES_LIMIT + 1))
    expect(() => loadPublicPages(d)).toThrow('Invalid public-pages.json')
  })

  it('derives URLs from each deployment and escapes all operator content', () => {
    const p = parsePublicPages(JSON.stringify(DATA))
    for (const origin of ['https://writing.acme.example', 'https://notes.other.example:8443']) {
      const rendered = publicPolicyPage('privacy', p, origin)
      expect(rendered).toContain(origin)
      expect(rendered).toContain('Acme writing')
      expect(rendered).toContain('help@acme.example')
      expect(rendered).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
      expect(rendered).not.toContain('<script>')
      expect(rendered).not.toContain('{{')
      expect(rendered).not.toContain(origin.includes('writing.acme.example') ? 'notes.other.example' : 'writing.acme.example')
    }
  })
})

describe('public apex routes', () => {
  let h: Harness | undefined
  afterEach(async () => { await h?.close(); h = undefined })

  it('retains the existing sign-in and absent policy routes when not configured', async () => {
    h = await startHarness()
    expect((await h.request({ host: APEX, path: '/' })).body).toContain('Use your GitHub account')
    for (const path of ['/privacy', '/terms']) for (const method of ['GET', 'POST']) expect((await h.request({ host: APEX, path, method })).status).toBe(404)
  })

  it('serves exact GET/HEAD routes without authentication on the configured apex, with existing CSP', async () => {
    h = await startHarness({ publicPages: DATA, env: { POISE_DOMAIN: 'writing.acme.test' } })
    const host = h.config.domain
    const landing = await h.request({ host, path: '/' })
    expect(landing.status).toBe(200)
    expect(landing.body).toContain('A private writing workspace at writing.acme.test.')
    expect(landing.body).toContain('href="/privacy"')
    expect(landing.body).toContain('href="/terms"')
    expect(landing.headers['set-cookie']).toBeUndefined()
    for (const path of ['/privacy', '/terms']) {
      const get = await h.request({ host, path })
      expect(get.status).toBe(200)
      expect(get.headers['content-security-policy']).toContain("default-src 'none'")
      expect(get.headers['x-content-type-options']).toBe('nosniff')
      const head = await h.request({ host, path, method: 'HEAD' })
      expect(head.status).toBe(200)
      expect(head.body).toBe('')
      expect(head.headers['content-length']).toBe(get.headers['content-length'])
      expect((await h.request({ host, path, method: 'POST' })).status).toBe(405)
    }
    for (const path of ['/privacy/', '/privacy.json', '/public-pages.json', '/%70rivacy', '/x/../privacy', '/x/%2e%2e/privacy', '/%2e/privacy', '/./terms', '//other.invalid/privacy', 'http://other.invalid/privacy', '/x/..', '/x\\../privacy']) expect((await h.request({ host, path })).status).toBe(404)
    for (const otherHost of ['unrelated.example', 'gateway:8080']) expect((await h.request({ host: otherHost, path: '/privacy' })).status).toBe(404)
  })

  it('keeps authenticated home behavior and every workspace authentication boundary', async () => {
    h = await startHarness({ publicPages: DATA })
    const { apexCookie } = await h.signIn('Alice')
    const home = await h.request({ host: APEX, path: '/', headers: { cookie: apexCookie } })
    expect(home.body).toContain('Signed in as Alice')
    const workspace = await h.request({ host: workspaceHost('alice'), path: '/privacy', headers: { accept: 'text/html' } })
    expect(workspace.status).toBe(302)
    expect(workspace.body).not.toContain('Acme writing')
    expect((await h.request({ host: APEX, path: '/admin' })).status).toBe(302)
  })
})
