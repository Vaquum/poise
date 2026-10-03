/** Every value sent for a cookie name, in header order; a browser may send the same name more than once. */
export function cookieValues(header: string | undefined, name: string): string[] {
  const values: string[] = []
  for (const part of (header ?? '').split(';')) {
    const separator = part.indexOf('=')
    if (separator > 0 && part.slice(0, separator).trim() === name) values.push(part.slice(separator + 1).trim())
  }
  return values
}

/** The Cookie header without the named cookies, or undefined when nothing else is left. */
export function withoutCookies(header: string | undefined, names: ReadonlySet<string>): string | undefined {
  const kept = (header ?? '').split(';').map((part) => part.trim()).filter((part) => {
    if (!part) return false
    const separator = part.indexOf('=')
    return !names.has(separator < 0 ? part : part.slice(0, separator).trim())
  })
  return kept.length > 0 ? kept.join('; ') : undefined
}

export interface CookieOptions {
  maxAgeSeconds: number
  secure: boolean
  path?: string
  /** Shares the cookie with every subdomain; without it the cookie is host-only. */
  domain?: string
}

/** An HttpOnly, SameSite=Lax cookie; host-only unless a domain is given, Secure unless plain-http mode is on. */
export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  return [
    `${name}=${value}`,
    ...(options.domain ? [`Domain=${options.domain}`] : []),
    `Path=${options.path ?? '/'}`,
    `Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(options.secure ? ['Secure'] : []),
  ].join('; ')
}
