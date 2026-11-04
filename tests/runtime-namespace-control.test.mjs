import { mkdtemp, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'
import { namespaceControl } from '../deploy/runtime/supervisor.mjs'

// Transport/lifetime contract checks use an explicit kernel-reader stand-in.
// Actual Linux namespace proof is a separate runtime check.
const controls = []
afterEach(async () => { for (const control of controls.splice(0)) await control.close() })

const binding = { pid: 5, start: '10', namespace: 'pid:[9]',
  epoch: { boot: 'fixture', init_start: '1', namespace_dev: '4', namespace_ino: '5' },
  owner: { pid: 3, start: '8' }, holder: { pid: 4, start: '9' } }
const scope = { callId: 'a'.repeat(32), correlation: 'original-invocation', token: 'b'.repeat(32) }

async function fixture(limit = 4096) {
  const state = { pids: [1, 2], error: null, ownerPresent: true }
  const close = vi.fn()
  const open = vi.fn(identity => ({ binding: identity, close, ownerPresent: () => state.ownerPresent, read() {
    if (state.error) throw new Error(state.error)
    return { namespace: identity.namespace, pids: state.pids, empty: state.pids.length === 0 }
  } }))
  const control = await namespaceControl({ open, limit })
  controls.push(control)
  return { control, state, close, open }
}

function raw(address, text) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(address.path)
    let response = ''
    socket.setTimeout(1000, () => socket.destroy(new Error('test control response expired')))
    socket.on('error', reject)
    socket.on('connect', () => socket.write(text))
    socket.on('data', bytes => { response += bytes.toString() })
    socket.on('end', () => {
      try { resolve(JSON.parse(response)) }
      catch (error) { reject(error) }
    })
  })
}
const request = (control, operation, extra = {}) => raw(control.address,
  `${JSON.stringify({ ...control.address, ...scope, operation, ...extra })}\n`)

it('exposes only a private local socket and one controller generation', async () => {
  const { control, open } = await fixture()
  expect((await stat(control.address.path)).mode & 0o777).toBe(0o600)
  expect((await request(control, 'hello'))).toEqual({ version: 1, instance: control.address.instance, available: true, resourceProtocol: 2, persistentCleanup: 1, witnesses: 0, probeAvailable: true })
  expect(open).not.toHaveBeenCalled()
})

