import { createPublicKey, verify } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import http, { type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect } from 'vitest'
import type { AssertionClaims } from '../src/assertion.js'
import { loadConfig, type Config } from '../src/config.js'
import { DiskWatch } from '../src/disk.js'
import { DockerClient } from '../src/docker.js'
import { createGateway, type Gateway } from '../src/gateway.js'
import { GitHubClient } from '../src/github.js'
import { loadOrCreateKeys, type GatewayKeys } from '../src/keys.js'
import { createLogger } from '../src/log.js'
import { Orchestrator, type Upstream } from '../src/orchestrator.js'
import { Store } from '../src/store.js'
import { prepareWorkspaceDns } from '../src/workspace-dns.js'
import { startFakeDocker, type FakeDocker } from './fakes/docker.js'
import { startFakeGitHub, type FakeGitHub } from './fakes/github.js'
import { startWorkspaceStub, type WorkspaceStub } from './fakes/workspace.js'

export const DOMAIN = 'poise.test'
export const APEX = DOMAIN
export const CURRENT_IMAGE_ID = 'sha256:1111111111111111111111111111111111111111111111111111111111111111'
export const OLD_IMAGE_ID = 'sha256:0000000000000000000000000000000000000000000000000000000000000000'
/** Where the Docker host keeps the gateway container's data directory, as Docker reports its mount. */
export const GATEWAY_DATA_SOURCE = '/var/lib/docker/volumes/poise-gateway-data/_data'

export interface Reply {
  status: number
  headers: IncomingHttpHeaders
  body: string
  json<T = Record<string, unknown>>(): T
  /** The raw Set-Cookie line for a cookie name, if the reply set it. */
  setCookie(name: string): string | undefined
  /** `name=value` of a cookie the reply set, ready to send back. */
  cookie(name: string): string
}

export interface RequestOptions {
  host: string
  path: string
  method?: string
  headers?: Record<string, string>
  body?: string
}

export interface Harness {
  config: Config
  store: Store
  keys: GatewayKeys
  github: FakeGitHub
  docker: FakeDocker
  workspace: WorkspaceStub
  orchestrator: Orchestrator
  /** The server's filesystem reads 200 GB free of 290 GB. */
  disk: DiskWatch
  logs: Array<Record<string, unknown>>
  port: number
  advance(ms: number): void
  request(options: RequestOptions): Promise<Reply>
  /** Signs in through the fake GitHub; the cookies come back as `name=value`, or '' when not set. */
  signIn(login: string, next?: string): Promise<{ reply: Reply; apexCookie: string; bindCookie: string }>
  openWorkspace(login: string): Promise<{ apexCookie: string; workspaceCookie: string; bindCookie: string }>
  close(): Promise<void>
}

export interface HarnessOptions {
  env?: Record<string, string | undefined>
  drainPollMs?: number
  drainRenewMs?: number
  /** The workspace answers only while the gateway's container is on its network, as on a Docker host. */
  requireNetwork?: boolean
}

export function workspaceHost(handle: string): string {
  return `${handle}.${DOMAIN}`
}

function toReply(status: number, headers: IncomingHttpHeaders, body: string): Reply {
  const setCookies = headers['set-cookie'] ?? []
  const setCookie = (name: string) => setCookies.find((line) => line.startsWith(`${name}=`))
  return {
    status,
    headers,
    body,
    json: <T>() => JSON.parse(body) as T,
    setCookie,
    cookie: (name) => {
      const line = setCookie(name)
      if (!line) throw new Error(`the reply set no ${name} cookie (status ${status})`)
      return line.split(';')[0]
    },
  }
}

export function send(port: number, options: RequestOptions): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: options.method ?? 'GET',
      path: options.path,
      headers: { host: options.host, ...options.headers },
      agent: false,
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve(toReply(res.statusCode ?? 0, res.headers, Buffer.concat(chunks).toString('utf8'))))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end(options.body)
  })
}

