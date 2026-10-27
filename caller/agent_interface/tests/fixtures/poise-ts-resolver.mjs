// Lets Node's type-stripping loader follow Poise's extensionless TypeScript
// imports (`from './worker'`) without touching Poise's source.
import { register } from 'node:module'
register('data:text/javascript,' + encodeURIComponent(`
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('.') && !/\\.[cm]?[jt]s$/.test(specifier) && context.parentURL) {
    const base = new URL(specifier, context.parentURL).href
    for (const ext of ['.ts', '.mts']) {
      if (existsSync(fileURLToPath(base + ext))) return next(base + ext, context)
    }
  }
  return next(specifier, context)
}`))
