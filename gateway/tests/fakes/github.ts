import { randomBytes } from 'node:crypto'
import http, { type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export type FakeMembership = 'active' | 'pending' | 'restricted'

export interface FakeGitHubUser {
  login: string
  id: number
  orgs?: Record<string, FakeMembership>
}

export interface RecordedRequest {
  method: string
  path: string
  headers: IncomingHttpHeaders
  body: string
}

/** GitHub's OAuth web flow plus GET /user and GET /user/memberships/orgs/{org}, in memory. */
export interface FakeGitHub {
  url: string
  users: Map<string, FakeGitHubUser>
  requests: RecordedRequest[]
  issuedTokens: string[]
  /** The account that "signs in" at the next authorize request. */
  signInAs(login: string): void
  close(): Promise<void>
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

export async function startFakeGitHub(clientId: string, clientSecret: string): Promise<FakeGitHub> {
  const users = new Map<string, FakeGitHubUser>()
  const requests: RecordedRequest[] = []
  const issuedTokens: string[] = []
  const codes = new Map<string, { login: string; redirectUri: string; scope: string }>()
  const tokens = new Map<string, string>()
  let nextLogin = ''

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      const url = new URL(req.url ?? '/', 'http://github.invalid')
      requests.push({ method: req.method ?? '', path: `${url.pathname}${url.search}`, headers: req.headers, body })

      if (req.method === 'GET' && url.pathname === '/login/oauth/authorize') {
        if (url.searchParams.get('client_id') !== clientId) return json(res, 400, { error: 'unknown client' })
        const redirectUri = url.searchParams.get('redirect_uri') ?? ''
        const code = randomBytes(10).toString('hex')
        codes.set(code, { login: nextLogin, redirectUri, scope: url.searchParams.get('scope') ?? '' })
        const target = new URL(redirectUri)
        target.searchParams.set('code', code)
        target.searchParams.set('state', url.searchParams.get('state') ?? '')
        res.writeHead(302, { location: target.href })
        return res.end()
      }

      if (req.method === 'POST' && url.pathname === '/login/oauth/access_token') {
        const input = JSON.parse(body) as Record<string, string>
        if (input.client_id !== clientId || input.client_secret !== clientSecret) {
          return json(res, 200, { error: 'incorrect_client_credentials', error_description: 'The client_id and/or client_secret passed are incorrect.' })
        }
        const grant = codes.get(input.code)
        codes.delete(input.code)
        if (!grant || grant.redirectUri !== input.redirect_uri) {
          return json(res, 200, { error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' })
        }
        const token = `gho_${randomBytes(18).toString('hex')}`
        tokens.set(token, grant.login)
        issuedTokens.push(token)
        return json(res, 200, { access_token: token, token_type: 'bearer', scope: grant.scope })
      }

      const login = tokens.get((req.headers.authorization ?? '').replace(/^Bearer /, ''))
      const user = login ? users.get(login.toLowerCase()) : undefined
      if (!user) return json(res, 401, { message: 'Bad credentials' })

      if (req.method === 'GET' && url.pathname === '/user') return json(res, 200, { login: user.login, id: user.id })

      const membership = /^\/user\/memberships\/orgs\/([^/]+)$/.exec(url.pathname)
      if (req.method === 'GET' && membership) {
        const org = decodeURIComponent(membership[1])
        const state = user.orgs?.[org]
        if (state === 'restricted') return json(res, 403, { message: `${org} has enabled OAuth App access restrictions` })
        if (!state) return json(res, 404, { message: 'Not Found' })
        return json(res, 200, { state, role: 'member', organization: { login: org } })
      }

      json(res, 404, { message: 'Not Found' })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    users,
    requests,
    issuedTokens,
    signInAs: (login) => {
      nextLogin = login
    },
    close: () => new Promise((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    }),
  }
}
