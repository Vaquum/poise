import { describe, expect, it } from 'vitest'
import { qrCode, qrSvg, type QrMatrix } from '../src/ui/qr'

// Reference codes from Project Nayuki's QR Code generator (Python `qrcodegen`, level M, byte mode, its
// mask choice), each row as hex with trailing zero bits. Phone sign-in shows a version 4 link like the
// second; the third covers version information and three alignment patterns.
const REFERENCE: Array<[string, string[]]> = [
  ['HELLO WORLD', ['fecbf8', '821208', 'ba52e8', 'ba92e8', 'baeae8', '829208', 'feabf8', '009800', '8bf7c8', '10b878', '3f3690', 'f8c400', 'faab30', '00af58', 'feead0', '825d98', 'bad630', 'ba48d8', 'ba71c0', '821400', 'feffa8']],
  [`https://poise.test/auth/phone?t=${'Q'.repeat(22)}`, ['fea101bf8', '8260b0208', 'ba4d6dae8', 'ba8b6dae8', 'bac2162e8', '82c096208', 'feaaaabf8', '00c3c7000', '8b8856fc8', '04bda3468', '9ba9cf850', 'e5a264410', '730732358', '49f4f2320', 'a61acde90', '352e47780', 'bfdb7e2f0', '8449e1068', '52cf2f950', '45b21d510', '8adb83340', 'd07872330', '3a232d890', '1dc7e5188', 'd3845efe8', '00c78a8a0', 'fea9c6ac0', '823fec880', 'ba8932fc8', 'ba42933a0', 'ba3ccab80', '827044000', 'fe9f57a68']],
  ['v'.repeat(122), ['fe25515e8bf8', '8220efe55208', 'baf4904fd2e8', 'bae6fba11ae8', 'bab7dfdebae8', '82bce8e50208', 'feaaaaaaabf8', '00d388cf9800', 'be12ffa173e0', '641bd15e9df8', '22fcffe52610', '787b904f9ce8', '46faeba17250', '5812515e9df8', '22f37fe52610', '94c3904f9ce8', 'f27ceba17250', 'e9f2515e9df8', 'a6727fe52610', '2140904f9ce8', '3ff26fa17fd0', '08f658de98f8', '0a8cfae53a90', '18f888cf88e8', '7fe03fa16fd0', '04d43bde9278', '0b3cc1652590', '1020bfcf9668', '5339c8216cc8', '05ad1bde9278', 'dba9e1652590', 'a1039fcf9668', '1f1a68216cd0', 'b1af3bde9278', '0baae1652590', '79049fcf9668', '9b89efa16fd0', '00afb8de88f8', 'fe11dae53a90', '82bd78cf98e8', 'ba97afa16fd0', 'bac9c85e94f8', 'baf1b3e53a10', '821d794f85e0', 'fe8f37a17e50']],
]

function hexRows(matrix: QrMatrix): string[] {
  return matrix.map((row) => {
    const bits = row.map((dark) => (dark ? '1' : '0')).join('')
    const padded = bits.padEnd(Math.ceil(bits.length / 4) * 4, '0')
    return BigInt(`0b${padded}`).toString(16).padStart(padded.length / 4, '0')
  })
}

describe('the QR code for signing in on a phone', () => {
  it('matches the reference encoder module for module', () => {
    for (const [text, rows] of REFERENCE) expect(hexRows(qrCode(text)), text.slice(0, 20)).toEqual(rows)
  })

  it('takes the smallest version that holds the text, and refuses more than a version 10 holds', () => {
    expect(qrCode('x'.repeat(14))).toHaveLength(21)
    expect(qrCode('x'.repeat(15))).toHaveLength(25)
    expect(qrCode('u'.repeat(213))).toHaveLength(57)
    expect(() => qrCode('u'.repeat(214))).toThrow('holds at most 213')
    expect(() => qrCode('x', 8)).toThrow('There is no QR mask 8.')
  })

  it('draws dark modules in the text colour inside a four-module quiet zone', () => {
    const matrix = qrCode('HELLO WORLD')
    const svg = qrSvg(matrix, 'A "code" & more')
    expect(svg).toContain('viewBox="0 0 29 29"')
    expect(svg).toContain('fill="currentColor"')
    expect(svg).toContain('aria-label="A &quot;code&quot; &amp; more"')
    expect(svg.match(/h1v1h-1z/g)).toHaveLength(matrix.flat().filter(Boolean).length)
    expect(svg).toContain('M4 4h1v1h-1z')
  })
})
