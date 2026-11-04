/* eslint-disable @typescript-eslint/no-require-imports -- a --require preload is CommonJS */
'use strict'
// In a workspace, starts a test suite on a disposable test instance instead. On a test instance, fits a
// whole-suite command to it. Poise puts this on NODE_OPTIONS for what it starts, so every Node process
// asks here first, however it was reached. docs/Operating.md, "Agents' test suites".
const { existsSync } = require('node:fs')
const { basename, join } = require('node:path')

// Asking a runner about itself costs nothing, and needs no test instance.
const PROBES = new Set(['--version', '-v', '--help', '-h'])
const SCRIPTS = /^(test|check|lint|typecheck|verify)/
// npm scripts whose files or servers are wanted here, with every step of them.
const LOCAL_SCRIPTS = /^(pre|post)?(build|start|dev|preview|prepare|install)/
const VITEST = /^(vitest|vitest\.mjs)$/
const VITEST_COMMANDS = new Set(['run', 'watch', 'dev'])
const VITEST_VALUE_FLAGS = new Set(['--config', '-c', '--root', '-r', '--dir', '--project', '--reporter', '--pool', '--shard',
  '--outputFile', '--environment', '--mode', '-m', '--maxWorkers', '--minWorkers', '--testTimeout'])

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

/** What a vitest command should add on a test instance: one worker always, and the change's tests for a whole suite. */
function vitestFlags(args, since) {
  const flags = args.some((arg) => arg.startsWith('--maxWorkers')) ? [] : ['--maxWorkers=1']
  let chosen = args.some((arg) => /^(--changed|--testNamePattern|-t)/.test(arg))
  for (let index = 0; index < args.length; index += 1) {
    if (VITEST_VALUE_FLAGS.has(args[index])) index += 1
    else if (!args[index].startsWith('-') && !VITEST_COMMANDS.has(args[index])) chosen = true
  }
  return chosen || !since ? flags : [...flags, `--changed=${since}`, '--passWithNoTests']
}

const script = process.argv[1]
const since = process.env.POISE_TEST_CHANGED_SINCE
if (script && process.env.POISE_TEST_INSTANCE === '1') {
  const args = process.argv.slice(2)
  if (/^(npm|npm-cli\.js)$/.test(basename(script)) && /^build/.test(npmScript(args) ?? '')) {
    // A step of something like `npm run check`: too big for an instance, and its files would go with it.
    process.stderr.write('[poise] skipping this build on the test instance. CI builds before merge.\n')
    process.exit(0)
  }
  if (VITEST.test(basename(script)) && !args.some((arg) => PROBES.has(arg))) {
    const flags = vitestFlags(args, since)
    process.argv.push(...flags)
    if (flags.some((flag) => flag.startsWith('--changed'))) {
      process.stderr.write('[poise] running only the tests this change touches. CI is the gate before merge.\n')
    }
    // What this runs in its turn is the suite's own business.
    delete process.env.POISE_TEST_INSTANCE
  }
} else if (script && !LOCAL_SCRIPTS.test(process.env.npm_lifecycle_event ?? '') && existsSync(join(__dirname, 'relay')) && testCommand(script, process.argv.slice(2))) {
  try {
    process.execve(process.execPath, [
      process.execPath, join(__dirname, 'run.mjs'), '--', process.execPath, ...process.execArgv, ...process.argv.slice(1),
    ], process.env)
  } catch (error) {
    // The suite must not run here instead.
    process.stderr.write(`[poise] cannot start the test instance: ${error.message}\n`)
    process.exit(125)
  }
}

module.exports = { npmScript, testCommand, vitestFlags }
