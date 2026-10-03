import { isAbsolute } from 'node:path'

/** Handles that name the gateway's own addresses and can never belong to a person. */
export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  'www', 'api', 'admin', 'auth', 'link', 'static', 'gateway', 'app', 'mail',
])

// GitHub logins and organisation names: letters, digits and single inner hyphens, at most 39 characters.
const GITHUB_NAME = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i
const DNS_LABEL = /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/
const IMAGE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/
const DOCKER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/
const SIZE_UNITS: Record<string, number> = { '': 1, b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }
const MIN_MEMORY_BYTES = 6 * 1024 ** 2

export interface Config {
  domain: string
  insecureHttp: boolean
  githubClientId: string
  githubClientSecret: string
  githubUrl: string
  githubApiUrl: string
  allowedUsers: string[]
  allowedOrgs: string[]
  admins: string[]
  runtimeImage: string
  workspaceMemoryBytes: number
  workspaceNanoCpus: number
  workspacePids: number
  workspaceRuntime: string | null
  /** Workspaces get POISE_SKIP_CLI_BOOTSTRAP=1 and install no provider CLIs; for end-to-end tests. */
  workspaceSkipCliBootstrap: boolean
  drainTimeoutSeconds: number
  dataDir: string
  dockerSocket: string
  gatewayContainer: string
  port: number
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`The gateway configuration is invalid:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`)
    this.name = 'ConfigError'
  }
}

export function isGitHubName(value: string): boolean {
  return GITHUB_NAME.test(value)
}

/** Names that never resolve on the public internet, the only ones plain-http mode may serve. */
export function isLocalDomain(domain: string): boolean {
  return domain.endsWith('.localhost') || domain.endsWith('.test')
}

function isDomainName(value: string): boolean {
  return value.length <= 253 && value.split('.').every((label) => DNS_LABEL.test(label))
}

