import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const root = resolve('.'), directory = mkdtempSync(join(tmpdir(), 'poise-ingress-native-')), name = 'poise-ingress-proof-' + randomUUID()
function run(command, args, input) {
  const result = spawnSync(command, args, { encoding: 'utf8', input, timeout: 120_000, maxBuffer: 1024 * 1024 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr.slice(-2000)}`)
  return result
}
let started = false, db
const responses = new Set()
const upstream = createServer((_req, res) => {
  responses.add(res)
  res.once('close', () => responses.delete(res))
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  res.write('event: snippets\ndata: {"version":"fixture"}\n\n')
})
try {
  run(process.execPath, ['deploy/ingress/build.mjs'])
  run('npm', ['run', 'build', '--prefix', 'gateway'])
  await new Promise((resolve) => upstream.listen(0, '0.0.0.0', resolve))
  writeFileSync(join(directory, 'Caddyfile'), `{\n auto_https off\n admin off\n}\nhttp://alice.poise.test:8080 {\n handle /api/link/events {\n  reverse_proxy host.docker.internal:${upstream.address().port}\n }\n handle {\n  reverse_proxy 127.0.0.1:1\n }\n}\n`)
  run('docker', ['run', '--detach', '--rm', '--name', name, '--memory', '64m', '--cpus', '0.5', '--pids-limit', '64', '--publish', '127.0.0.1::8080', '--add-host', 'host.docker.internal:host-gateway', '--mount', `type=bind,src=${join(directory, 'Caddyfile')},dst=/etc/caddy/Caddyfile,readonly`, 'caddy:2.10.2-alpine'])
  started = true
  const inspect = JSON.parse(run('docker', ['inspect', name]).stdout)[0]
  const port = Number(inspect.NetworkSettings.Ports['8080/tcp'][0].HostPort)
  let status
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      status = await new Promise((resolve, reject) => {
        const req = request({ hostname: '127.0.0.1', port, path: '/private-path?token=private-query', headers: { host: 'alice.poise.test', authorization: 'Bearer private-secret' } }, (res) => { res.resume(); res.once('end', () => resolve(res.statusCode)) })
        req.on('error', reject); req.setTimeout(2000, () => req.destroy(new Error('Fixture request timed out'))); req.end()
      })
      break
    } catch (error) {
      if (attempt === 39) throw error
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  assert.equal(status, 502)
  async function stream(interruptUpstream) {
    await new Promise((resolve, reject) => {
      let data = '', interrupted = false
      const req = request({ hostname: '127.0.0.1', port, path: '/api/link/events?token=private-query', headers: { host: 'alice.poise.test', authorization: 'Bearer private-secret' } }, (res) => {
        assert.equal(res.statusCode, 200)
        assert.match(res.headers['content-type'], /text\/event-stream/)
        res.on('data', (chunk) => {
          data += chunk.toString()
          if (interrupted || !data.includes('data: {"version":"fixture"}\n\n')) return
          interrupted = true
          if (interruptUpstream) {
            assert.equal(req.destroyed, false)
            for (const response of responses) response.destroy()
          } else req.destroy()
        })
        res.once('aborted', () => {
          assert.equal(interrupted, true, 'The stream must deliver SSE data before interruption')
          assert.equal(res.complete, false)
          resolve()
        })
        res.on('error', (error) => { if (error.code !== 'ECONNRESET') reject(error) })
        res.once('end', () => reject(new Error('Interrupted stream ended as a complete response')))
      })
      req.on('error', reject); req.setTimeout(5000, () => req.destroy(new Error('SSE fixture timed out'))); req.end()
    })
  }
  async function nativeLogs(cause) {
    for (let attempt = 0; attempt < 40; attempt++) {
      const logs = run('docker', ['logs', '--timestamps', name])
      const raw = logs.stdout + logs.stderr
      if (raw.includes(cause)) return raw
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error('Caddy did not record native cause: ' + cause)
  }
  await stream(false)
  await nativeLogs('reading: context canceled')
  await stream(true)
  const raw = await nativeLogs('reading: unexpected EOF')
  assert.match(raw, /\.\d{9}Z /)
  const warnings = raw.split('\n').filter((line) => line.includes('aborting with incomplete response')).map((line) => JSON.parse(line.slice(line.indexOf(' ') + 1)))
  assert.equal(warnings.length, 2)
  for (const warning of warnings) {
    assert.equal(warning.level, 'warn')
    assert.equal(warning.logger, 'http.handlers.reverse_proxy')
    assert.equal(warning.request.method, 'GET')
    assert.equal(warning.status, undefined)
    assert.equal(warning.resp_headers, undefined)
  }
  const parser = "import importlib.util,json,sys,datetime as dt\ns=importlib.util.spec_from_file_location('reporter','/repo/deploy/ingress/reporter.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nnow=dt.datetime.now(dt.timezone.utc);result=[]\nfor line in sys.stdin.buffer.read().splitlines():\n r=m.projected(line,'poise.test',now-dt.timedelta(days=1),now+dt.timedelta(days=1))\n if r is not None: result.append(r)\nprint(json.dumps(result))"
  const projected = run('docker', ['run', '--rm', '--interactive', '--network', 'none', '--mount', `type=bind,src=${root},dst=/repo,readonly`, 'python:3.10-slim', 'python', '-c', parser], raw).stdout
  const safe = run('docker', ['run', '--rm', '--interactive', '--network', 'none', '--mount', `type=bind,src=${root}/test-results/ingress,dst=/proof,readonly`, 'node:12.22.12-alpine', 'node', '/proof/projection.cjs', 'poise.test'], projected).stdout
  const records = JSON.parse(safe)
  assert.equal(records.length, 3)
  assert.equal(records.find((record) => record.log.status === 502).log.status, 502)
  assert.equal(records.filter((record) => record.log.request.route === '/api/link/events').length, 2)
  assert.doesNotMatch(safe, /private-secret|private-query|private-path|Authorization|remote_ip|client_ip/)
  const { DiagnosticStore } = await import(pathToFileURL(join(root, 'gateway/dist/diagnostics/store.js')).href)
  const { receiveIngress } = await import(pathToFileURL(join(root, 'gateway/dist/diagnostics/ingress.js')).href)
  db = new DiagnosticStore(join(directory, 'logging.db'))
  let hello
  async function* input() { yield JSON.stringify({ version: 1, challenge: hello.challenge, expected: hello.checkpoint, container: inspect.Id, from: new Date(Math.min(...records.map((record) => Date.parse(record.time))) - 1000).toISOString(), until: new Date().toISOString(), state: 'complete', records }) }
  await receiveIngress(db, 'poise.test', input(), (line) => { hello = JSON.parse(line) })
  const page = db.query({ workspace: null, operator: true })
  assert.equal(page.total, 2)
  const refused = page.events.find((event) => event.context.status === 502)
  assert.match(refused.message, /connect|refused/i)
  assert.equal(page.events.find((event) => event.message === 'aborting with incomplete response').stderr, 'reading: unexpected EOF')
  assert.doesNotMatch(JSON.stringify(page), /reading: context canceled|private-secret|private-query|private-path/)
  assert.equal(db.query({ workspace: 'alice', operator: false }).total, 0)
  console.info('Caddy 2.10.2 refusal, client cancellation and upstream interruption → Python 3.10 → Node 12 canonical projection → compiled consumer → scoped SQLite: passed')
} finally {
  db?.close()
  upstream.closeAllConnections()
  if (upstream.listening) await new Promise((resolve) => upstream.close(resolve))
  if (started) run('docker', ['rm', '--force', name])
  rmSync(directory, { recursive: true, force: true })
}
