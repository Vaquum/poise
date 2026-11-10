import { describe, expect, it } from 'vitest'
import { parseResourceOwnership, resourceOwnershipReleased, resourceReleaseProven } from '../server/behavior-resource-receipt'

const ROOT = { path: '/isolated/call', state: 'reclaimed', device: '1', inode: '2', parent_device: '1', parent_inode: '3', reclaimed_at: 10 }
const OWNED = { version: 1, roots: [ROOT], errors: [] }
const NAMESPACE = { state: 'active', callId: 'a'.repeat(32), correlation: 'original-native',
  controller: { version: 1, instance: 'b'.repeat(32) },
  binding: { pid: 104, start: '12', namespace: 'pid:[91]', owner: { pid: 102, start: '10' }, holder: { pid: 103, start: '11' },
    epoch: { boot: 'test-epoch', init_start: '1', namespace_dev: '2', namespace_ino: '3' } } }

describe('native resource receipt boundary', () => {
  it('covers interrupted namespace/null/path errors only with complete original physical recovery', () => {
    const error = { cause: 'resources_unknown', path: null, at: 12, recovered_at: 18 }
    const value = { version: 2, roots: [ROOT], errors: [error], namespace: { ...NAMESPACE, state: 'settled', settled_at: 15 } }
    const artifact = { phase: 'resources_unknown', resource_error: 'retained original cause', resource_recovered_at: 18 }
    const proof = { resources_settled_at: new Date(20_000).toISOString(), artifact, resource_ownership: value }
    expect(resourceReleaseProven(proof, true)).toBe(true)
    expect(resourceReleaseProven({ ...proof, artifact: { ...artifact, resource_recovered_at: 17 } }, true)).toBe(false)
    expect(resourceReleaseProven({ ...proof, resource_ownership: { ...value, errors: [{ ...error, recovered_at: undefined }] } }, true)).toBe(false)
    expect(resourceReleaseProven({ ...proof, resource_ownership: { ...value, process_pending: true } }, true)).toBe(false)
    expect(resourceReleaseProven({ ...proof, resources_settled_at: new Date(17_000).toISOString() }, true)).toBe(false)
  })

  it('covers a never-allocated descendant only through an actually reclaimed original ancestor', () => {
    const child = { path: `${ROOT.path}/partial`, state: 'covered', covered_by: ROOT.path, reclaimed_at: ROOT.reclaimed_at }
    const value = { ...OWNED, version: 2, roots: [ROOT, child], namespace: { ...NAMESPACE, state: 'settled', settled_at: 15 } }
    expect(resourceOwnershipReleased(parseResourceOwnership(value))).toBe(true)
    for (const change of [{ path: `${ROOT.path}-preparation` }, { path: `${ROOT.path}/../foreign` },
      { covered_by: '/foreign' }, { inode: '9' }, { reclaimed_at: 11 }]) {
      expect(() => parseResourceOwnership({ ...value, roots: [ROOT, { ...child, ...change }] })).toThrow(/native/)
    }
    expect(() => parseResourceOwnership({ ...value, version: 1, namespace: undefined })).toThrow(/native/)
  })

  it('requires original namespace settlement independently of completed disk cleanup', () => {
    const active = { ...OWNED, version: 2, namespace: NAMESPACE }
    const evidence = { resources_settled_at: new Date(20_000).toISOString() }
    expect(resourceReleaseProven({ ...evidence, resource_ownership: active }, true)).toBe(false)
    const settled = { ...active, namespace: { ...NAMESPACE, state: 'settled', settled_at: 15 } }
    expect(resourceReleaseProven({ ...evidence, resource_ownership: settled }, true)).toBe(true)
    expect(resourceReleaseProven({ ...evidence, resources_settled_at: new Date(14_000).toISOString(), resource_ownership: settled }, true)).toBe(false)
    expect(parseResourceOwnership(OWNED)).toEqual(OWNED)
  })

  it('accepts only the original explicit never-started proof with no allocated root', () => {
    const value = { version: 2, roots: [], errors: [], namespace: { state: 'not_started', callId: NAMESPACE.callId,
      correlation: NAMESPACE.correlation, no_effect: 'original-no-go', settled_at: 15 } }
    expect(resourceOwnershipReleased(parseResourceOwnership(value))).toBe(true)
    expect(() => parseResourceOwnership({ ...value, roots: [ROOT] })).toThrow(/resource/)
    expect(() => parseResourceOwnership({ ...value, namespace: { ...value.namespace, no_effect: 'parent-gone' } })).toThrow(/resource/)
  })

  it.each([
    { state: 'settled' }, { state: 'active', settled_at: 15 }, { token: 'private' },
    { controller: { ...NAMESPACE.controller, path: '/private/control.sock' } },
    { binding: { ...NAMESPACE.binding, owner: NAMESPACE.binding.holder } },
    { binding: { ...NAMESPACE.binding, start: 12 } }, { callId: 'another-call' }, { correlation: 'bad#correlation' },
  ])('rejects contradictory or private namespace fields: %j', change => {
    expect(() => parseResourceOwnership({ ...OWNED, version: 2, namespace: { ...NAMESPACE, ...change } })).toThrow(/resource/)
  })

  it('requires positive reclamation rather than a terminal phase or release timestamp alone', () => {
    const stamp = { resources_settled_at: new Date().toISOString() }
    expect(resourceReleaseProven(stamp, true)).toBe(false)
    expect(resourceReleaseProven({ ...stamp, resource_ownership: OWNED }, true)).toBe(true)
    for (const change of [{ roots: [{ ...ROOT, state: 'allocated', reclaimed_at: undefined }] }, { process_pending: true },
      { errors: [{ cause: 'resources_unknown', path: ROOT.path, at: 1 }] }]) {
      expect(resourceReleaseProven({ ...stamp, resource_ownership: { ...OWNED, ...change } }, true)).toBe(false)
    }
  })

  it('retains the original cleanup failure and requires a covering recovery receipt', () => {
    const failed = { ...OWNED, errors: [{ cause: 'deletion denied', path: ROOT.path, at: 5 }] }
    expect(resourceOwnershipReleased(parseResourceOwnership(failed))).toBe(false)
    const recovered = { ...failed, roots: [{ ...ROOT, recovered_at: 10 }] }
    expect(resourceOwnershipReleased(parseResourceOwnership(recovered))).toBe(true)
    expect(recovered.errors).toEqual(failed.errors)
    expect(resourceOwnershipReleased(parseResourceOwnership({ ...recovered, errors: [{ ...failed.errors[0], at: 11 }] }))).toBe(false)
  })

  it('preserves full-width kernel inode identities without JavaScript numeric rounding', () => {
    const value = { ...OWNED, roots: [{ ...ROOT, inode: '18446744073709551615' }] }
    expect(parseResourceOwnership(value).roots[0].inode).toBe('18446744073709551615')
  })

  it('retains a bounded receipt size after allowing large ancestor recovery inventories', () => {
    const roots = Array.from({ length: 900 }, (_, index) => ({ ...ROOT, path: `/isolated/${index}/${'x'.repeat(500)}` }))
    expect(Buffer.byteLength(JSON.stringify({ ...OWNED, roots }))).toBeGreaterThan(512 * 1024)
    expect(() => parseResourceOwnership({ ...OWNED, roots })).toThrow('invalid native resource ownership')
  })

  it.each([{ roots: [ROOT, ROOT] }, { roots: [{ ...ROOT, inode: -1 }] },
    { roots: [{ ...ROOT, reclaimed_at: null }] }, { roots: [{ ...ROOT, recovered_at: 11 }] },
    { errors: [{ cause: 'denied', path: '/foreign', at: 1 }] }, { process_pending: 'false' }, { recovered: true }])(
    'rejects malformed or unbound proof: %j', change => {
      expect(() => parseResourceOwnership({ ...OWNED, ...change })).toThrow(/resource/)
    })
})
