/* eslint-disable @typescript-eslint/no-require-imports -- a --require preload is CommonJS */
'use strict'
// Starts a test suite on a disposable test box instead of in this workspace, exactly as it was typed. Poise puts this
// on NODE_OPTIONS for what it starts, so every Node process asks here first, however it was reached.
// docs/Operating.md, "Agents' test suites".
const { existsSync } = require('node:fs')
const { basename, dirname, join } = require('node:path')

// Asking a runner about itself costs nothing, and needs no test box.
const PROBES = new Set(['--version', '-v', '--help', '-h'])
const SCRIPTS = /^(test|check|lint|typecheck|verify)/
// npm scripts whose files or servers are wanted here, with every step of them.
const LOCAL_SCRIPTS = /^(pre|post)?(build|start|dev|preview|prepare|install)/
const VITEST = /^(vitest|vitest\.mjs)$/

// `npm test` and `npm run NAME` name a script; the flags in front of them can carry a value.
function npmScript(args) {
  const words = []
  for (let index = 0; index < args.length && args[index] !== '--'; index += 1) {
    if (/^(--prefix|-C|--workspace|-w)$/.test(args[index])) index += 1
    else if (!args[index].startsWith('-')) words.push(args[index])
  }
  if (/^(test|t|tst)$/.test(words[0])) return 'test'
  return /^(run|run-script|rum|urn)$/.test(words[0]) ? words[1] : undefined
}

function testCommand(script, args) {
  const name = basename(script)
  if (/^(npm|npm-cli\.js)$/.test(name)) return SCRIPTS.test(npmScript(args) ?? '')
  if (args.some((arg) => PROBES.has(arg))) return false
  if (VITEST.test(name) || /^(jest|jest\.js|mocha|_mocha)$/.test(name)) return true
  // A plain tsc writes its output here, where whatever comes next needs it.
  if (/^(tsc|tsc\.js)$/.test(name)) return args.includes('--noEmit')
  if (name === 'playwright' || script.endsWith('/playwright/cli.js')) return args[0] === 'test'
  return false
}

const script = process.argv[1]
if (script && !LOCAL_SCRIPTS.test(process.env.npm_lifecycle_event ?? '') && existsSync(join(__dirname, 'relay')) && testCommand(script, process.argv.slice(2))) {
  // This Node goes along, as a box may have no other at this path. By name: its folder can hold far more than Node.
  const prefix = dirname(dirname(process.execPath))
  const node = ['bin/node', 'bin/npm', 'bin/npx', 'lib/node_modules/npm', 'lib/node_modules/corepack'].flatMap((path) => ['--also', join(prefix, path)])
  try {
    process.execve(process.execPath, [
      process.execPath, join(__dirname, 'run.mjs'), ...node, '--', process.execPath, ...process.execArgv, ...process.argv.slice(1),
    ], process.env)
  } catch (error) {
    // The suite must not run here instead.
    process.stderr.write(`[poise] cannot start the test box: ${error.message}\n`)
    process.exit(125)
  }
}

module.exports = { npmScript, testCommand }
