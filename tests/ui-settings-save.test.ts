import { describe, expect, it } from 'vitest'
import { createSaveQueue, field, leaf, type Answer, type Payload } from '../src/ui/places/settings/save'

/** A server stand-in: each request waits until the test answers it. */
function server(start: Record<string, unknown>) {
  let settings = structuredClone(start)
  const sent: Payload[] = []
  const waiting: Array<(answer?: Answer) => void> = []
  const apply = (payload: Payload): Answer => {
    for (const [name, expected] of Object.entries(payload.expect)) {
      if (JSON.stringify(settings[name]) !== JSON.stringify(expected)) return { status: 409, data: { error: 'changed', current: { [name]: settings[name] } } }
    }
    for (const [name, value] of Object.entries(payload.body)) {
      settings[name] = value && typeof value === 'object' && !Array.isArray(value) ? { ...(settings[name] as object), ...value } : value
    }
    return { status: 200, data: structuredClone(settings) }
  }
  return {
    sent,
    set: (name: string, value: unknown) => { settings = { ...settings, [name]: value } },
    post: (payload: Payload) => new Promise<Answer>((resolve) => { sent.push(payload); waiting.push((answer) => resolve(answer ?? apply(payload))) }),
    /** Answers the oldest waiting request, as the server would or as given. */
    answer: async (answer?: Answer) => { waiting.shift()!(answer); await new Promise((r) => setTimeout(r, 0)) },
    pending: () => waiting.length,
  }
}
const tick = () => new Promise((r) => setTimeout(r, 0))

describe('Settings saves one row at a time, with what this tab read', () => {
  it('sends only the row’s own field, with the field as this tab knows it', async () => {
    const s = server({ timezone: 'UTC', chat: { branchPrefix: 'chat/', idleTimeoutMinutes: 120 } })
    const queue = createSaveQueue(s.post)
    queue.setKnown({ timezone: 'UTC', chat: { branchPrefix: 'chat/', idleTimeoutMinutes: 120 } })
    const saved = queue.send('idle', leaf('chat', 'idleTimeoutMinutes', 30))
    await tick()
    expect(s.sent[0]).toEqual({ body: { chat: { idleTimeoutMinutes: 30 } }, expect: { chat: { branchPrefix: 'chat/', idleTimeoutMinutes: 120 } } })
    await s.answer()
    expect((await saved).kind).toBe('saved')
    expect(queue.known().chat).toEqual({ branchPrefix: 'chat/', idleTimeoutMinutes: 30 })
  })

  it('sends edits in order, each built from the answer before it, so two rows of one field never refuse each other', async () => {
    const s = server({ chat: { branchPrefix: 'chat/', idleTimeoutMinutes: 120 } })
    const queue = createSaveQueue(s.post)
    queue.setKnown({ chat: { branchPrefix: 'chat/', idleTimeoutMinutes: 120 } })
    const first = queue.send('branch', leaf('chat', 'branchPrefix', 'work/'))
    const second = queue.send('idle', leaf('chat', 'idleTimeoutMinutes', 30))
    await tick()
    expect(s.pending()).toBe(1)
    await s.answer()
    expect(s.sent[1].expect).toEqual({ chat: { branchPrefix: 'work/', idleTimeoutMinutes: 120 } })
    await s.answer()
    expect([(await first).kind, (await second).kind]).toEqual(['saved', 'saved'])
  })

  it('lets only a row’s newest edit decide what the row says', async () => {
    const s = server({ timezone: 'UTC' })
    const queue = createSaveQueue(s.post)
    queue.setKnown({ timezone: 'UTC' })
    const a = queue.send('timezone', field('timezone', 'Europe/London'))
    const b = queue.send('timezone', field('timezone', 'Europe/Berlin'))
    const c = queue.send('timezone', field('timezone', 'Europe/Helsinki'))
    // The first is on its way; the second waited, so the third takes its place.
    expect((await b).kind).toBe('superseded')
    await s.answer()
    expect((await a).kind).toBe('superseded')
    await s.answer()
    expect((await c).kind).toBe('saved')
    expect(s.sent.map((p) => p.body.timezone)).toEqual(['Europe/London', 'Europe/Helsinki'])
    expect(queue.known().timezone).toBe('Europe/Helsinki')
  })

  it('keeps a refused save’s draft when another tab changed the row’s own value', async () => {
    const s = server({ timezone: 'UTC' })
    const queue = createSaveQueue(s.post)
    queue.setKnown({ timezone: 'UTC' })
    s.set('timezone', 'Asia/Tokyo')
    const saved = queue.send('timezone', field('timezone', 'Europe/Berlin'))
    await s.answer()
    expect(await saved).toEqual({ kind: 'conflict', current: { timezone: 'Asia/Tokyo' } })
    expect(queue.known().timezone).toBe('Asia/Tokyo')
    // Saving again now overwrites deliberately: the tab knows what it replaces.
    const again = queue.send('timezone', field('timezone', 'Europe/Berlin'))
    await s.answer()
    expect((await again).kind).toBe('saved')
  })

  it('sends again, keeping the other change, when another tab changed only another part of the field', async () => {
    const s = server({ chat: { branchPrefix: 'chat/', idleTimeoutMinutes: 120 } })
    const queue = createSaveQueue(s.post)
    queue.setKnown({ chat: { branchPrefix: 'chat/', idleTimeoutMinutes: 120 } })
    s.set('chat', { branchPrefix: 'theirs/', idleTimeoutMinutes: 120 })
    const saved = queue.send('idle', leaf('chat', 'idleTimeoutMinutes', 30))
    await s.answer()
    await s.answer()
    expect((await saved).kind).toBe('saved')
    expect(queue.known().chat).toEqual({ branchPrefix: 'theirs/', idleTimeoutMinutes: 30 })
  })

  it('says why a save failed, in the server’s words', async () => {
    const s = server({ me: 'octocat' })
    const queue = createSaveQueue(s.post)
    queue.setKnown({ me: 'octocat' })
    const saved = queue.send('me', field('me', 'a--b'))
    await s.answer({ status: 400, data: { error: 'me must be a GitHub name: letters, digits and single hyphens' } })
    expect(await saved).toEqual({ kind: 'failed', message: 'me must be a GitHub name: letters, digits and single hyphens' })
    expect(queue.busy()).toBe(false)
  })
})
