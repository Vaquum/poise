import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

function tsconfig(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'))
}

describe('Tool CPU caches', () => {
  it('keeps the three typechecks incremental on distinct checkout-local build-info files', () => {
    const client = tsconfig('tsconfig.json')
    const server = tsconfig('tsconfig.server.json')
    const tests = tsconfig('tsconfig.tests.json')
    expect(client.compilerOptions?.incremental).toBe(true)
    for (const [name, config] of [['tsconfig.server.json', server], ['tsconfig.tests.json', tests]] as const) {
      expect(config.compilerOptions?.incremental ?? true, name).toBe(true)
    }
    const paths = [client, server, tests].map((config) => config.compilerOptions?.tsBuildInfoFile)
    for (const [name, path] of [['tsconfig.json', paths[0]], ['tsconfig.server.json', paths[1]], ['tsconfig.tests.json', paths[2]]] as const) {
      expect(typeof path, `${name} names its build-info file`).toBe('string')
      expect(path, name).toMatch(/^node_modules\/\.cache\//)
      expect(path, `${name} keeps build info out of production output`).not.toContain('dist')
    }
    expect(new Set(paths).size).toBe(3)
    // The cache changes nothing about what the typechecks accept.
    expect(client.compilerOptions?.strict).toBe(true)
  })

  it('caches lint by content and keeps an uncached invocation', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
    expect(pkg.scripts.lint).toContain('--cache')
    expect(pkg.scripts.lint).toContain('--cache-location node_modules/.cache/')
    expect(pkg.scripts['lint:uncached']).toBeDefined()
    expect(pkg.scripts['lint:uncached']).not.toContain('--cache')
    expect(pkg.scripts['typecheck:uncached']).toContain('--incremental false')
  })

  it('refuses content caching once lint rules need compiler type information', () => {
    // ESLint's cache key does not track cross-module or type dependencies,
    // so the cached lint invocation is only valid while the config stays
    // free of type-aware rules. Anyone adding one must revisit the cache.
    const config = readFileSync('eslint.config.js', 'utf8')
    for (const marker of ['TypeChecked', 'typeChecked', 'projectService', 'project:']) {
      expect(config, `ESLint content caching is unsafe with ${marker}`).not.toContain(marker)
    }
  })

  it('keeps caches out of git and the Docker build context', () => {
    expect(readFileSync('.gitignore', 'utf8')).toMatch(/^node_modules\/$/m)
    expect(readFileSync('.dockerignore', 'utf8')).toMatch(/^.*node_modules.*$/m)
  })

  it('ships a match-preserving two-thread ripgrep default for agent tools', () => {
    const lines = readFileSync('scripts/agent-tools.ripgreprc', 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
    expect(lines).toEqual(['--threads=2'])
  })
})
