import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { loadConfig } from './config.js'
import { installPublicPages, parsePublicPages, PUBLIC_PAGES_LIMIT } from './public-pages.js'

async function main(): Promise<void> {
  const action = process.argv[2]
  if (!['validate', 'install'].includes(action ?? '') || process.argv.length !== 3) throw new Error('Usage: public-pages-cli.js validate|install < reviewed-public-pages.json')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > PUBLIC_PAGES_LIMIT) throw new Error('Public pages exceed 128 KiB.')
    chunks.push(bytes)
  }
  const input = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
  parsePublicPages(input)
  if (action === 'validate') { process.stdout.write('Public pages are valid. Review the content before publishing.\n'); return }
  const config = loadConfig(process.env)
  installPublicPages(config.dataDir, input)
  const scheme = config.insecureHttp ? 'http' : 'https'
  process.stdout.write(`Installed operator-approved public pages. Restart the gateway to serve ${scheme}://${config.domain}/privacy and /terms.\n`)
}

if (process.argv[1] && pathToFileURL(realpathSync(resolve(process.argv[1]))).href === import.meta.url) {
  main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : 'Public page setup failed.'}\n`); process.exitCode = 1 })
}
