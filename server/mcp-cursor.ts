import { createHmac, timingSafeEqual } from 'node:crypto'
import type { McpGrantScope } from '../gateway/src/mcp-contract'
import { HttpError } from './http'

/** Authenticates a cursor to one resource, owner grant and typed selector. */
export function mcpCursor(grant: McpGrantScope, selector: readonly unknown[]) {
  const scope = JSON.stringify([grant.resource, grant.ownerId, grant.handle, ...selector])
  function signature(payload: string): Buffer {
    return createHmac('sha256', grant.grantId).update(scope).update(payload).digest()
  }
  return {
    encode(value: unknown): string {
      const payload = Buffer.from(JSON.stringify(value)).toString('base64url')
      return `${payload}.${signature(payload).toString('base64url')}`
    },
    decode(cursor: string): unknown {
      try {
        if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(cursor)) throw new Error('encoding')
        const [payload, encoded] = cursor.split('.')
        const actual = Buffer.from(encoded, 'base64url')
        const expected = signature(payload)
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('signature')
        return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown
      } catch {
        throw new HttpError(400, 'invalid cursor for this grant and selector')
      }
    },
  }
}
