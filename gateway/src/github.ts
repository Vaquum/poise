import { isGitHubName, type Config } from './config.js'

export interface GitHubIdentity {
  login: string
  id: number
}

/** `restricted`: GitHub would not tell us, typically because the organisation restricts OAuth Apps. */
export type OrgMembership = 'active' | 'none' | 'restricted'

const TIMEOUT_MS = 10_000
const API_HEADERS = {
  accept: 'application/vnd.github+json',
  'user-agent': 'poise-gateway',
  'x-github-api-version': '2022-11-28',
}

type GitHubSettings = Pick<Config, 'githubUrl' | 'githubApiUrl' | 'githubClientId' | 'githubClientSecret'>

async function readObject(response: Response, what: string): Promise<Record<string, unknown>> {
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`GitHub answered ${what} with HTTP ${response.status} and a body that is not JSON`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`GitHub answered ${what} with HTTP ${response.status} and an unexpected body`)
  }
  return parsed as Record<string, unknown>
}

/** The OAuth App web flow and the two API reads sign-in needs. The token never leaves this exchange. */
export class GitHubClient {
  constructor(private readonly settings: GitHubSettings) {}

  authorizeUrl(state: string, redirectUri: string, scopes: readonly string[]): string {
    const url = new URL(`${this.settings.githubUrl}/login/oauth/authorize`)
    url.searchParams.set('client_id', this.settings.githubClientId)
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('scope', scopes.join(' '))
    url.searchParams.set('state', state)
    return url.href
  }

  async exchangeCode(code: string, redirectUri: string): Promise<string> {
    const response = await fetch(`${this.settings.githubUrl}/login/oauth/access_token`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'poise-gateway' },
      body: JSON.stringify({
        client_id: this.settings.githubClientId,
        client_secret: this.settings.githubClientSecret,
        code,
        redirect_uri: redirectUri,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const body = await readObject(response, 'the sign-in code exchange')
    if (response.ok && typeof body.access_token === 'string' && body.access_token) return body.access_token
    const reason = typeof body.error_description === 'string'
      ? body.error_description
      : typeof body.error === 'string' ? body.error : `HTTP ${response.status}`
    throw new Error(`GitHub refused the sign-in code: ${reason}`)
  }

  async user(token: string): Promise<GitHubIdentity> {
    const response = await fetch(`${this.settings.githubApiUrl}/user`, {
      headers: { ...API_HEADERS, authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const body = await readObject(response, 'GET /user')
    if (!response.ok) throw new Error(`GitHub answered GET /user with HTTP ${response.status}`)
    if (typeof body.login !== 'string' || !isGitHubName(body.login) || typeof body.id !== 'number') {
      throw new Error('GitHub answered GET /user without a usable login and id')
    }
    return { login: body.login, id: body.id }
  }

  async orgMembership(token: string, org: string): Promise<OrgMembership> {
    const response = await fetch(`${this.settings.githubApiUrl}/user/memberships/orgs/${encodeURIComponent(org)}`, {
      headers: { ...API_HEADERS, authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const body = await readObject(response, `GET /user/memberships/orgs/${org}`)
    if (response.status === 404) return 'none'
    if (response.status === 403) return 'restricted'
    if (!response.ok) throw new Error(`GitHub answered GET /user/memberships/orgs/${org} with HTTP ${response.status}`)
    return body.state === 'active' ? 'active' : 'none'
  }
}
