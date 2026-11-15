// Credential-sensitive Codex stand-in. All state lives under the test HOME.
import fs from 'node:fs'
import path from 'node:path'
const args = process.argv.slice(2)
const canonical = path.join(process.env.HOME, '.codex')
const home = process.env.CODEX_HOME || canonical
const control = JSON.parse(fs.readFileSync(path.join(process.env.HOME, 'codex-control.json'), 'utf8'))
const auth = path.join(home, 'auth.json')
const credential = '{"fixture":"private-canary"}'
const event = value => process.stdout.write(JSON.stringify(value) + '\n')

if (args[0] === '--version') {
  process.stdout.write('codex-cli 0.169.0\n')
} else if (args.join(' ') === 'login --device-auth') {
  fs.mkdirSync(canonical, { recursive: true })
  if (control.mode === 'store') fs.writeFileSync(path.join(canonical, 'credential-store'), credential)
  else fs.writeFileSync(path.join(canonical, 'auth.json'), credential, { mode: 0o600 })
} else if (args.join(' ') === 'login status') {
  process.stderr.write('Logged in using ChatGPT\n')
} else if (args[0] === 'exec') {
  const usable = fs.existsSync(auth) || fs.existsSync(path.join(home, 'credential-store'))
  fs.appendFileSync(path.join(process.env.HOME, 'codex-requests.jsonl'), JSON.stringify({
    args, home, usable,
    mode: fs.statSync(home).mode & 0o777,
    authMode: fs.existsSync(auth) ? fs.statSync(auth).mode & 0o777 : null,
    overrides: ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL'].filter(key => process.env[key]),
    importedConfig: fs.existsSync(path.join(home, 'config.toml')),
    importedSessions: fs.existsSync(path.join(home, 'sessions')),
  }) + '\n')
  const canary = typeof control.canary === 'string' ? control.canary : ''
  const finish = () => {
    if (!usable && canary && control.leak === 'message' && home !== canonical) {
      event({ type: 'turn.failed', error: { message: 'Provider rejected login value ' + canary } })
      process.exitCode = 1
      return
    }
    if (!usable && canary && control.leak === 'stderr' && home !== canonical) {
      process.stderr.write('Provider rejected login value ' + canary + '\n')
      event({ type: 'turn.failed', error: { message: 'HTTP 401: missing Authorization credentials.' } })
      process.exitCode = 1
      return
    }
    if (!usable) {
      event({ type: 'turn.failed', error: { message: 'HTTP 401: missing Authorization credentials.\nAuthorization: Bearer fixture-private-value' } })
      process.exitCode = 1
      return
    }
    if (control.mode === 'rotate' && home !== canonical) fs.writeFileSync(auth, '{"fixture":"rotated-private-canary"}')
    event({ type: 'item.completed', item: { type: 'agent_message', text: 'OK' } })
    event({ type: 'turn.completed' })
  }
  if (control.hold && home !== canonical) {
    fs.writeFileSync(path.join(process.env.HOME, 'codex-probe-started'), '')
    const poll = setInterval(() => {
      if (!fs.existsSync(path.join(process.env.HOME, 'codex-probe-release'))) return
      clearInterval(poll)
      finish()
    }, 10)
  } else finish()
} else {
  process.stderr.write('unexpected fake Codex arguments\n')
  process.exitCode = 64
}
