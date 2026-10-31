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

  it('rejects files larger than the editor document limit', () => {
    const oversized = new ArrayBuffer(IMPORT_MAX_BYTES + 1)
    expect(() => decodeMarkdownImport(oversized)).toThrow(/smaller than 5 MiB/)
  })

  it('rejects bytes that are not valid UTF-8', () => {
    const invalid = new Uint8Array([0xff, 0xfe, 0x00]).buffer as ArrayBuffer
    expect(() => decodeMarkdownImport(invalid)).toThrow(/UTF-8/)
  })
})