/** Reads and validates the whole configuration, reporting every problem at once. */
export function loadConfig(env: Readonly<Record<string, string | undefined>>): Config {
  const problems: string[] = []
  const read = (name: string): string | undefined => {
    const value = env[name]?.trim()
    return value ? value : undefined
  }
  const required = (name: string, purpose: string): string => {
    const value = read(name)
    if (value === undefined) problems.push(`${name} is required (${purpose})`)
    return value ?? ''
  }

  const domainValue = required('POISE_DOMAIN', 'the apex host name, for example poise.example.com')
  const domain = domainValue.toLowerCase()
  if (domainValue && !isDomainName(domain)) {
    problems.push(`POISE_DOMAIN must be a bare host name such as poise.example.com, without scheme, port or path; got "${domainValue}"`)
  } else if (domainValue && !domain.includes('.')) {
    // Browsers keep a Domain cookie on a single-label host to that host, so poise_bind would never
    // reach the workspace hosts and no ticket could be redeemed.
    problems.push(`POISE_DOMAIN must have at least two labels, such as poise.example.com or poise.localhost; got "${domainValue}"`)
  }

  let insecureHttp = false
  const insecureValue = read('POISE_INSECURE_HTTP')
  if (insecureValue !== undefined) {
    if (insecureValue !== '1') {
      problems.push(`POISE_INSECURE_HTTP must be 1 or unset; got "${insecureValue}"`)
    } else if (domain && !isLocalDomain(domain)) {
      problems.push(`POISE_INSECURE_HTTP=1 sends session cookies over plain http and is refused for "${domain}"; it is only for *.localhost and *.test domains`)
    } else {
      insecureHttp = true
    }
  }

  const githubClientId = required('POISE_GITHUB_CLIENT_ID', 'the GitHub OAuth App client ID')
  const githubClientSecret = required('POISE_GITHUB_CLIENT_SECRET', 'the GitHub OAuth App client secret')

  const serviceUrl = (name: string, standard: string): string => {
    const value = read(name) ?? standard
    let url: URL
    try {
      url = new URL(value)
    } catch {
      problems.push(`${name} must be an absolute URL; got "${value}"`)
      return standard
    }
    const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
      problems.push(`${name} must use https; plain http is accepted for loopback test servers only`)
    }
    if (url.username || url.password || url.search || url.hash) {
      problems.push(`${name} must not carry credentials, a query or a fragment`)
    }
    return url.href.replace(/\/+$/, '')
  }
  const githubUrl = serviceUrl('POISE_GITHUB_URL', 'https://github.com')
  const githubApiUrl = serviceUrl('POISE_GITHUB_API_URL', 'https://api.github.com')

  const nameList = (name: string, kind: string): string[] => {
    const names = new Set<string>()
    for (const value of (read(name) ?? '').split(/[\s,]+/).filter(Boolean)) {
      if (!isGitHubName(value)) problems.push(`${name}: "${value}" is not a valid GitHub ${kind}`)
      else names.add(value.toLowerCase())
    }
    return [...names]
  }
  const allowedUsers = nameList('POISE_ALLOWED_USERS', 'login')
  const allowedOrgs = nameList('POISE_ALLOWED_ORGS', 'organisation')
  const admins = nameList('POISE_ADMINS', 'login')
  if (admins.length === 0) {
    problems.push('POISE_ADMINS is required (at least one GitHub login that may administer the gateway)')
  }
  for (const [name, handles] of [['POISE_ALLOWED_USERS', allowedUsers], ['POISE_ADMINS', admins]] as const) {
    for (const handle of handles) {
      if (RESERVED_HANDLES.has(handle)) problems.push(`${name}: "${handle}" is a reserved handle and can never sign in`)
    }
  }

  const runtimeImage = required('POISE_RUNTIME_IMAGE', 'the workspace image, for example poise-runtime:latest')
  if (runtimeImage && !IMAGE_REFERENCE.test(runtimeImage)) {
    problems.push(`POISE_RUNTIME_IMAGE is not a valid image reference; got "${runtimeImage}"`)
  }

  const memoryValue = read('POISE_WORKSPACE_MEMORY') ?? '8g'
  const memoryMatch = /^(\d+(?:\.\d+)?)([bkmg]?)$/i.exec(memoryValue)
  const workspaceMemoryBytes = memoryMatch
    ? Math.floor(Number(memoryMatch[1]) * SIZE_UNITS[memoryMatch[2].toLowerCase()])
    : 0
  if (workspaceMemoryBytes < MIN_MEMORY_BYTES) {
    problems.push(`POISE_WORKSPACE_MEMORY must be a size of at least 6m, such as 8g or 512m; got "${memoryValue}"`)
  }

  const cpusValue = read('POISE_WORKSPACE_CPUS') ?? '4'
  const cpus = /^\d+(?:\.\d+)?$/.test(cpusValue) ? Number(cpusValue) : 0
  if (!(cpus > 0)) problems.push(`POISE_WORKSPACE_CPUS must be a positive number such as 4 or 1.5; got "${cpusValue}"`)

  const wholeNumber = (name: string, standard: number, max = Number.MAX_SAFE_INTEGER): number => {
    const value = read(name)
    if (value === undefined) return standard
    const parsed = /^\d+$/.test(value) ? Number(value) : Number.NaN
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
      problems.push(`${name} must be a whole number from 1 to ${max}; got "${value}"`)
      return standard
    }
    return parsed
  }
  const workspacePids = wholeNumber('POISE_WORKSPACE_PIDS', 4096)
  const drainTimeoutSeconds = wholeNumber('POISE_DRAIN_TIMEOUT', 30 * 60)
  const port = wholeNumber('PORT', 8080, 65535)

  const workspaceRuntime = read('POISE_WORKSPACE_RUNTIME') ?? null
  if (workspaceRuntime !== null && !DOCKER_NAME.test(workspaceRuntime)) {
    problems.push(`POISE_WORKSPACE_RUNTIME is not a valid OCI runtime name; got "${workspaceRuntime}"`)
  }

  const skipBootstrapValue = read('POISE_WORKSPACE_SKIP_CLI_BOOTSTRAP')
  if (skipBootstrapValue !== undefined && skipBootstrapValue !== '1') {
    problems.push(`POISE_WORKSPACE_SKIP_CLI_BOOTSTRAP must be 1 or unset; got "${skipBootstrapValue}"`)
  }

  const absolutePath = (name: string, standard: string): string => {
    const value = read(name) ?? standard
    if (!isAbsolute(value)) problems.push(`${name} must be an absolute path; got "${value}"`)
    return value
  }
  const dataDir = absolutePath('POISE_GATEWAY_DATA', '/data')
  const dockerSocket = absolutePath('POISE_DOCKER_SOCKET', '/var/run/docker.sock')

  const gatewayContainer = required('POISE_GATEWAY_CONTAINER', "the gateway's own container name, so it can join workspace networks")
  if (gatewayContainer && !DOCKER_NAME.test(gatewayContainer)) {
    problems.push(`POISE_GATEWAY_CONTAINER is not a valid container name; got "${gatewayContainer}"`)
  }

  if (problems.length > 0) throw new ConfigError(problems)

  return {
    domain,
    insecureHttp,
    githubClientId,
    githubClientSecret,
    githubUrl,
    githubApiUrl,
    allowedUsers,
    allowedOrgs,
    admins,
    runtimeImage,
    workspaceMemoryBytes,
    workspaceNanoCpus: Math.round(cpus * 1e9),
    workspacePids,
    workspaceRuntime,
    workspaceSkipCliBootstrap: skipBootstrapValue === '1',
    drainTimeoutSeconds,
    dataDir,
    dockerSocket,
    gatewayContainer,
    port,
  }
}
