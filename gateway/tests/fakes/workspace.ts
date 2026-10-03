import http, { type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'

export interface SeenRequest {
  method: string
  url: string
  headers: IncomingHttpHeaders
  body: string
}

/**
 * A real upstream standing in for a workspace: it echoes what it receives over HTTP and
 * WebSocket and serves the /api/service/* endpoints of the workspace runtime contract.
 */
export interface WorkspaceStub {
  port: number
  /** False makes the gateway's resolver point at a closed port, as if the container were not running. */
  reachable: boolean
  /** The status /api/service/health and /api/service/drain answer with. */
  healthStatus: number
  health: { ok: boolean; activeChatTurns: number; runningCallerCalls: number; draining: boolean }
  requests: SeenRequest[]
  serviceRequests: SeenRequest[]
  close(): Promise<void>
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

export async function startWorkspaceStub(): Promise<WorkspaceStub> {
  const stub: Omit<WorkspaceStub, 'port' | 'close'> = {
    reachable: true,
    healthStatus: 200,
    health: { ok: true, activeChatTurns: 0, runningCallerCalls: 0, draining: false },
    requests: [],
    serviceRequests: [],
  }

  const server = http.createServer((req, res) => {
    const url = req.url ?? '/'
    if (url === '/stream') {
      // Full-duplex echo: every request chunk is answered at once, before the request body ends.
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.write('open\n')
      req.on('data', (chunk: Buffer) => res.write(`echo:${chunk.toString('utf8')}\n`))
      req.on('end', () => res.end('done\n'))
      return
    }
    if (url === '/reset') {
      req.socket.destroy()
      return
    }
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const seen = { method: req.method ?? '', url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') }
      if (url.startsWith('/api/service/')) {
        stub.serviceRequests.push(seen)
        if (url === '/api/service/drain' && req.method === 'POST') stub.health.draining = true
        if (url === '/api/service/health' || url === '/api/service/drain') {
          if (stub.healthStatus !== 200) return json(res, stub.healthStatus, { error: 'refused' })
          return json(res, 200, { mode: 'service', version: 'test', ...stub.health })
        }
        return json(res, 404, { error: 'not_found' })
      }
      stub.requests.push(seen)
      if (url === '/created') {
        res.writeHead(201, { 'content-type': 'text/plain', 'set-cookie': ['a=1; Path=/', 'b=2; Path=/'], 'x-workspace': 'yes' })
        return res.end('created')
      }
      json(res, 200, seen)
    })
  })

  const sockets = new WebSocketServer({ server })
  sockets.on('connection', (socket, req) => {
    socket.send(JSON.stringify({ type: 'hello', url: req.url, headers: req.headers }))
    socket.on('message', (data) => socket.send(`echo:${String(data)}`))
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return Object.assign(stub, {
    port,
    close: () => new Promise<void>((resolve) => {
      for (const client of sockets.clients) client.terminate()
      sockets.close()
      server.close(() => resolve())
      server.closeAllConnections()
    }),
  })
}
