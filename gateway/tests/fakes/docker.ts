import { randomBytes } from 'node:crypto'
import http, { type ServerResponse } from 'node:http'
import { join } from 'node:path'

export interface FakeContainer {
  id: string
  name: string
  imageId: string
  imageRef: string
  running: boolean
  labels: Record<string, string>
  networks: Set<string>
  spec: Record<string, unknown>
}

export interface DockerCall {
  method: string
  path: string
  body: unknown
}

/** The subset of the Docker Engine API the gateway calls, on a unix socket, recording every request. */
export interface FakeDocker {
  socketPath: string
  images: Map<string, string>
  /** Each volume's size in bytes, as /system/df reports it. */
  volumeSizes: Map<string, number>
  volumes: Set<string>
  networks: Set<string>
  containers: Map<string, FakeContainer>
  calls: DockerCall[]
  /** Called whenever a container starts or restarts. */
  onStart: (name: string) => void
  addContainer(container: Omit<FakeContainer, 'id'>): FakeContainer
  close(): Promise<void>
}

function send(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status)
    res.end()
    return
  }
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function inspect(container: FakeContainer): unknown {
  return {
    Id: container.id,
    Name: `/${container.name}`,
    Image: container.imageId,
    State: { Status: container.running ? 'running' : 'exited', Running: container.running },
    Config: { Image: container.imageRef, Labels: container.labels, Env: container.spec.Env ?? null },
    NetworkSettings: { Networks: Object.fromEntries([...container.networks].map((network) => [network, {}])) },
    // As Docker reports them: where each mount comes from, and where the container sees it.
    Mounts: ((container.spec.HostConfig as { Mounts?: Array<{ Type: string; Source: string; Target: string }> } | undefined)?.Mounts ?? [])
      .map((mount) => ({ Type: mount.Type, Source: mount.Source, Destination: mount.Target })),
  }
}

export async function startFakeDocker(dir: string): Promise<FakeDocker> {
  const socketPath = join(dir, 'docker.sock')
  const images = new Map<string, string>()
  const volumes = new Set<string>()
  const networks = new Set<string>(['bridge'])
  const containers = new Map<string, FakeContainer>()
  const calls: DockerCall[] = []

  const fake: FakeDocker = {
    socketPath,
    images,
    volumeSizes: new Map(),
    volumes,
    networks,
    containers,
    calls,
    onStart: () => undefined,
    addContainer: (container) => {
      const created = { ...container, id: randomBytes(16).toString('hex') }
      containers.set(created.name, created)
      return created
    },
    close: () => new Promise((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    }),
  }

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      const body = text ? JSON.parse(text) as Record<string, unknown> : undefined
      const url = new URL(req.url ?? '/', 'http://docker')
      const method = req.method ?? ''
      calls.push({ method, path: `${url.pathname}${url.search}`, body })
      const path = url.pathname
      let match: RegExpExecArray | null

      if (method === 'GET' && (match = /^\/images\/(.+)\/json$/.exec(path))) {
        const id = images.get(decodeURI(match[1]))
        return id ? send(res, 200, { Id: id }) : send(res, 404, { message: `No such image: ${match[1]}` })
      }
      if (method === 'GET' && path === '/containers/json') {
        const filters = JSON.parse(url.searchParams.get('filters') ?? '{}') as { label?: string[] }
        const list = [...containers.values()].filter((container) => (filters.label ?? []).every((filter) => {
          const [key, value] = filter.split('=')
          return container.labels[key] === value
        }))
        return send(res, 200, list.map((container) => ({
          Id: container.id,
          Names: [`/${container.name}`],
          Image: container.imageRef,
          ImageID: container.imageId,
          State: container.running ? 'running' : 'exited',
          Labels: container.labels,
        })))
      }
      if (method === 'POST' && path === '/containers/create') {
        const name = url.searchParams.get('name') ?? ''
        if (containers.has(name)) return send(res, 409, { message: `Conflict. The container name "/${name}" is already in use` })
        const imageRef = String(body?.Image)
        const imageId = images.get(imageRef)
        if (!imageId) return send(res, 404, { message: `No such image: ${imageRef}` })
        const hostConfig = (body?.HostConfig ?? {}) as { NetworkMode?: string }
        const created = fake.addContainer({
          name,
          imageId,
          imageRef,
          running: false,
          labels: (body?.Labels ?? {}) as Record<string, string>,
          networks: new Set(hostConfig.NetworkMode ? [hostConfig.NetworkMode] : []),
          spec: body ?? {},
        })
        return send(res, 201, { Id: created.id, Warnings: [] })
      }
      if ((match = /^\/containers\/([^/]+)(?:\/(json|start|stop|restart))?$/.exec(path))) {
        const key = decodeURIComponent(match[1])
        const container = containers.get(key) ?? [...containers.values()].find((candidate) => candidate.id === key)
        if (!container) return send(res, 404, { message: `No such container: ${match[1]}` })
        const action = match[2]
        if (method === 'GET' && action === 'json') return send(res, 200, inspect(container))
        if (method === 'POST' && action === 'start') {
          if (container.running) return send(res, 304)
          container.running = true
          fake.onStart(container.name)
          return send(res, 204)
        }
        if (method === 'POST' && action === 'stop') {
          if (!container.running) return send(res, 304)
          container.running = false
          return send(res, 204)
        }
        if (method === 'POST' && action === 'restart') {
          container.running = true
          fake.onStart(container.name)
          return send(res, 204)
        }
        if (method === 'DELETE' && action === undefined) {
          if (container.running) return send(res, 409, { message: 'You cannot remove a running container' })
          containers.delete(container.name)
          return send(res, 204)
        }
      }
      if (method === 'GET' && path === '/system/df' && url.searchParams.get('type') === 'volume') {
        return send(res, 200, { Volumes: [...volumes].map((name) => ({ Name: name, UsageData: { Size: fake.volumeSizes.get(name) ?? 0, RefCount: 1 } })) })
      }
      if (method === 'GET' && (match = /^\/volumes\/([^/]+)$/.exec(path))) {
        const name = decodeURIComponent(match[1])
        return volumes.has(name) ? send(res, 200, { Name: name }) : send(res, 404, { message: `get ${name}: no such volume` })
      }
      if (method === 'POST' && path === '/volumes/create') {
        volumes.add(String(body?.Name))
        return send(res, 201, { Name: body?.Name })
      }
      if (method === 'GET' && (match = /^\/networks\/([^/]+)$/.exec(path))) {
        const name = decodeURIComponent(match[1])
        return networks.has(name) ? send(res, 200, { Name: name }) : send(res, 404, { message: `network ${name} not found` })
      }
      if (method === 'POST' && path === '/networks/create') {
        networks.add(String(body?.Name))
        return send(res, 201, { Id: randomBytes(16).toString('hex') })
      }
      if (method === 'POST' && (match = /^\/networks\/([^/]+)\/connect$/.exec(path))) {
        const network = decodeURIComponent(match[1])
        const container = containers.get(String(body?.Container))
        if (!networks.has(network) || !container) return send(res, 404, { message: 'no such network or container' })
        if (container.networks.has(network)) {
          return send(res, 403, { message: `endpoint with name ${container.name} already exists in network ${network}` })
        }
        container.networks.add(network)
        return send(res, 200)
      }
      send(res, 404, { message: `page not found: ${method} ${path}` })
    })
  })
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  return fake
}
