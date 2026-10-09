import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// What the page does while its workspace restarts onto a new release
// (src/updating.ts): dims itself under "Updating to the latest version" when
// the gateway marks an answer, and reloads once Poise answers again.

class FakeElement {
  className = ''
  innerHTML = ''
  attributes: Record<string, string> = {}
  classes = new Set<string>()
  classList = { add: (name: string) => { this.classes.add(name) } }
  setAttribute(name: string, value: string): void { this.attributes[name] = value }
  remove(): void { appended.splice(appended.indexOf(this), 1) }
}

let appended: FakeElement[] = []
const reload = vi.fn()
const fetchMock = vi.fn<(input: unknown) => Promise<Response>>()
const updating = () => new Response('{"error":"workspace_updating"}', { status: 503, headers: { 'x-poise-updating': '1' } })
const ok = () => new Response('{"mode":"service"}', { status: 200 })

async function load() {
  vi.resetModules()
  return import('../src/updating')
}

beforeEach(() => {
  vi.useFakeTimers()
  appended = []
  reload.mockReset()
  fetchMock.mockReset()
  vi.stubGlobal('window', { fetch: fetchMock })
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('document', { createElement: () => new FakeElement(), body: { append: (element: FakeElement) => appended.push(element) } })
  vi.stubGlobal('location', { reload })
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => callback())
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the updating notice', () => {
  it('dims the page when the gateway marks an answer, and reloads once Poise answers again', async () => {
    const { UPDATING_POLL_MS, UPDATING_PROBE_PATH, watchForUpdates } = await load()
    watchForUpdates()
    fetchMock.mockResolvedValueOnce(updating()).mockResolvedValueOnce(updating()).mockResolvedValueOnce(ok())
    const answer = await window.fetch('/api/current')
    expect(answer.status).toBe(503)
    expect(appended).toHaveLength(1)
    expect(appended[0].innerHTML).toContain('Updating to the latest version')
    expect(appended[0].classes.has('up-visible')).toBe(true)
    expect(appended[0].attributes.role).toBe('alertdialog')

    await vi.advanceTimersByTimeAsync(UPDATING_POLL_MS)
    expect(fetchMock).toHaveBeenLastCalledWith(UPDATING_PROBE_PATH, { cache: 'no-store' })
    expect(reload).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(UPDATING_POLL_MS)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('leaves ordinary answers, and failures without the gateway\'s mark, alone', async () => {
    const { watchForUpdates } = await load()
    watchForUpdates()
    fetchMock.mockResolvedValueOnce(ok()).mockResolvedValueOnce(new Response('', { status: 503 }))
    await window.fetch('/api/current')
    await window.fetch('/api/current')
    expect(appended).toHaveLength(0)
  })

  it('asks the gateway after a dropped connection, and shows one notice however often it hears', async () => {
    const { probeForUpdate, watchForUpdates } = await load()
    watchForUpdates()
    fetchMock.mockResolvedValue(updating())
    await probeForUpdate()
    await window.fetch('/api/current')
    expect(appended).toHaveLength(1)
  })

  it('stays quiet when the dropped connection was not an update', async () => {
    const { probeForUpdate } = await load()
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await probeForUpdate()
    fetchMock.mockResolvedValueOnce(ok())
    await probeForUpdate()
    expect(appended).toHaveLength(0)
  })
})
