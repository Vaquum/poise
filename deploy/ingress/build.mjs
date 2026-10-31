import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
const require = createRequire(new URL('../../gateway/package.json', import.meta.url))
const { build } = require('esbuild')
await build({ entryPoints: [fileURLToPath(new URL('./projection.ts', import.meta.url))], outfile: resolve(process.argv[2] ?? 'test-results/ingress/projection.cjs'), bundle: true,
  platform: 'node', target: 'node12', format: 'cjs', alias: { 'node:net': 'net', 'node:path': 'path', 'node:buffer': 'buffer' } })
