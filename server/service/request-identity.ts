import type { IncomingMessage } from 'node:http'

// The request guard strips the header. Only verified browser delegation survives,
// privately keyed by the admitted request; it cannot be serialized with authority.
interface VerifiedRequestIdentity { token: string; peer: string; gatewayPort?: number }
const identities = new WeakMap<IncomingMessage, VerifiedRequestIdentity>()
export function retainRequestIdentity(req: IncomingMessage, identity: VerifiedRequestIdentity | null): void {
  identities.delete(req)
  if (identity) identities.set(req, identity)
}
export function verifiedRequestIdentity(req: IncomingMessage): VerifiedRequestIdentity | null { return identities.get(req) ?? null }
