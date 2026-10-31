// A stand-in for GitHub in deploy/ci/e2e.sh: the OAuth App web flow and the
// two API reads sign-in makes (GET /user, GET /user/memberships/orgs/{org}).
// The test's browser picks who signs in by adding login=<name> to the
// authorize URL the gateway sends it to. Like GitHub, it refuses an unknown
// client, a wrong client secret and a callback other than the OAuth App's.
//
// Settings: FAKE_GITHUB_PORT, FAKE_GITHUB_CLIENT_ID,
// FAKE_GITHUB_CLIENT_SECRET, FAKE_GITHUB_CALLBACK (the OAuth App's callback
// URL) and FAKE_GITHUB_USERS (login:id,login:id).
import { randomBytes } from 'node:crypto'
import http from 'node:http'

function setting(name) {
  const value = process.env[name]
  if (!value) {
    console.error(`fake-github: ${name} is required`)
    process.exit(1)
  }
  return value
}

const port = Number(setting('FAKE_GITHUB_PORT'))
const clientId = setting('FAKE_GITHUB_CLIENT_ID')
const clientSecret = setting('FAKE_GITHUB_CLIENT_SECRET')
const callback = setting('FAKE_GITHUB_CALLBACK')
const users = new Map(setting('FAKE_GITHUB_USERS').split(',').map((entry) => {
  const [login, id] = entry.split(':')
  return [login.toLowerCase(), { login, id: Number(id) }]
}))
const codes = new Map()
const tokens = new Map()

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function authorize(res, query) {
  if (query.get('client_id') !== clientId) return json(res, 404, { message: 'Not Found' })
  if (query.get('redirect_uri') !== callback) {
    return json(res, 400, { error: 'redirect_uri_mismatch', error_description: `The redirect_uri must be ${callback}` })
  }
  const user = users.get((query.get('login') ?? '').toLowerCase())
  if (!user) return json(res, 400, { error: 'unknown_login', error_description: 'login= names nobody this fake knows' })
  const code = randomBytes(10).toString('hex')
  codes.set(code, { login: user.login, scope: query.get('scope') ?? '' })
  const target = new URL(callback)
  target.searchParams.set('code', code)
  target.searchParams.set('state', query.get('state') ?? '')
  res.writeHead(302, { location: target.href })
  res.end()
}

function exchange(res, body) {
  const input = JSON.parse(body)
  if (input.client_id !== clientId || input.client_secret !== clientSecret) {
    return json(res, 200, { error: 'incorrect_client_credentials', error_description: 'The client_id and/or client_secret passed are incorrect.' })
  }
  const grant = codes.get(input.code)
  codes.delete(input.code)
  if (!grant || input.redirect_uri !== callback) {
    return json(res, 200, { error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' })
  }
  const token = `gho_${randomBytes(18).toString('hex')}`
  tokens.set(token, grant.login)
  json(res, 200, { access_token: token, token_type: 'bearer', scope: grant.scope })
}

const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const url = new URL(req.url ?? '/', 'http://github.invalid')
    // Never the query string: it carries codes and states.
    console.log(`${req.method} ${url.pathname}`)
    if (req.method === 'GET' && url.pathname === '/login/oauth/authorize') return authorize(res, url.searchParams)
    if (req.method === 'POST' && url.pathname === '/login/oauth/access_token') return exchange(res, Buffer.concat(chunks).toString('utf8'))
    const login = tokens.get((req.headers.authorization ?? '').replace(/^Bearer /, ''))
    const user = login ? users.get(login.toLowerCase()) : undefined
    if (!user) return json(res, 401, { message: 'Bad credentials' })
    if (req.method === 'GET' && url.pathname === '/user') return json(res, 200, { login: user.login, id: user.id })
    // Nobody belongs to an organisation here.
    json(res, 404, { message: 'Not Found' })
  })
})

server.listen(port, '0.0.0.0', () => console.log(`fake-github: listening on ${port}`))
// Docker stops the container with SIGTERM, which a Node process at PID 1 would ignore.
process.on('SIGTERM', () => process.exit(0))
