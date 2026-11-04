// Original directory handles outlive Caller and cleanup workers. This is
// physical evidence only; it neither schedules work nor deletes a pathname.
import { closeSync, constants, fchmodSync, fstatSync, mkdirSync, openSync, readdirSync, readlinkSync, realpathSync } from 'node:fs'
import { dirname, normalize } from 'node:path'

function directoryUnlinked(fd) {
  if (fstatSync(fd).nlink === 0) return true
  const held = `/proc/self/fd/${fd}`
  // runsc's persistent-home backend retains nlink=1 after rmdir. The suffix
  // is only a hint: a live directory can literally be named " (deleted)".
  if (!readlinkSync(held).endsWith(' (deleted)')) return false
  if (readdirSync(held).length) return false
  const original = openSync('.', constants.O_RDONLY | constants.O_DIRECTORY)
  let unlinked = false
  try {
    // This synchronous control operation runs on the supervisor's main thread
    // and restores its pinned cwd before any other request can execute.
    process.chdir(held)
    try { process.cwd() }
    catch (error) { if (error.code !== 'ENOENT') throw error; unlinked = true }
  } finally {
    try { process.chdir(`/proc/self/fd/${original}`) }
    finally { closeSync(original) }
  }
  return unlinked
}

/** Keep Caller's metadata on the original directory, including after rename.
 * The descriptor is private process configuration, never journal authority. */
