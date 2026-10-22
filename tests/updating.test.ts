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
let listeners: Record<string, Array<() => void>> = {}
let sessionStore: Record<string, string> = {}
const reload = vi.fn()
const fetchMock = vi.fn<(input: unknown, init?: unknown) => Promise<Response>>()
const updating = () => new Response('{"error":"workspace_updating"}', { status: 503, headers: { 'x-poise-updating': '1' } })
const ok = () => new Response('{"mode":"service"}', { status: 200 })
const gone = () => new Response('{"error":"not found"}', { status: 404 })

async function load() {
  vi.resetModules()
  return import('../src/updating')
}

/** Vite reports a failed lazy chunk as `vite:preloadError`; the dynamic import itself rejects too. */
function chunkFailed(): void {
  for (const listener of listeners['vite:preloadError'] ?? []) listener()
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  vi.useFakeTimers()
  appended = []
  listeners = {}
  sessionStore = {}
  reload.mockReset()
  fetchMock.mockReset()
  vi.stubGlobal('window', {
    fetch: fetchMock,
    addEventListener: (type: string, listener: () => void) => { (listeners[type] ??= []).push(listener) },
    removeEventListener: (type: string, listener: () => void) => { listeners[type] = (listeners[type] ?? []).filter((kept) => kept !== listener) },
    sessionStorage: {
      getItem: (key: string) => sessionStore[key] ?? null,
      setItem: (key: string, value: string) => { sessionStore[key] = String(value) },
    },
  })
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

describe('a lazy chunk a stale page asks for', () => {
  it('reloads exactly once under the updating notice when the page\'s own entry is gone', async () => {
    const { UPDATING_POLL_MS, UPDATING_PROBE_PATH, watchForUpdates } = await load()
    watchForUpdates()
    fetchMock.mockResolvedValueOnce(gone()).mockResolvedValueOnce(ok())
    chunkFailed()
    await flush()
    expect(appended).toHaveLength(1)
    expect(appended[0].innerHTML).toContain('Updating to the latest version')
    expect(typeof fetchMock.mock.calls[0][0]).toBe('string')
    expect(fetchMock.mock.calls[0][1]).toEqual({ cache: 'no-store' })

    await vi.advanceTimersByTimeAsync(UPDATING_POLL_MS)
    expect(fetchMock).toHaveBeenLastCalledWith(UPDATING_PROBE_PATH, { cache: 'no-store' })
    expect(reload).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(UPDATING_POLL_MS * 3)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('leaves the original error alone when the entry is still served or unreachable', async () => {
    const { watchForUpdates } = await load()
    watchForUpdates()
    fetchMock.mockResolvedValueOnce(ok())
    chunkFailed()
    await flush()
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    chunkFailed()
    await flush()
    expect(appended).toHaveLength(0)
    expect(reload).not.toHaveBeenCalled()
  })

  it('does not reload again for the same entry', async () => {
    const { UPDATING_POLL_MS, resetUpdating, watchForUpdates } = await load()
    watchForUpdates()
    fetchMock.mockResolvedValueOnce(gone())
    chunkFailed()
    await flush()
    expect(appended).toHaveLength(1)
    resetUpdating()
    chunkFailed()
    await flush()
    expect(appended).toHaveLength(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(UPDATING_POLL_MS * 2)
    expect(reload).not.toHaveBeenCalled()
  })
})
