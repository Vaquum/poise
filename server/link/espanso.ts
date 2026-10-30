// Espanso match files as Poise Link sees them. Espanso runs commands from
// some match features (shell and script variables, forms, imports), so a
// desktop only ever receives plain pairs: a text `trigger`, a text `replace`
// and, optionally, a text `label`. The same judgement decides what Snippets →
// Import takes in, so everything imported also reaches the desktop.

import { createHash } from 'node:crypto'
import { parse } from 'yaml'
import { MATCH_FILE_YAML_OPTIONS, isSimpleMatch } from '../snippets'

/** The first line of the YAML Poise Link receives (and writes). */
export const LINK_HEADER = '# Managed by Poise Link. Edit snippets in Poise; changes made here are overwritten.'

const PLAIN_KEYS = new Set(['trigger', 'replace', 'label'])
const LONE_SURROGATE = /\p{Cs}/u

export interface PlainSnippet {
  trigger: string
  replace: string
  label?: string
}

export type EntryVerdict =
  | { kind: 'plain', snippet: PlainSnippet }
  | { kind: 'not_plain' | 'invalid', trigger: string | null, detail: string }

export interface MatchFile {
  /** The `matches` list, or null when the file has none. */
  matches: unknown[] | null
  /** Top-level keys other than `matches` (`global_vars`, `imports`, …). */
  otherKeys: string[]
}

/** Parses a match file the way Poise reads its own. Throws on YAML that is
 *  not one valid document. */
export function parseMatchFile(raw: string): MatchFile {
  const value: unknown = parse(raw, MATCH_FILE_YAML_OPTIONS)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { matches: null, otherKeys: [] }
  const document = value as Record<string, unknown>
  return {
    matches: Array.isArray(document.matches) ? document.matches : null,
    otherKeys: Object.keys(document).filter((key) => key !== 'matches'),
  }
}

function features(entry: Record<string, unknown>, extra: string[]): string {
  const variables = Array.isArray(entry.vars) ? entry.vars : []
  const type = (variable: unknown) => variable && typeof variable === 'object' ? (variable as { type?: unknown }).type : undefined
  if (variables.some((variable) => type(variable) === 'shell')) return 'it runs a shell command'
  if (variables.some((variable) => type(variable) === 'script')) return 'it runs a script'
  const named = extra.slice(0, 5).map((key) => key.slice(0, 40))
  return `it uses ${named.join(', ')}${extra.length > named.length ? ' and more' : ''}`
}

/** Whether one `matches` entry is a plain pair, and if not, why. */
export function judgeEntry(entry: unknown): EntryVerdict {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { kind: 'invalid', trigger: null, detail: 'it is not a trigger and replacement' }
  const fields = entry as Record<string, unknown>
  const trigger = typeof fields.trigger === 'string' ? fields.trigger : null
  const extra = Object.keys(fields).filter((key) => !PLAIN_KEYS.has(key))
  if (extra.length) return { kind: 'not_plain', trigger, detail: features(fields, extra) }
  if (trigger === null) return { kind: 'invalid', trigger, detail: 'its trigger is missing or not text' }
  if (typeof fields.replace !== 'string') return { kind: 'invalid', trigger, detail: 'its replacement is missing or not text' }
  if (fields.label !== undefined && typeof fields.label !== 'string') return { kind: 'invalid', trigger, detail: 'its label is not text' }
  const texts = [trigger, fields.replace, ...(typeof fields.label === 'string' ? [fields.label] : [])]
  if (texts.some((text) => LONE_SURROGATE.test(text))) return { kind: 'invalid', trigger, detail: 'it contains text that is not valid Unicode' }
  return { kind: 'plain', snippet: { trigger, replace: fields.replace, ...(typeof fields.label === 'string' ? { label: fields.label } : {}) } }
}

/** Every value double-quoted, escaped the way Poise Link renders its own
 *  copy, so any YAML parser reads it back as the same string. */
function quote(value: string): string {
  let out = '"'
  for (const char of value) {
    const code = char.codePointAt(0)!
    if (char === '"') out += '\\"'
    else if (char === '\\') out += '\\\\'
    else if (char === '\n') out += '\\n'
    else if (char === '\r') out += '\\r'
    else if (char === '\t') out += '\\t'
    // Other control characters, and what YAML 1.1 parsers take for line breaks.
    else if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029 || code === 0xfeff) {
      out += `\\u${code.toString(16).toUpperCase().padStart(4, '0')}`
    } else out += char
  }
  return `${out}"`
}

export function renderLinkYaml(snippets: readonly PlainSnippet[]): string {
  if (!snippets.length) return `${LINK_HEADER}\nmatches: []\n`
  let out = `${LINK_HEADER}\nmatches:\n`
  for (const snippet of snippets) {
    out += `  - trigger: ${quote(snippet.trigger)}\n    replace: ${quote(snippet.replace)}\n`
    if (snippet.label !== undefined) out += `    label: ${quote(snippet.label)}\n`
  }
  return out
}

export interface LinkSnippets {
  /** SHA-256 of `yaml`, in hex: the version and the ETag. */
  version: string
  yaml: string
}

/** What a desktop receives for the library file `raw` (null: none yet). The
 *  snippets keep the library's order, and a trigger belongs to its first
 *  entry, as in the library; an entry that is more than a plain pair, or
 *  whose trigger is blank, is left out. */
export function linkSnippetsFrom(raw: string | null): LinkSnippets {
  const snippets: PlainSnippet[] = []
  const seen = new Set<string>()
  for (const entry of raw === null ? [] : parseMatchFile(raw).matches ?? []) {
    if (!isSimpleMatch(entry) || seen.has(entry.trigger)) continue
    seen.add(entry.trigger)
    const verdict = judgeEntry(entry)
    if (verdict.kind === 'plain' && verdict.snippet.trigger.trim()) snippets.push(verdict.snippet)
  }
  const yaml = renderLinkYaml(snippets)
  return { version: createHash('sha256').update(yaml, 'utf8').digest('hex'), yaml }
}
