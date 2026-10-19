import { build } from 'esbuild'
import { buildSourceSha } from './build-identity.mjs'

await build({
  entryPoints: ['server/production.ts'], bundle: true, platform: 'node',
  format: 'esm', packages: 'external', outfile: 'dist/server.js',
  define: { __POISE_BUILD_SHA__: JSON.stringify(buildSourceSha()) },
  logLevel: 'info',
})


await build({
  entryPoints: ['server/runtime-diagnostic.ts'], bundle: true, platform: 'node',
  format: 'esm', packages: 'external', outfile: 'dist/runtime-diagnostic.js', logLevel: 'info',
})

await build({
  entryPoints: ['gateway/src/diagnostics/query-worker.ts'], bundle: true, platform: 'node',
  format: 'esm', packages: 'external', outfile: 'dist/query-worker.js', logLevel: 'info',
})

await build({
  entryPoints: ['server/behavior-ledger-cli.ts'], bundle: true, platform: 'node',
  format: 'esm', packages: 'external', outfile: 'dist/behavior-ledger.js', logLevel: 'info',
})

await build({
  entryPoints: ['server/behavior-ledger-worker.ts'], bundle: true, platform: 'node',
  format: 'esm', packages: 'external', outfile: 'dist/behavior-ledger-worker.js', logLevel: 'info',
})