export function callerStore(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || normalize(path) !== path) throw new Error('Invalid Caller data directory')
  mkdirSync(path, { recursive: true, mode: 0o700 })
  const directory = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  const descriptors = [directory]
  const identity = (fd, isDirectory) => {
    const node = fstatSync(fd, { bigint: true })
    if ((isDirectory ? !node.isDirectory() : !node.isFile()) || node.uid !== BigInt(process.getuid())) {
      throw new Error('Caller metadata is not owned by the workspace')
    }
    return { device: String(node.dev), inode: String(node.ino) }
  }
  try {
    const original = identity(directory, true)
    const database = openSync(`/proc/self/fd/${directory}/calls.sqlite3`, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
    descriptors.push(database)
    const db = identity(database, false)
    try { mkdirSync(`/proc/self/fd/${directory}/responses`, { mode: 0o700 }) }
    catch (error) { if (error.code !== 'EEXIST') throw error }
    const responses = openSync(`/proc/self/fd/${directory}/responses`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    descriptors.push(responses)
    const response = identity(responses, true)
    const reference = Object.freeze({ path, pid: process.pid, directoryFd: directory, responsesFd: responses,
      directory: original, database: db, responses: response })
    return { reference, read() {
      for (const [fd, expected, isDirectory] of [[directory, original, true], [database, db, false], [responses, response, true]]) {
        const current = identity(fd, isDirectory)
        if (current.device !== expected.device || current.inode !== expected.inode) throw new Error('Original Caller metadata handle changed')
      }
      return reference
    }, close() {
      const failures = []
      for (const fd of descriptors.splice(0).reverse()) {
        try { closeSync(fd) }
        catch (error) { failures.push(error) }
      }
      if (failures.length) throw new AggregateError(failures, 'Caller metadata handle shutdown failed')
    } }
  } catch (error) {
    const failures = [error]
    for (const fd of descriptors.reverse()) {
      try { closeSync(fd) }
      catch (failure) { failures.push(failure) }
    }
    throw failures.length === 1 ? error : new AggregateError(failures, 'Caller metadata setup failed')
  }
}

export function resourceWitnesses(callId, metadata) {
  if (!/^[0-9a-f]{32}$/.test(callId)) throw new Error('Invalid native resource Call')
  const roots = new Map()
  let base = null
  let closed = false
  let closeFailure = null
  const directory = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  const at = (fd, name) => `/proc/self/fd/${fd}/${name}`
  const identity = (fd) => {
    const node = fstatSync(fd, { bigint: true })
    return { device: String(node.dev), inode: String(node.ino) }
  }
  const nameOf = (path) => {
    if (closed || typeof path !== 'string' || path.length > 4096 || !path.startsWith('/') || normalize(path) !== path) {
      throw new Error('Invalid native resource path')
    }
    const marker = '/native-resources/'
    const index = path.lastIndexOf(marker)
    const relative = index < 0 ? '' : path.slice(index + marker.length)
    const names = relative.split('/')
    if (![callId, `${callId}-preparation`].includes(names[0])
        || names.some(name => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(name) || name === '.' || name === '..')) {
      throw new Error('Native resource path belongs to another Call')
    }
    const parent = path.slice(0, index + marker.length - 1)
    if (metadata && parent !== `${metadata.path}/native-resources`) throw new Error('Native resource base differs from its original Caller metadata')
    if (base && base.path !== parent) throw new Error('Native resource base differs from its original allocation')
    return { parent, relative, names }
  }
  const proof = (entry) => ({ path: entry.path, state: entry.fd === null ? 'reclaimed' : 'allocated', ...entry.identity,
    parent_device: entry.parentIdentity.device, parent_inode: entry.parentIdentity.inode,
    ...(entry.fd === null ? { reclaimed_at: entry.reclaimedAt } : {
      unlinked: directoryUnlinked(entry.fd),
      anchor: { pid: process.pid, parentFd: entry.parentFd, rootFd: entry.fd },
    }),
  })
  return {
    allocate(path) {
      const { parent, names } = nameOf(path)
      const prior = roots.get(path)
      if (prior) {
        if (prior.fd === null) throw new Error('Native resource was already reclaimed')
        return proof(prior)
      }
      if (roots.size >= 128) throw new Error('Native resource handles are at capacity')
      if (!base) {
        if (!metadata && realpathSync(dirname(parent)) !== dirname(parent)) throw new Error('Native resource base is not canonical')
        const original = metadata ? at(metadata.directoryFd, 'native-resources') : parent
        try { mkdirSync(original, { mode: 0o700 }) }
        catch (error) { if (error.code !== 'EEXIST') throw error }
        const fd = openSync(original, directory)
        try {
          const node = fstatSync(fd)
          if (!node.isDirectory() || node.uid !== process.getuid()) throw new Error('Native resource base is not owned')
          // Earlier Caller releases created this managed parent as 0755.
          // Repair the pinned original, never a mutable ancestor pathname.
          if (node.mode & 0o077) fchmodSync(fd, 0o700)
          base = { path: parent, fd }
        } catch (error) { closeSync(fd); throw error }
      }
      const ancestor = names.length === 1 ? base : roots.get(dirname(path))
      if (!ancestor || ancestor.fd === null) throw new Error('Native resource parent lacks its original handle')
      const name = names.at(-1)
      mkdirSync(at(ancestor.fd, name), { mode: 0o700 })
      const fd = openSync(at(ancestor.fd, name), directory)
      try {
        const entry = { path, fd, parentFd: ancestor.fd, identity: identity(fd), parentIdentity: identity(ancestor.fd) }
        roots.set(path, entry)
        return proof(entry)
      } catch (error) {
        if (!roots.has(path)) closeSync(fd)
        throw error
      }
    },
    read(path) {
      nameOf(path)
      const entry = roots.get(path)
      if (!entry) throw new Error('Original native resource handle is unavailable')
      return proof(entry)
    },
    repair(path) {
      nameOf(path)
      const entry = roots.get(path)
      if (!entry) throw new Error('Original native resource handle is unavailable')
      if (entry.fd !== null) {
        for (const fd of [entry.parentFd, entry.fd]) {
          const node = fstatSync(fd)
          if (!node.isDirectory() || node.uid !== process.getuid()) throw new Error('Native resource permission owner changed')
          fchmodSync(fd, (node.mode & 0o7777) | 0o700)
        }
      }
      return proof(entry)
    },
    finish(path) {
      nameOf(path)
      const entry = roots.get(path)
      if (!entry) throw new Error('Original native resource handle is unavailable')
      if (entry.fd !== null) {
        if ([...roots.values()].some(child => child.path.startsWith(`${path}/`) && child.fd !== null)) {
          throw new Error('Native resource still owns child handles')
        }
        if (!directoryUnlinked(entry.fd)) throw new Error('Original native resource is still linked')
        const fd = entry.fd
        entry.fd = null
        closeSync(fd)
        entry.reclaimedAt = Date.now() / 1000
      }
      if (!entry.reclaimedAt) throw new Error('Native resource handle close was not confirmed')
      return proof(entry)
    },
    released() { return [...roots.values()].every(entry => entry.fd === null && entry.reclaimedAt) },
    close() {
      if (closed) {
        if (closeFailure) throw closeFailure
        return
      }
      closed = true
      const failures = []
      for (const entry of roots.values()) {
        if (entry.fd === null) continue
        const fd = entry.fd
        entry.fd = null
        try { closeSync(fd) }
        catch (error) { failures.push(error) }
      }
      if (base) {
        const fd = base.fd
        base = null
        try { closeSync(fd) }
        catch (error) { failures.push(error) }
      }
      if (failures.length) {
        closeFailure = new AggregateError(failures, 'Native resource handle shutdown failed')
        throw closeFailure
      }
    },
  }
}
