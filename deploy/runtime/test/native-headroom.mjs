// Outside the guest: runsc need not expose cgroup counters inside its procfs.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { get } from 'node:http'

const endpoint = process.env.DOCKER_HOST || execFileSync('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], { encoding: 'utf8' }).trim()
assert.ok(endpoint.startsWith('unix://'), 'native component headroom needs its local Docker socket')
const memory = await new Promise((resolve, reject) => {
  const request = get({ socketPath: endpoint.slice(7), path: `/containers/${encodeURIComponent(process.argv[2])}/stats?stream=false&one-shot=true`, timeout: 5000 }, response => {
    let text = ''
    response.setEncoding('utf8')
    response.on('data', chunk => { text += chunk; if (text.length > 1024 * 1024) request.destroy(new Error('Docker stats exceeded its bound')) })
    response.on('end', () => {
      try { assert.equal(response.statusCode, 200); resolve(JSON.parse(text).memory_stats) }
      catch (error) { reject(error) }
    })
  })
  request.on('error', reject)
  request.on('timeout', () => request.destroy(new Error('Docker stats deadline exceeded')))
})
assert.equal(memory.limit, 2 * 1024 ** 3)
assert.ok(Number.isSafeInteger(memory.usage) && memory.usage > 0)
let freeBytes = memory.limit - memory.usage
try {
  const max = readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim()
  if (max !== 'max') freeBytes = Math.min(freeBytes, Number(max) - Number(readFileSync('/sys/fs/cgroup/memory.current', 'utf8').trim()))
} catch (error) { if (error.code !== 'ENOENT') throw error }
assert.ok(Number.isSafeInteger(freeBytes) && freeBytes >= 1024 ** 3, 'component lacks its frozen 1-GiB headroom')
console.log(JSON.stringify({ freeBytes, measuredAt: Date.now(), source: 'outside-guest-Docker-memory-stats' }))
