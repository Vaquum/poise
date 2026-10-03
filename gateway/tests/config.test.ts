import { describe, expect, it } from 'vitest'
import { ConfigError, loadConfig } from '../src/config.js'

const BASE = {
  POISE_DOMAIN: 'poise.example.com',
  POISE_GITHUB_CLIENT_ID: 'id',
  POISE_GITHUB_CLIENT_SECRET: 'secret',
  POISE_ADMINS: 'root',
  POISE_RUNTIME_IMAGE: 'poise-runtime:latest',
  POISE_GATEWAY_CONTAINER: 'poise-gateway',
}

function problems(env: Record<string, string | undefined>): string[] {
  try {
    loadConfig(env)
  } catch (error) {
    if (error instanceof ConfigError) return error.problems
    throw error
  }
  throw new Error('the configuration was accepted')
}

describe('configuration', () => {
  it('applies the documented defaults', () => {
    expect(loadConfig(BASE)).toEqual({
      domain: 'poise.example.com',
      insecureHttp: false,
      githubClientId: 'id',
      githubClientSecret: 'secret',
      githubUrl: 'https://github.com',
      githubApiUrl: 'https://api.github.com',
      allowedUsers: [],
      allowedOrgs: [],
      admins: ['root'],
      runtimeImage: 'poise-runtime:latest',
      workspaceMemoryBytes: 8 * 1024 ** 3,
      workspaceNanoCpus: 4_000_000_000,
      workspacePids: 4096,
      workspaceRuntime: null,
      workspaceSkipCliBootstrap: false,
      drainTimeoutSeconds: 1800,
      dataDir: '/data',
      dockerSocket: '/var/run/docker.sock',
      gatewayContainer: 'poise-gateway',
      port: 8080,
    })
  })

  it('reads every variable and normalises logins and the domain to lower case', () => {
    const config = loadConfig({
      ...BASE,
      POISE_DOMAIN: 'Poise.Example.com',
      POISE_ALLOWED_USERS: 'Alice, bob alice',
      POISE_ALLOWED_ORGS: 'Acme',
      POISE_ADMINS: 'Root,alice',
      POISE_WORKSPACE_MEMORY: '512m',
      POISE_WORKSPACE_CPUS: '1.5',
      POISE_WORKSPACE_PIDS: '100',
      POISE_WORKSPACE_RUNTIME: 'runsc',
      POISE_WORKSPACE_SKIP_CLI_BOOTSTRAP: '1',
      POISE_DRAIN_TIMEOUT: '60',
      POISE_GATEWAY_DATA: '/srv/gateway',
      POISE_DOCKER_SOCKET: '/run/docker.sock',
      PORT: '9000',
    })
    expect(config).toMatchObject({
      domain: 'poise.example.com',
      allowedUsers: ['alice', 'bob'],
      allowedOrgs: ['acme'],
      admins: ['root', 'alice'],
      workspaceMemoryBytes: 512 * 1024 ** 2,
      workspaceNanoCpus: 1_500_000_000,
      workspacePids: 100,
      workspaceRuntime: 'runsc',
      workspaceSkipCliBootstrap: true,
      drainTimeoutSeconds: 60,
      dataDir: '/srv/gateway',
      dockerSocket: '/run/docker.sock',
      port: 9000,
    })
  })

  it('names every missing required variable at once', () => {
    const found = problems({})
    for (const name of ['POISE_DOMAIN', 'POISE_GITHUB_CLIENT_ID', 'POISE_GITHUB_CLIENT_SECRET', 'POISE_ADMINS', 'POISE_RUNTIME_IMAGE', 'POISE_GATEWAY_CONTAINER']) {
      expect(found.some((problem) => problem.startsWith(`${name} is required`))).toBe(true)
    }
  })

  it('refuses a POISE_ADMINS that names nobody', () => {
    for (const admins of [',', ' , ;', ', ,']) {
      expect(problems({ ...BASE, POISE_ADMINS: admins }).some((problem) => problem.startsWith('POISE_ADMINS is required'))).toBe(true)
    }
  })

  it('refuses a single-label POISE_DOMAIN, which poise_bind cannot span', () => {
    for (const domain of ['localhost', 'test', 'intranet']) {
      expect(problems({ ...BASE, POISE_DOMAIN: domain })).toEqual([
        `POISE_DOMAIN must have at least two labels, such as poise.example.com or poise.localhost; got "${domain}"`,
      ])
    }
  })

  it('refuses POISE_INSECURE_HTTP for a public domain', () => {
    expect(problems({ ...BASE, POISE_INSECURE_HTTP: '1' })).toEqual([
      expect.stringContaining('POISE_INSECURE_HTTP=1 sends session cookies over plain http and is refused for "poise.example.com"'),
    ])
  })

  it('accepts POISE_INSECURE_HTTP only for *.localhost and *.test', () => {
    for (const domain of ['poise.localhost', 'poise.test']) {
      expect(loadConfig({ ...BASE, POISE_DOMAIN: domain, POISE_INSECURE_HTTP: '1' }).insecureHttp).toBe(true)
    }
    for (const domain of ['localhost.example.com', 'poise.testing']) {
      expect(problems({ ...BASE, POISE_DOMAIN: domain, POISE_INSECURE_HTTP: '1' })).toHaveLength(1)
    }
    expect(problems({ ...BASE, POISE_DOMAIN: 'poise.test', POISE_INSECURE_HTTP: 'yes' })).toEqual([
      'POISE_INSECURE_HTTP must be 1 or unset; got "yes"',
    ])
  })

  it('accepts POISE_WORKSPACE_SKIP_CLI_BOOTSTRAP only as 1', () => {
    for (const value of ['0', 'yes', 'true']) {
      expect(problems({ ...BASE, POISE_WORKSPACE_SKIP_CLI_BOOTSTRAP: value })).toEqual([
        `POISE_WORKSPACE_SKIP_CLI_BOOTSTRAP must be 1 or unset; got "${value}"`,
      ])
    }
  })

  it('refuses reserved handles as allowed users or admins', () => {
    expect(problems({ ...BASE, POISE_ALLOWED_USERS: 'alice,www', POISE_ADMINS: 'admin' })).toEqual([
      'POISE_ALLOWED_USERS: "www" is a reserved handle and can never sign in',
      'POISE_ADMINS: "admin" is a reserved handle and can never sign in',
    ])
  })

  it('refuses malformed values', () => {
    const found = problems({
      ...BASE,
      POISE_DOMAIN: 'https://poise.example.com',
      POISE_ALLOWED_USERS: 'not_a_login',
      POISE_WORKSPACE_MEMORY: 'lots',
      POISE_WORKSPACE_CPUS: '-1',
      POISE_WORKSPACE_PIDS: '0',
      POISE_DRAIN_TIMEOUT: '30m',
      PORT: '70000',
      POISE_GITHUB_URL: 'http://github.example.com',
      POISE_GATEWAY_DATA: 'data',
      POISE_RUNTIME_IMAGE: 'bad image',
    })
    expect(found).toHaveLength(10)
  })

  it('refuses a POISE_DRAIN_TIMEOUT longer than a week, which workspaces would refuse', () => {
    expect(loadConfig({ ...BASE, POISE_DRAIN_TIMEOUT: '604800' }).drainTimeoutSeconds).toBe(604800)
    expect(problems({ ...BASE, POISE_DRAIN_TIMEOUT: '604801' })).toEqual([
      'POISE_DRAIN_TIMEOUT must be a whole number from 1 to 604800; got "604801"',
    ])
  })

  it('allows plain-http GitHub URLs only for loopback test servers', () => {
    expect(loadConfig({ ...BASE, POISE_GITHUB_URL: 'http://127.0.0.1:4000/', POISE_GITHUB_API_URL: 'http://localhost:4001' }))
      .toMatchObject({ githubUrl: 'http://127.0.0.1:4000', githubApiUrl: 'http://localhost:4001' })
  })
})