it('keeps the v1 controller available when metadata cannot be pinned and reports v2 unsupported', async () => {
  const root = await mkdtemp(join(tmpdir(), 'poise-native-unsupported-store-'))
  try {
    await symlink(root, join(root, 'data'))
    const control = await namespaceControl({ dataDirectory: join(root, 'data') })
    controls.push(control)
    expect(control.address.store).toBeUndefined()
    expect(await request(control, 'hello')).toMatchObject({ available: true, storeError: expect.stringContaining('metadata handles are unavailable') })
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('keeps original evidence across clients and idempotent registration without reopening the kernel handle', async () => {
  const { control, open, state } = await fixture()
  const registered = await request(control, 'register', { identity: binding })
  expect(registered).toMatchObject({ callId: scope.callId, correlation: scope.correlation, binding, pids: [1, 2], empty: false })
  const reordered = Object.fromEntries(Object.entries(binding).reverse())
  expect(await request(control, 'register', { identity: reordered })).toEqual(registered)
  state.pids = [2]
  expect(await request(control, 'read')).toMatchObject({ pids: [2], empty: false })
  expect(open).toHaveBeenCalledExactlyOnceWith(binding)
  expect(await request(control, 'hello')).toMatchObject({ witnesses: 1 })
})

it('bounds setup probes and retires only a positively empty abandoned probe on an existing read', async () => {
  const { control, state, close, open } = await fixture()
  await request(control, 'register', { identity: binding, probe: true })
  const another = { callId: 'c'.repeat(32), correlation: 'another-probe', token: 'd'.repeat(32) }
  expect(await request(control, 'register', { ...another, identity: binding, probe: true })).toMatchObject({ error: expect.stringContaining('still unsettled') })
  state.ownerPresent = false
  expect(await request(control, 'hello')).toMatchObject({ probeAvailable: false, witnesses: 1 })
  expect(close).not.toHaveBeenCalled()
  state.pids = []
  state.ownerPresent = true
  expect(await request(control, 'hello')).toMatchObject({ probeAvailable: false, witnesses: 1 })
  state.ownerPresent = false
  expect(await request(control, 'hello')).toMatchObject({ probeAvailable: true, witnesses: 0 })
  expect(close).toHaveBeenCalledTimes(1)
  expect(open).toHaveBeenCalledTimes(1)
})

it.each(['read', 'release', 'register'])('rejects another invocation token for %s without affecting the original', async operation => {
  const { control, close, open } = await fixture()
  await request(control, 'register', { identity: binding })
  expect(await request(control, operation, { token: 'c'.repeat(32), identity: binding })).toMatchObject({ error: 'Native scope belongs to another invocation' })
  expect(await request(control, 'read')).toMatchObject({ pids: [1, 2], empty: false })
  expect(close).not.toHaveBeenCalled()
  expect(open).toHaveBeenCalledTimes(1)
})

it('refuses a conflicting original correlation or kernel binding', async () => {
  const { control, open } = await fixture()
  await request(control, 'register', { identity: binding })
  expect(await request(control, 'read', { correlation: 'another-invocation' })).toHaveProperty('error')
  expect(await request(control, 'register', { identity: { ...binding, start: '11' } })).toMatchObject({ error: 'Native scope kernel binding differs' })
  expect(open).toHaveBeenCalledTimes(1)
})

it('requires positive emptiness before retiring only the original handle', async () => {
  const { control, state, close } = await fixture()
  await request(control, 'register', { identity: binding })
  expect(await request(control, 'release')).toMatchObject({ error: 'Native namespace still owns processes' })
  expect(close).not.toHaveBeenCalled()
  state.pids = []
  expect(await request(control, 'read')).toMatchObject({ empty: true, pids: [] })
  expect(await request(control, 'release')).toMatchObject({ released: true })
  expect(close).toHaveBeenCalledTimes(1)
  expect(await request(control, 'read')).toMatchObject({ error: 'Original native namespace witness is unavailable' })
  expect(await request(control, 'release')).toHaveProperty('error')
})

it('never substitutes emptiness when the kernel reader fails', async () => {
  const { control, state, close } = await fixture()
  await request(control, 'register', { identity: binding })
  state.error = 'kernel view unavailable'
  for (const operation of ['read', 'release']) {
    const result = await request(control, operation)
    expect(result).toMatchObject({ error: state.error })
    expect(result).not.toHaveProperty('empty')
  }
  expect(close).not.toHaveBeenCalled()
})

it('bounds retained handles and reuses capacity only after verified retirement', async () => {
  const { control, state, open } = await fixture(1)
  await request(control, 'register', { identity: binding })
  const other = { callId: 'c'.repeat(32), token: 'd'.repeat(32), correlation: 'second-invocation', identity: binding }
  expect(await request(control, 'register', other)).toMatchObject({ error: 'Native namespace witnesses are at capacity' })
  expect(open).toHaveBeenCalledTimes(1)
  state.pids = []
  await request(control, 'release')
  expect(await request(control, 'register', other)).toMatchObject({ callId: other.callId, empty: true })
  expect(open).toHaveBeenCalledTimes(2)
})

it.each([
  { instance: 'replaced-controller' }, { version: 2 }, { token: '' }, { callId: '../foreign' },
  { correlation: '' }, { operation: 'signal' },
])('refuses invalid or unsupported requests: %j', async extra => {
  const { control, open } = await fixture()
  const result = await request(control, 'register', { identity: binding, ...extra })
  expect(result).toHaveProperty('error')
  expect(result).not.toHaveProperty('empty')
  expect(open).not.toHaveBeenCalled()
})

it('rejects malformed, oversized and batched input without recording a scope', async () => {
  const { control, open } = await fixture()
  for (const text of ['{broken\n', `${'x'.repeat(16 * 1024 + 1)}\n`, '{}\n{}\n']) {
    expect(await raw(control.address, text)).toHaveProperty('error')
  }
  expect(open).not.toHaveBeenCalled()
})

it('closes every retained handle on supervisor shutdown without claiming settlement', async () => {
  const { control, close } = await fixture()
  await request(control, 'register', { identity: binding })
  await control.close()
  expect(close).toHaveBeenCalledTimes(1)
  await expect(request(control, 'read')).rejects.toThrow()
})
