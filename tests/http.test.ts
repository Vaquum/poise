import { Readable } from 'node:stream'
import { createServer, get, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { acceptedEncoding, endJson, enforceApiRequest, HttpError, readJson, setApiHeaders } from '../server/http'

function request(options: {
  body?: string
  contentType?: string
  host?: string
  origin?: string
  remoteAddress?: string
  url?: string
} = {}): IncomingMessage {
  const stream = Readable.from(options.body ? [Buffer.from(options.body)] : [])
  return Object.assign(stream, {
    headers: {
      host: options.host ?? '127.0.0.1:5555',
      ...(options.contentType ? { 'content-type': options.contentType } : {}),
      ...(options.origin ? { origin: options.origin } : {}),
    },
    method: 'POST',
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
    url: options.url ?? '/api/settings',
  }) as unknown as IncomingMessage
}

describe('local API boundary', () => {
  it('sandboxes API documents under the privileged local origin', () => {
    const headers = new Map<string, string | number | readonly string[]>()
    const response = {
      setHeader: (name: string, value: string | number | readonly string[]) => {
        headers.set(name, value)
      },
    } as unknown as ServerResponse

    setApiHeaders(response)

    expect(headers.get('Content-Security-Policy')).toContain("default-src 'none'")
    expect(headers.get('Content-Security-Policy')).toContain('sandbox')
  })

  it('accepts same-origin browser requests', () => {
    expect(() => enforceApiRequest(request({
      origin: 'http://127.0.0.1:5555',
    }))).not.toThrow()
  })

  it('accepts bracketed IPv6 loopback hosts', () => {
    expect(() => enforceApiRequest(request({
      host: '[::1]:5555',
      origin: 'http://[::1]:5555',
      remoteAddress: '::1',
    }))).not.toThrow()
  })

  it('rejects cross-origin browser requests', () => {
    expect(() => enforceApiRequest(request({
      origin: 'https://attacker.example',
    }))).toThrowError(new HttpError(403, 'request origin is not allowed'))
  })

  it('rejects an origin with a different scheme', () => {
    expect(() => enforceApiRequest(request({
      origin: 'https://127.0.0.1:5555',
    }))).toThrowError(new HttpError(403, 'request origin is not allowed'))
  })

  it('rejects non-loopback non-browser requests', () => {
    expect(() => enforceApiRequest(request({ remoteAddress: '192.0.2.10' })))
      .toThrowError(/must originate from loopback/)
  })

  it('parses bounded JSON requests', async () => {
    await expect(readJson<{ ok: boolean }>(request({
      body: '{"ok":true}',
      contentType: 'application/json; charset=utf-8',
    }))).resolves.toEqual({ ok: true })
  })

  it('rejects unsupported content types and oversized bodies', async () => {
    await expect(readJson(request({ body: '{}', contentType: 'text/plain' })))
      .rejects.toMatchObject({ statusCode: 415 })
    await expect(readJson(request({
      body: JSON.stringify({ value: 'x'.repeat(256) }),
      contentType: 'application/json',
    }), 64)).rejects.toMatchObject({ statusCode: 413 })
  })
})

describe('JSON responses', () => {
  it('reads which compressed encoding a request accepts', () => {
    expect(acceptedEncoding('gzip, deflate, br, zstd')).toBe('br')
    expect(acceptedEncoding('gzip;q=0.8, deflate')).toBe('gzip')
    expect(acceptedEncoding('br;q=0, gzip')).toBe('gzip')
    expect(acceptedEncoding('*')).toBe('br')
    expect(acceptedEncoding('identity')).toBeNull()
    expect(acceptedEncoding(undefined)).toBeNull()
    expect(acceptedEncoding(['deflate', 'gzip'])).toBe('gzip')
  })

  it('compresses a large body the request accepts, and leaves the rest as they are', async () => {
    const large = { rows: Array.from({ length: 400 }, (_, index) => ({ index, title: `Row ${index} of a large JSON body` })) }
    const server = createServer((req, res) => {
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/json')
      if (req.url === '/vary') res.setHeader('Vary', 'Origin')
      endJson(res, JSON.stringify(req.url === '/small' ? { ok: true } : large))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    const read = (path: string, encoding?: string, method = 'GET') => new Promise<{ headers: IncomingMessage['headers'], body: Buffer }>((resolve, reject) => {
      const req = get({ host: '127.0.0.1', port, path, method, headers: encoding ? { 'accept-encoding': encoding } : {} }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }))
      })
      req.on('error', reject)
    })
    try {
      const text = JSON.stringify(large)
      const br = await read('/large', 'gzip, deflate, br')
      expect(br.headers['content-encoding']).toBe('br')
      expect(br.headers.vary).toBe('Accept-Encoding')
      expect(Number(br.headers['content-length'])).toBe(br.body.length)
      expect(br.body.length).toBeLessThan(text.length / 4)
      expect(brotliDecompressSync(br.body).toString()).toBe(text)
      const gzip = await read('/vary', 'gzip')
      expect(gzip.headers['content-encoding']).toBe('gzip')
      expect(gzip.headers.vary).toBe('Origin, Accept-Encoding')
      expect(gunzipSync(gzip.body).toString()).toBe(text)
      const plain = await read('/large')
      expect(plain.headers['content-encoding']).toBeUndefined()
      expect(plain.body.toString()).toBe(text)
      const small = await read('/small', 'br')
      expect(small.headers['content-encoding']).toBeUndefined()
      expect(small.body.toString()).toBe('{"ok":true}')
      const head = await read('/large', 'br', 'HEAD')
      expect(head.headers['content-encoding']).toBeUndefined()
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})
