import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
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
try {
  run(process.execPath, ['deploy/ingress/build.mjs'])
  run('npm', ['run', 'build', '--prefix', 'gateway'])
  writeFileSync(join(directory, 'Caddyfile'), '{\n auto_https off\n admin off\n}\nhttp://alice.poise.test:8080 {\n reverse_proxy 127.0.0.1:1\n}\n')
  run('docker', ['run', '--detach', '--rm', '--name', name, '--memory', '64m', '--cpus', '0.5', '--pids-limit', '64', '--publish', '127.0.0.1::8080', '--mount', `type=bind,src=${join(directory, 'Caddyfile')},dst=/etc/caddy/Caddyfile,readonly`, 'caddy:2.10.2-alpine'])
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
  const logs = run('docker', ['logs', '--timestamps', name])
  const raw = logs.stdout + logs.stderr
  assert.match(raw, /\.\d{9}Z /)
  const parser = "import importlib.util,json,sys,datetime as dt\ns=importlib.util.spec_from_file_location('reporter','/repo/deploy/ingress/reporter.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nnow=dt.datetime.now(dt.timezone.utc);result=[]\nfor line in sys.stdin.buffer.read().splitlines():\n r=m.projected(line,'poise.test',now-dt.timedelta(days=1),now+dt.timedelta(days=1))\n if r is not None: result.append(r)\nprint(json.dumps(result))"
  const projected = run('docker', ['run', '--rm', '--interactive', '--network', 'none', '--mount', `type=bind,src=${root},dst=/repo,readonly`, 'python:3.10-slim', 'python', '-c', parser], raw).stdout
  const safe = run('docker', ['run', '--rm', '--interactive', '--network', 'none', '--mount', `type=bind,src=${root}/test-results/ingress,dst=/proof,readonly`, 'node:12.22.12-alpine', 'node', '/proof/projection.cjs', 'poise.test'], projected).stdout
  const records = JSON.parse(safe)
  assert.equal(records.length, 1)
  assert.equal(records[0].log.status, 502)
  assert.doesNotMatch(safe, /private-secret|private-query|private-path|Authorization|remote_ip|client_ip/)
  const { DiagnosticStore } = await import(pathToFileURL(join(root, 'gateway/dist/diagnostics/store.js')).href)
  const { receiveIngress } = await import(pathToFileURL(join(root, 'gateway/dist/diagnostics/ingress.js')).href)
  db = new DiagnosticStore(join(directory, 'logging.db'))
  let hello
  async function* input() { yield JSON.stringify({ version: 1, challenge: hello.challenge, expected: hello.checkpoint, container: inspect.Id, from: new Date(Math.min(...records.map((record) => Date.parse(record.time))) - 1000).toISOString(), until: new Date().toISOString(), state: 'complete', records }) }
  await receiveIngress(db, 'poise.test', input(), (line) => { hello = JSON.parse(line) })
  const page = db.query({ workspace: null, operator: true })
  assert.equal(page.total, 1)
  assert.equal(page.events[0].context.status, 502)
  assert.match(page.events[0].message, /connect|refused/i)
  assert.equal(db.query({ workspace: 'alice', operator: false }).total, 0)
  console.info('Caddy 2.10.2 → Python 3.10 → Node 12 canonical projection → compiled consumer → scoped SQLite: passed')
} finally {
  db?.close()
  if (started) run('docker', ['rm', '--force', name])
  rmSync(directory, { recursive: true, force: true })
}
