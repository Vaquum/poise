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
      workspaceDiskBudgetBytes: 50 * 1024 ** 3,
      workspaceNanoCpus: 4_000_000_000,
      workspacePids: 4096,
      workspaceRuntime: null,
      workspaceDns: [],
      workspaceSkipCliBootstrap: false,
      drainTimeoutSeconds: 1800,
      dataDir: '/data',
      dockerSocket: '/var/run/docker.sock',
      gatewayContainer: 'poise-gateway',
      port: 8080,
      proxyListen: null,
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
      POISE_PROXY_LISTEN: '[FD00::5]:8080',
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
      proxyListen: '[fd00::5]:8080',
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

  it('accepts POISE_PROXY_LISTEN only as one IP address and port', () => {
    for (const value of ['127.0.0.1:8080', '192.168.150.10:80', '[::1]:8080', '[fd00::5]:65535']) {
      expect(loadConfig({ ...BASE, POISE_PROXY_LISTEN: value }).proxyListen).toBe(value)
    }
    for (const value of [
      '8080', '127.0.0.1', 'localhost:8080', 'gateway:8080', '0.0.0.0:8080', '[::]:8080', '[0:0:0:0:0:0:0:0]:8080',
      '::1:8080', '127.0.0.1:0', '127.0.0.1:08080', '127.0.0.1:65536', '127.0.0.01:8080', 'http://127.0.0.1:8080',
    ]) {
      expect(problems({ ...BASE, POISE_PROXY_LISTEN: value }), value).toEqual([
        `POISE_PROXY_LISTEN must be one IP address and port, such as 127.0.0.1:8080 or [::1]:8080, never 0.0.0.0 or [::]; got "${value}"`,
      ])
    }
  })

  it('reads POISE_WORKSPACE_DNS as up to three resolver addresses, in order and once each', () => {
    expect(loadConfig({ ...BASE, POISE_WORKSPACE_DNS: '1.1.1.1, 2606:4700:4700::1111 1.1.1.1' }).workspaceDns)
      .toEqual(['1.1.1.1', '2606:4700:4700::1111'])
    expect(loadConfig({ ...BASE, POISE_WORKSPACE_DNS: 'FD00::53' }).workspaceDns).toEqual(['fd00::53'])
    for (const value of ['dns.example.com', '0.0.0.0', '::', '0:0:0:0:0:0:0:0', '1.1.1.1:53', '256.1.1.1', 'fe80::1%eth0', '[::1]']) {
      expect(problems({ ...BASE, POISE_WORKSPACE_DNS: value }), value).toEqual([
        `POISE_WORKSPACE_DNS: "${value}" is not the IP address of a resolver`,
      ])
    }
    expect(problems({ ...BASE, POISE_WORKSPACE_DNS: '1.1.1.1,1.0.0.1,8.8.8.8,8.8.4.4' })).toEqual([
      'POISE_WORKSPACE_DNS names 4 resolvers; at most three are used',
    ])
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

  it('takes a disk budget as a size, or 0 for none', () => {
    expect(loadConfig({ ...BASE, POISE_WORKSPACE_DISK_BUDGET: '500m' }).workspaceDiskBudgetBytes).toBe(500 * 1024 ** 2)
    expect(loadConfig({ ...BASE, POISE_WORKSPACE_DISK_BUDGET: '0' }).workspaceDiskBudgetBytes).toBe(0)
    expect(problems({ ...BASE, POISE_WORKSPACE_DISK_BUDGET: 'lots' })).toEqual([
      'POISE_WORKSPACE_DISK_BUDGET must be a size such as 50g or 500m, or 0 for none; got "lots"',
    ])
  })

  it('allows plain-http GitHub URLs only for loopback test servers', () => {
    expect(loadConfig({ ...BASE, POISE_GITHUB_URL: 'http://127.0.0.1:4000/', POISE_GITHUB_API_URL: 'http://localhost:4001' }))
      .toMatchObject({ githubUrl: 'http://127.0.0.1:4000', githubApiUrl: 'http://localhost:4001' })
  })
})
