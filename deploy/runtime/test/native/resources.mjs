// Real Linux descriptors/filesystem only; no provider or workflow execution.
import assert from 'node:assert/strict'
import { chmodSync, fstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, rmdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { callerStore, resourceWitnesses } from '/opt/poise-runtime/resource-witness.mjs'

const work = mkdtempSync('/home/poise/native-resource-witness-')
const call = 'a'.repeat(32)
const registries = []
const stores = []
const registry = () => { const value = resourceWitnesses(call); registries.push(value); return value }
try {
  const literal = registry()
  mkdirSync(`${work}/literal`)
  const literalRoot = `${work}/literal/native-resources/${call}`
  literal.allocate(literalRoot)
  const oldCwd = process.cwd()
  renameSync(literalRoot, `${literalRoot} (deleted)`)
  assert.equal(literal.read(literalRoot).unlinked, false)
  assert.throws(() => literal.finish(literalRoot), /still linked/)
  assert.equal(process.cwd(), oldCwd)
  rmdirSync(`${literalRoot} (deleted)`)
  assert.equal(literal.read(literalRoot).unlinked, true)
  assert.equal(literal.finish(literalRoot).state, 'reclaimed')
  assert.equal(process.cwd(), oldCwd)
  const first = registry()
  const root = `${work}/native-resources/${call}`
  const original = first.allocate(root)
  assert.equal(original.state, 'allocated')
  assert.deepEqual(first.allocate(root), original)
  assert.throws(() => first.finish(root), /still linked/)
  writeFileSync(`${root}/output`, 'owned disposable content')
  rmSync(root, { recursive: true })
  assert.equal(first.read(root).unlinked, true)
  const reclaimed = first.finish(root)
  assert.equal(reclaimed.state, 'reclaimed')
  assert.ok(reclaimed.reclaimed_at)
  assert.throws(() => fstatSync(original.anchor.rootFd), { code: 'EBADF' })
  assert.deepEqual(first.finish(root), reclaimed)
  assert.deepEqual(first.read(root), reclaimed)
  assert.throws(() => first.allocate(root), /already reclaimed/)

  const nested = registry()
  mkdirSync(`${work}/nested`, { mode: 0o700 })
  const parent = `${work}/nested/native-resources/${call}`
  nested.allocate(parent)
  nested.allocate(`${parent}/provider`)
  rmSync(parent, { recursive: true })
  assert.throws(() => nested.finish(parent), /child handles/)
  nested.finish(`${parent}/provider`)
  nested.finish(parent)
  assert.equal(nested.released(), true)

  const replaced = registry()
  mkdirSync(`${work}/ancestor`, { mode: 0o700 })
  const path = `${work}/ancestor/native-resources/${call}`
  const pinned = replaced.allocate(path)
  const foreign = `${work}/foreign`
  mkdirSync(`${foreign}/${call}`, { recursive: true })
  writeFileSync(`${foreign}/${call}/user-auth-evidence`, 'protected')
  renameSync(`${work}/ancestor/native-resources`, `${work}/original-base`)
  symlinkSync(foreign, `${work}/ancestor/native-resources`)
  rmdirSync(`/proc/self/fd/${pinned.anchor.parentFd}/${call}`)
  replaced.finish(path)
  assert.equal(readFileSync(`${foreign}/${call}/user-auth-evidence`, 'utf8'), 'protected')
  const legacyStore = callerStore(`${work}/legacy-caller`)
  stores.push(legacyStore)
  const legacyBase = `${legacyStore.reference.path}/native-resources`
  mkdirSync(legacyBase, { mode: 0o755 })
  chmodSync(legacyBase, 0o755)
  writeFileSync(`${legacyBase}/retained-legacy-evidence`, 'protected older evidence')
  const legacy = resourceWitnesses(call, legacyStore.reference)
  registries.push(legacy)
  const legacyRoot = `${legacyBase}/${call}`
  legacy.allocate(legacyRoot)
  assert.equal(statSync(legacyBase).mode & 0o777, 0o700)
  assert.equal(readFileSync(`${legacyBase}/retained-legacy-evidence`, 'utf8'), 'protected older evidence')
  rmdirSync(legacyRoot)
  legacy.finish(legacyRoot)

  const unregistered = registry()
  mkdirSync(`${work}/unregistered/native-resources/${call}`, { recursive: true, mode: 0o700 })
  writeFileSync(`${work}/unregistered/native-resources/${call}/user-data`, 'keep')
  assert.throws(() => unregistered.allocate(`${work}/unregistered/native-resources/${call}`), { code: 'EEXIST' })
  assert.throws(() => unregistered.allocate(`${work}/unregistered/native-resources/${'b'.repeat(32)}`), /another Call/)
  assert.equal(readFileSync(`${work}/unregistered/native-resources/${call}/user-data`, 'utf8'), 'keep')
  const store = callerStore(`${work}/caller`)
  stores.push(store)
  writeFileSync(`${work}/caller/calls.sqlite3`, 'original database descriptor fixture')
  renameSync(`${work}/caller`, `${work}/retained-caller`)
  mkdirSync(`${work}/caller`)
  writeFileSync(`${work}/caller/calls.sqlite3`, 'foreign database sentinel')
  assert.equal(readFileSync(`/proc/self/fd/${store.reference.directoryFd}/calls.sqlite3`, 'utf8'), 'original database descriptor fixture')
  assert.equal(readFileSync(`${work}/caller/calls.sqlite3`, 'utf8'), 'foreign database sentinel')
  const bound = resourceWitnesses(call, store.reference)
  registries.push(bound)
  assert.throws(() => bound.allocate(`${work}/foreign/native-resources/${call}`), /original Caller metadata/)
  symlinkSync(`${work}/foreign`, `/proc/self/fd/${store.reference.directoryFd}/native-resources`)
  assert.throws(() => bound.allocate(`${store.reference.path}/native-resources/${call}`))
  assert.equal(readFileSync(`${foreign}/${call}/user-auth-evidence`, 'utf8'), 'protected')
  console.log(JSON.stringify({ kind: 'native-resource-handles', original_unlink_proven: true,
    repeated_finish_stable: true, foreign_unchanged: true, provider_or_workflow_acceptance: false }))
} finally {
  for (const value of registries) value.close()
  for (const value of stores) value.close()
  rmSync(work, { recursive: true, force: true })
}
