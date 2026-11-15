import { build } from 'esbuild'
import { buildSourceSha } from './build-identity.mjs'

// libuv's thread pool runs every asynchronous file-system call, and its
// default four threads are too few for this server: after a restart a page
// waited behind the startup's own reads, queued up to a second each. libuv
// reads the size once, when the pool first starts, so it is set on the
// bundle's first line, before any of its code runs, unless whoever started
// the process set it.
const THREADPOOL_BANNER = "process.env.UV_THREADPOOL_SIZE ??= '16';"

await build({
  entryPoints: ['server/production.ts'], bundle: true, platform: 'node',
  format: 'esm', packages: 'external', outfile: 'dist/server.js',
  define: { __POISE_BUILD_SHA__: JSON.stringify(buildSourceSha()) },
  banner: { js: THREADPOOL_BANNER },
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

await build({
  entryPoints: ['server/agent-log-worker.ts'], bundle: true, platform: 'node',
  format: 'esm', packages: 'external', outfile: 'dist/agent-log-worker.js', logLevel: 'info',
})

await build({
  entryPoints: ['server/analytics-worker.ts'], bundle: true, platform: 'node',
  format: 'esm', packages: 'external', outfile: 'dist/analytics-worker.js', logLevel: 'info',
})

await build({
  entryPoints: ['server/process-worker.ts'], bundle: true, platform: 'node',
  format: 'esm', packages: 'external', outfile: 'dist/process-worker.js', logLevel: 'info',
})

await build({
  entryPoints: ['server/datastore-reader-worker.ts'], bundle: true, platform: 'node',
  format: 'esm', packages: 'external', outfile: 'dist/datastore-reader-worker.js', logLevel: 'info',
})
