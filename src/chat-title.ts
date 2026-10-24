// Chat session auto-titles: what a chat is called before the person names it.
// The server derives the title from the first message when the first turn
// starts; the browser previews the same derivation optimistically. Kept free
// of runtime imports so both sides and node unit tests share it.

/** A `owner/repo#number` reference or its github.com URL in a message. `index`
 *  and `length` locate it in the searched text, so derivation can remove it. */
export interface IssueReference {
  owner: string
  repo: string
  number: number
  /** Which view holds it when the reference says so; a bare `#number` or
   *  `owner/repo#number` does not. */
  kind: 'issue' | 'pull' | 'unknown'
  index: number
  length: number
}

const OWNER = '[A-Za-z0-9][A-Za-z0-9-]{0,38}'
const NAME = '[A-Za-z0-9_.-]+?'

/** The earliest GitHub issue or PR reference in `text`: a github.com URL, an
 *  `owner/repo#number`, or a bare `#number` when `repo` says which
 *  `owner/name` it belongs to. */
export function parseIssueReference(text: string, repo?: string): IssueReference | null {
  const found: IssueReference[] = []
  const url = new RegExp(`\\b(?:https?:\\/\\/)?github\\.com\\/(${OWNER})\\/(${NAME})\\/(issues|pull)\\/(\\d+)\\b`).exec(text)
  if (url) {
    found.push({ owner: url[1], repo: url[2].replace(/\.+$/, ''), number: Number(url[4]),
      kind: url[3] === 'pull' ? 'pull' : 'issue', index: url.index, length: url[0].length })
  }
  const full = new RegExp(`(?:^|[^\\w/.-])(${OWNER})\\/(${NAME})#(\\d+)\\b`).exec(text)
  if (full) {
    // The separator is one non-word character; an owner always starts with a word one.
    const sep = /^\w/.test(full[0]) ? 0 : 1
    found.push({ owner: full[1], repo: full[2].replace(/\.+$/, ''), number: Number(full[3]),
      kind: 'unknown', index: full.index + sep, length: full[0].length - sep })
  }
  const context = repo && new RegExp(`^(${OWNER})\\/([A-Za-z0-9_.-]+)$`).exec(repo)
  if (context) {
    const bare = /(?:^|[^\w#])#(\d+)\b/.exec(text)
    if (bare) {
      const hash = bare.index + bare[0].indexOf('#')
      found.push({ owner: context[1], repo: context[2], number: Number(bare[1]),
        kind: 'unknown', index: hash, length: bare[0].length - (hash - bare.index) })
    }
  }
  found.sort((a, b) => a.index - b.index)
  return found[0] || null
}

// A Conventional Commits type, with an optional scope, before the title's own
// words. Only known types strip: "Note: …" is a title, not a prefix.
const TYPE_PREFIX = /^(?:feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]*\))?!?:\s+/i

/** The item's own words: "feat: Let it land" reads "Let it land". */
export function stripTypePrefix(title: string): string {
  return title.replace(TYPE_PREFIX, '')
}

// Parens stay outside the match, so "(https://…/446)" leaves "()" behind.
const URL_PATTERN = /\bhttps?:\/\/[^\s()]+/g
const REPO_PATTERN = new RegExp(`\\b${OWNER}\\/[A-Za-z0-9_.-]+`, 'g')
const LEADING_BOILERPLATE = /^(?:task(?=[\s:,-]|$)[\s:,-]*|could you take this task\?\s*|implement(?:\s+|$)|continue(?:\s+|$))/i
const LEADING_PUNCT = /^[:,\-–—;]+\s*/

/** The first sentence of a message's first line, without URLs, repository
 *  refs or delegation boilerplate. Empty when nothing readable remains. */
export function stripBoilerplate(sentence: string): string {
  let out = sentence.replace(URL_PATTERN, '').replace(REPO_PATTERN, '').replace(/\(\s*\)/g, '')
  for (;;) {
    const next = out.replace(LEADING_BOILERPLATE, '').replace(LEADING_PUNCT, '').trim()
    if (next === out.trim()) { out = next; break }
    out = next
  }
  return out.replace(/\s+/g, ' ').replace(/[\s:,\-–—;]+$/, '').trim()
}

export interface DeriveOptions {
  /** The session's `owner/name`, resolving a bare `#number`. */
  repo?: string
  /** The referenced item's title, when a lookup resolved it. */
  issueTitle?: string | null
}

/** The automatic name for a chat whose first message is `text`: the
 *  referenced item's title without its type prefix plus the number when the
 *  item is known, else the first sentence with boilerplate removed. Falls
 *  back to the raw first line, so text always names something. */
export function deriveSessionTitle(text: string, opts: DeriveOptions = {}): string {
  const line = text.split('\n')[0] ?? ''
  const ref = parseIssueReference(line, opts.repo)
  const resolved = opts.issueTitle?.trim()
  if (ref && resolved) return `#${ref.number} ${stripTypePrefix(resolved)}`
  const withoutRef = ref ? line.slice(0, ref.index) + ' ' + line.slice(ref.index + ref.length) : line
  const stripped = stripBoilerplate(withoutRef)
  const end = /[.!?](\s|$)/.exec(stripped)
  const sentence = (end ? stripped.slice(0, end.index) : stripped).trim()
  if (ref) return sentence ? `#${ref.number} ${sentence}` : `#${ref.number}`
  return sentence || line.trim()
}

/** Whether the first turn may name the chat: never a hand-set name, a change
 *  session titled by its request, an internal turn, or the Manager. */
export function shouldAutoName(
  record: { title: string, titleManual?: boolean, selfChangeId?: string, role?: 'manager' | 'worker', contextResetSeq?: number },
  isFirst: boolean,
  internal: boolean,
): boolean {
  if (record.titleManual || record.selfChangeId || internal || record.role === 'manager') return false
  return record.title === 'New session' || (isFirst && !record.contextResetSeq)
}