async function closedPort(): Promise<number> {
  const server = http.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'gw-'))
  const dataDir = join(dir, 'data')
  mkdirSync(dataDir)
  const github = await startFakeGitHub('client-id', 'client-secret')
  for (const [login, id, orgs] of [
    ['root', 1000, undefined],
    ['Alice', 1001, undefined],
    ['bob', 1002, undefined],
    ['carol', 1003, { acme: 'active' }],
    ['dave', 1004, { acme: 'restricted' }],
    ['erin', 1005, { acme: 'pending' }],
    ['www', 1006, { acme: 'active' }],
    ['mallory', 1007, undefined],
  ] as const) {
    github.users.set(login.toLowerCase(), { login, id, orgs })
  }
  const docker = await startFakeDocker(dir)
  docker.images.set('poise-runtime:latest', CURRENT_IMAGE_ID)
  docker.addContainer({
    name: 'poise-gateway',
    imageId: 'sha256:gateway',
    imageRef: 'poise-gateway',
    running: true,
    labels: {},
    networks: new Set(['bridge']),
    spec: { HostConfig: { Mounts: [{ Type: 'volume', Source: GATEWAY_DATA_SOURCE, Target: dataDir }] } },
  })
  const workspace = await startWorkspaceStub()
  const unreachablePort = await closedPort()

  const config = loadConfig({
    POISE_DOMAIN: DOMAIN,
    POISE_GITHUB_CLIENT_ID: 'client-id',
    POISE_GITHUB_CLIENT_SECRET: 'client-secret',
    POISE_GITHUB_URL: github.url,
    POISE_GITHUB_API_URL: github.url,
    POISE_ALLOWED_USERS: 'alice,bob',
    POISE_ADMINS: 'root',
    POISE_RUNTIME_IMAGE: 'poise-runtime:latest',
    POISE_GATEWAY_DATA: dataDir,
    POISE_DOCKER_SOCKET: docker.socketPath,
    POISE_GATEWAY_CONTAINER: 'poise-gateway',
    ...options.env,
  })

  let offset = 0
  const now = () => Date.now() + offset
  const logs: Array<Record<string, unknown>> = []
  const log = createLogger((line) => logs.push(JSON.parse(line) as Record<string, unknown>))
  const store = new Store(join(dataDir, 'gateway.db'), now)
  store.syncEnvAllowList(config.allowedUsers)
  const keys = loadOrCreateKeys(dataDir, log)
  const upstream = (handle: string): Upstream => {
    const joined = !options.requireNetwork || docker.containers.get('poise-gateway')?.networks.has(`poise-net-${handle}`) === true
    return { host: '127.0.0.1', port: workspace.reachable && joined ? workspace.port : unreachablePort }
  }
  const dockerClient = new DockerClient(config.dockerSocket)
  const workspaceResolvConf = await prepareWorkspaceDns(config, dockerClient)
  const orchestrator = new Orchestrator({
    config, docker: dockerClient, store, keys, log, now, upstream, workspaceResolvConf,
    drainPollMs: options.drainPollMs ?? 10, drainRenewMs: options.drainRenewMs,
  })
  const disk = new DiskWatch({ config, docker: dockerClient, log, now, space: async () => ({ free: 200 * 1024 ** 3, total: 290 * 1024 ** 3 }) })
  const gateway: Gateway = createGateway({
    config, store, keys, github: new GitHubClient(config), docker: dockerClient, orchestrator, disk, log, now, upstream,
  })
  await new Promise<void>((resolve) => gateway.server.listen(0, '127.0.0.1', resolve))
  const { port } = gateway.server.address() as AddressInfo

  const request = (requestOptions: RequestOptions) => send(port, requestOptions)

  const signIn = async (login: string, next?: string) => {
    github.signInAs(login)
    const start = await request({ host: APEX, path: next === undefined ? '/auth/login' : `/auth/login?next=${encodeURIComponent(next)}` })
    expect(start.status).toBe(302)
    const authorize = await fetch(start.headers.location ?? '', { redirect: 'manual' })
    const callback = new URL(authorize.headers.get('location') ?? '')
    expect(callback.host).toBe(APEX)
    const reply = await request({
      host: APEX,
      path: `${callback.pathname}${callback.search}`,
      headers: { cookie: start.cookie('poise_oauth') },
    })
    return {
      reply,
      apexCookie: reply.setCookie('poise_gw') ? reply.cookie('poise_gw') : '',
      bindCookie: reply.setCookie('poise_bind') ? reply.cookie('poise_bind') : '',
    }
  }

  const openWorkspace = async (login: string) => {
    const handle = login.toLowerCase()
    const { reply, apexCookie, bindCookie } = await signIn(login, `https://${workspaceHost(handle)}/`)
    expect(reply.status).toBe(302)
    const ticketUrl = new URL(reply.headers.location ?? '')
    expect(ticketUrl.host).toBe(workspaceHost(handle))
    const session = await request({
      host: workspaceHost(handle),
      path: `${ticketUrl.pathname}${ticketUrl.search}`,
      headers: { cookie: bindCookie },
    })
    expect(session.status).toBe(302)
    return { apexCookie, workspaceCookie: session.cookie('poise_ws'), bindCookie }
  }

  return {
    config,
    store,
    keys,
    github,
    docker,
    workspace,
    orchestrator,
    disk,
    logs,
    port,
    advance: (ms) => {
      offset += ms
    },
    request,
    signIn,
    openWorkspace,
    close: async () => {
      await gateway.close()
      await Promise.all([workspace.close(), github.close(), docker.close()])
      store.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** Verifies an X-Poise-Identity assertion against the public key exactly as workspaces receive it. */
export function verifyAssertion(token: string, publicKeyBase64: string): AssertionClaims {
  const [header, payload, signature] = token.split('.')
  const publicKey = createPublicKey(Buffer.from(publicKeyBase64, 'base64').toString('utf8'))
  const valid = verify(null, Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url'))
  if (!valid) throw new Error('the assertion signature does not verify')
  expect(JSON.parse(Buffer.from(header, 'base64url').toString('utf8'))).toEqual({ alg: 'EdDSA', typ: 'JWT' })
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as AssertionClaims
}

export function events(logs: Array<Record<string, unknown>>, prefix = ''): string[] {
  return logs.map((entry) => String(entry.event)).filter((event) => event.startsWith(prefix))
}
