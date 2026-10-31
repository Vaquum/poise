import { describe, expect, it } from 'vitest'
import { decodeMarkdownImport, IMPORT_MAX_BYTES } from '../src/views/editor-view'

describe('decodeMarkdownImport', () => {
  it('loads markdown bytes verbatim', () => {
    const source = '# Title\n\nSome **bold** text and `code`.\n'
    const decoded = decodeMarkdownImport(new TextEncoder().encode(source).buffer as ArrayBuffer)
    expect(decoded).toBe(source)
  })

  it('accepts an empty file', () => {
    expect(decodeMarkdownImport(new ArrayBuffer(0))).toBe('')
  })

  it('normalizes CRLF and lone-CR line endings to LF', () => {
    const decoded = decodeMarkdownImport(new TextEncoder().encode('# T\r\n\r\n```\r\ncode\r\n```\r\n').buffer as ArrayBuffer)
    expect(decoded).toBe('# T\n\n```\ncode\n```\n')
    const lone = decodeMarkdownImport(new TextEncoder().encode('a\rb').buffer as ArrayBuffer)
    expect(lone).toBe('a\nb')
  })

  it('rejects files larger than the editor document limit', () => {
    const oversized = new ArrayBuffer(IMPORT_MAX_BYTES + 1)
    expect(() => decodeMarkdownImport(oversized)).toThrow(/smaller than 5 MiB/)
  })

  it('rejects bytes that are not valid UTF-8', () => {
    const invalid = new Uint8Array([0xff, 0xfe, 0x00]).buffer as ArrayBuffer
    expect(() => decodeMarkdownImport(invalid)).toThrow(/UTF-8/)
  })
})
