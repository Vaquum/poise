import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// The token contract of the new interface (#556), ported from the mocks'
// tools/lint_tokens.py. tokens.css is the only file under src/ui that holds raw
// values; every other stylesheet, and every style= string built in TypeScript,
// uses semantic tokens only:
//   1. no raw colours (hex, rgb/hsl, named colours)
//   2. no raw lengths or durations (px, rem, em, ms, s); 0, %, fr, vw/vh and deg are fine
//   3. font-weight and line-height come from --fw-* and --lh-*
//   4. never read controls (--ctl-*) or primitives (--p-*) directly
//   5. every var(--name) is defined in tokens.css or in the same file
//   6. inline styles carry data only: custom properties set to numbers or %
//   7. SVG markup uses currentColor, never a raw colour
//   8. no <style> blocks: styles live in the linted stylesheets

const ROOT = 'src/ui'
const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name)
  return statSync(path).isDirectory() ? walk(path) : [path]
})
const NAMED = /\b(white|black|red|green|blue|gray|grey|orange|yellow|purple|pink|silver|navy|teal|maroon|olive|lime|aqua|fuchsia)\b/
const UNIT = /(?<![\w.-])(-?\d*\.?\d+)(px|rem|em|ms|s)\b/
const HEX = /#[0-9a-fA-F]{3,8}\b/
const FUNC = /\b(rgba?|hsla?)\(/
const VAR = /var\(\s*(--[\w-]+)/g
const DATA = /^(-?\d*\.?\d+|\$\{[^}]*\})%?$/

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')
const definedTokens = (css: string) => new Set([...stripComments(css).matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]))

/** [property, value] for every declaration in an innermost block. */
function declarations(source: string): [string, string][] {
  const css = stripComments(source)
  const out: [string, string][] = []
  let start = 0
  for (let i = 0; i < css.length; i++) {
    if (css[i] === '{') start = i + 1
    else if (css[i] === '}') {
      const block = css.slice(start, i)
      if (!block.includes('{')) {
        for (const part of block.split(';')) {
          const at = part.indexOf(':')
          if (at > 0) out.push([part.slice(0, at).trim(), part.slice(at + 1).trim()])
        }
      }
      start = i + 1
    }
  }
  return out
}

function checkValue(prop: string, value: string, local: Set<string>, tokens: Set<string>): string[] {
  if (prop.startsWith('--') && local.has(prop) && /^-?\d*\.?\d+%?$/.test(value)) return []
  const problems: string[] = []
  const bare = value.replace(/var\([^)]*\)/g, 'VAR')
  if (HEX.test(bare)) problems.push('raw colour')
  if (FUNC.test(bare)) problems.push('raw colour function')
  if (NAMED.test(bare) && !['content', 'grid-template-areas', 'grid-area'].includes(prop)) problems.push('named colour')
  if (UNIT.test(bare) && prop !== 'content') problems.push('raw length or duration')
  if (prop === 'font-weight' && !value.startsWith('var(--fw-') && value !== 'inherit') problems.push('font-weight must use --fw-*')
  if (prop === 'line-height' && !value.startsWith('var(--lh-') && !['inherit', '0'].includes(value)) problems.push('line-height must use --lh-*')
  for (const [, name] of value.matchAll(VAR)) {
    if (name.startsWith('--ctl-') || name.startsWith('--p-')) problems.push(`reads ${name} directly`)
    else if (!tokens.has(name) && !local.has(name)) problems.push(`undefined token ${name}`)
  }
  return problems
}

describe('the new interface keeps its token contract', () => {
  const files = walk(ROOT)
  const tokens = definedTokens(readFileSync(join(ROOT, 'tokens.css'), 'utf8'))

  it('finds no raw values in its stylesheets outside tokens.css', () => {
    const problems: string[] = []
    for (const file of files.filter((f) => f.endsWith('.css') && !f.endsWith('tokens.css'))) {
      const css = readFileSync(file, 'utf8')
      const local = definedTokens(css)
      for (const [prop, value] of declarations(css)) {
        for (const problem of checkValue(prop, value, local, tokens)) problems.push(`${file}: ${problem}: ${prop}: ${value}`.slice(0, 200))
      }
    }
    expect(problems).toEqual([])
  })

  it('builds only data into inline styles, and no style blocks or raw SVG colours', () => {
    const problems: string[] = []
    for (const file of [...files.filter((f) => f.endsWith('.ts')), 'ui.html']) {
      const source = readFileSync(file, 'utf8')
      for (const [, style] of source.matchAll(/style="([^"]*)"/g)) {
        for (const declaration of style.split(';').map((d) => d.trim()).filter(Boolean)) {
          const at = declaration.indexOf(':')
          const prop = declaration.slice(0, at).trim(), value = declaration.slice(at + 1).trim()
          if (!(prop.startsWith('--') && DATA.test(value))) problems.push(`${file}: inline style is not data: ${declaration}`)
        }
      }
      if (/<style[\s>]/.test(source)) problems.push(`${file}: style block`)
      for (const [match] of source.matchAll(/\b(fill|stroke|stop-color)="(#[0-9a-fA-F]{3,8}|rgb[^"]*)"/g)) problems.push(`${file}: raw colour in SVG: ${match}`)
    }
    expect(problems).toEqual([])
  })
})
