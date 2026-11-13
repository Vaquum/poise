// A QR code (ISO/IEC 18004, model 2) for the phone sign-in link in Settings → Accounts: byte mode,
// error correction level M, the smallest of versions 1 to 10 that holds the text, and the mask with the
// lowest penalty. The method follows Project Nayuki's QR Code generator (MIT). Written out here
// because one link is all Poise draws, and a dependency for it would be larger than this.

// Versions 1 to 10 at level M; index 0 is unused. A version 10 code holds 213 bytes.
const ECC_CODEWORDS_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26]
const ERROR_CORRECTION_BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5]
const MAX_VERSION = 10
// Level M's two format bits.
const LEVEL_M = 0
const PENALTY_N1 = 3
const PENALTY_N2 = 3
const PENALTY_N3 = 40
const PENALTY_N4 = 10

/** A QR code's modules, `true` for dark, row by row; `modules[y][x]`. */
export type QrMatrix = boolean[][]

function bit(value: number, index: number): boolean {
  return ((value >>> index) & 1) !== 0
}

function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64
  if (version >= 2) {
    const alignments = Math.floor(version / 7) + 2
    result -= (25 * alignments - 10) * alignments - 55
    if (version >= 7) result -= 36
  }
  return result
}

function dataCodewords(version: number): number {
  return Math.floor(rawDataModules(version) / 8) - ECC_CODEWORDS_PER_BLOCK[version] * ERROR_CORRECTION_BLOCKS[version]
}

function multiply(x: number, y: number): number {
  let z = 0
  for (let index = 7; index >= 0; index -= 1) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> index) & 1) * x
  }
  return z
}

function reedSolomonDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0)
  result[degree - 1] = 1
  let root = 1
  for (let index = 0; index < degree; index += 1) {
    for (let j = 0; j < result.length; j += 1) {
      result[j] = multiply(result[j], root)
      if (j + 1 < result.length) result[j] ^= result[j + 1]
    }
    root = multiply(root, 0x02)
  }
  return result
}

function reedSolomonRemainder(data: number[], divisor: number[]): number[] {
  const result = divisor.map(() => 0)
  for (const byte of data) {
    const factor = byte ^ (result.shift() ?? 0)
    result.push(0)
    divisor.forEach((coefficient, index) => { result[index] ^= multiply(coefficient, factor) })
  }
  return result
}

/** The data codewords for `bytes` in byte mode: mode, count, data, terminator and padding. */
function encodeData(bytes: Uint8Array, version: number): number[] {
  const bits: boolean[] = []
  const append = (value: number, length: number) => {
    for (let index = length - 1; index >= 0; index -= 1) bits.push(bit(value, index))
  }
  append(0b0100, 4)
  append(bytes.length, version <= 9 ? 8 : 16)
  for (const byte of bytes) append(byte, 8)
  const capacity = dataCodewords(version) * 8
  append(0, Math.min(4, capacity - bits.length))
  append(0, (8 - (bits.length % 8)) % 8)
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) append(pad, 8)
  const codewords: number[] = []
  for (let index = 0; index < bits.length; index += 8) {
    let byte = 0
    for (let offset = 0; offset < 8; offset += 1) byte = (byte << 1) | (bits[index + offset] ? 1 : 0)
    codewords.push(byte)
  }
  return codewords
}

/** Splits the data into blocks, adds each block's error correction and interleaves them all. */
function withErrorCorrection(data: number[], version: number): number[] {
  const blocks = ERROR_CORRECTION_BLOCKS[version]
  const eccLength = ECC_CODEWORDS_PER_BLOCK[version]
  const raw = Math.floor(rawDataModules(version) / 8)
  const shortBlocks = blocks - (raw % blocks)
  const shortLength = Math.floor(raw / blocks)
  const divisor = reedSolomonDivisor(eccLength)
  const all: number[][] = []
  for (let index = 0, offset = 0; index < blocks; index += 1) {
    const block = data.slice(offset, offset + shortLength - eccLength + (index < shortBlocks ? 0 : 1))
    offset += block.length
    const ecc = reedSolomonRemainder(block, divisor)
    if (index < shortBlocks) block.push(0)
    all.push([...block, ...ecc])
  }
  const result: number[] = []
  for (let index = 0; index < all[0].length; index += 1) {
    all.forEach((block, j) => {
      if (index !== shortLength - eccLength || j >= shortBlocks) result.push(block[index])
    })
  }
  return result
}

class Grid {
  readonly size: number
  readonly modules: boolean[][]
  readonly reserved: boolean[][]

  constructor(readonly version: number) {
    this.size = version * 4 + 17
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false))
    this.reserved = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false))
  }

  set(x: number, y: number, dark: boolean): void {
    this.modules[y][x] = dark
    this.reserved[y][x] = true
  }

  drawFunctionPatterns(): void {
    for (let index = 0; index < this.size; index += 1) {
      this.set(6, index, index % 2 === 0)
      this.set(index, 6, index % 2 === 0)
    }
    this.drawFinder(3, 3)
    this.drawFinder(this.size - 4, 3)
    this.drawFinder(3, this.size - 4)
    const positions = this.alignmentPositions()
    const last = positions.length - 1
    positions.forEach((x, i) => positions.forEach((y, j) => {
      if (!((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0))) this.drawAlignment(x, y)
    }))
    this.drawFormat(0)
    this.drawVersion()
  }

  private drawFinder(cx: number, cy: number): void {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy))
        const x = cx + dx
        const y = cy + dy
        if (x >= 0 && x < this.size && y >= 0 && y < this.size) this.set(x, y, distance !== 2 && distance !== 4)
      }
    }
  }

  private drawAlignment(cx: number, cy: number): void {
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) this.set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
    }
  }

  private alignmentPositions(): number[] {
    if (this.version === 1) return []
    const count = Math.floor(this.version / 7) + 2
    const step = Math.ceil((this.version * 4 + 4) / (count * 2 - 2)) * 2
    const result = [6]
    for (let position = this.size - 7; result.length < count; position -= step) result.splice(1, 0, position)
    return result
  }

  drawFormat(mask: number): void {
    const data = (LEVEL_M << 3) | mask
    let remainder = data
    for (let index = 0; index < 10; index += 1) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537)
    const bits = ((data << 10) | remainder) ^ 0x5412
    for (let index = 0; index <= 5; index += 1) this.set(8, index, bit(bits, index))
    this.set(8, 7, bit(bits, 6))
    this.set(8, 8, bit(bits, 7))
    this.set(7, 8, bit(bits, 8))
    for (let index = 9; index < 15; index += 1) this.set(14 - index, 8, bit(bits, index))
    for (let index = 0; index < 8; index += 1) this.set(this.size - 1 - index, 8, bit(bits, index))
    for (let index = 8; index < 15; index += 1) this.set(8, this.size - 15 + index, bit(bits, index))
    this.set(8, this.size - 8, true)
  }

  private drawVersion(): void {
    if (this.version < 7) return
    let remainder = this.version
    for (let index = 0; index < 12; index += 1) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25)
    const bits = (this.version << 12) | remainder
    for (let index = 0; index < 18; index += 1) {
      const a = this.size - 11 + (index % 3)
      const b = Math.floor(index / 3)
      this.set(a, b, bit(bits, index))
      this.set(b, a, bit(bits, index))
    }
  }

  drawCodewords(codewords: number[]): void {
    let index = 0
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5
      for (let vertical = 0; vertical < this.size; vertical += 1) {
        for (let j = 0; j < 2; j += 1) {
          const x = right - j
          const upward = ((right + 1) & 2) === 0
          const y = upward ? this.size - 1 - vertical : vertical
          if (!this.reserved[y][x] && index < codewords.length * 8) {
            this.modules[y][x] = bit(codewords[index >>> 3], 7 - (index & 7))
            index += 1
          }
        }
      }
    }
  }

  applyMask(mask: number): void {
    for (let y = 0; y < this.size; y += 1) {
      for (let x = 0; x < this.size; x += 1) {
        if (this.reserved[y][x]) continue
        const invert = mask === 0 ? (x + y) % 2 === 0
          : mask === 1 ? y % 2 === 0
            : mask === 2 ? x % 3 === 0
              : mask === 3 ? (x + y) % 3 === 0
                : mask === 4 ? (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0
                  : mask === 5 ? ((x * y) % 2) + ((x * y) % 3) === 0
                    : mask === 6 ? (((x * y) % 2) + ((x * y) % 3)) % 2 === 0
                      : (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
        if (invert) this.modules[y][x] = !this.modules[y][x]
      }
    }
  }

  penalty(): number {
    let result = 0
    const line = (at: (index: number) => boolean) => {
      let runDark = false
      let run = 0
      const history = [0, 0, 0, 0, 0, 0, 0]
      for (let index = 0; index < this.size; index += 1) {
        if (at(index) === runDark) {
          run += 1
          if (run === 5) result += PENALTY_N1
          else if (run > 5) result += 1
        } else {
          this.addHistory(run, history)
          if (!runDark) result += this.finderLike(history) * PENALTY_N3
          runDark = at(index)
          run = 1
        }
      }
      if (runDark) {
        this.addHistory(run, history)
        run = 0
      }
      this.addHistory(run + this.size, history)
      result += this.finderLike(history) * PENALTY_N3
    }
    for (let y = 0; y < this.size; y += 1) line((x) => this.modules[y][x])
    for (let x = 0; x < this.size; x += 1) line((y) => this.modules[y][x])
    for (let y = 0; y < this.size - 1; y += 1) {
      for (let x = 0; x < this.size - 1; x += 1) {
        const dark = this.modules[y][x]
        if (dark === this.modules[y][x + 1] && dark === this.modules[y + 1][x] && dark === this.modules[y + 1][x + 1]) result += PENALTY_N2
      }
    }
    const dark = this.modules.reduce((sum, row) => sum + row.filter(Boolean).length, 0)
    const total = this.size * this.size
    result += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * PENALTY_N4
    return result
  }

  // A run's history for the finder-like pattern: the light border counts as a run at either end.
  private addHistory(run: number, history: number[]): void {
    history.pop()
    history.unshift(history[0] === 0 ? run + this.size : run)
  }

  private finderLike(history: number[]): number {
    const n = history[1]
    const core = n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n
    return (core && history[0] >= n * 4 && history[6] >= n ? 1 : 0) + (core && history[6] >= n * 4 && history[0] >= n ? 1 : 0)
  }
}

/**
 * The QR code for `text`, at level M, in the smallest version that holds it. `mask` forces one of the
 * eight masks; by default the one with the lowest penalty is used. Text longer than a version 10 code
 * holds is refused.
 */
export function qrCode(text: string, mask?: number): QrMatrix {
  const bytes = new TextEncoder().encode(text)
  let version = 1
  while (version <= MAX_VERSION && 4 + (version <= 9 ? 8 : 16) + bytes.length * 8 > dataCodewords(version) * 8) version += 1
  if (version > MAX_VERSION) throw new Error(`The text is ${bytes.length} bytes; a QR code here holds at most 213.`)
  if (mask !== undefined && !(Number.isInteger(mask) && mask >= 0 && mask <= 7)) throw new Error(`There is no QR mask ${mask}.`)
  const grid = new Grid(version)
  grid.drawFunctionPatterns()
  grid.drawCodewords(withErrorCorrection(encodeData(bytes, version), version))
  let chosen = mask ?? 0
  if (mask === undefined) {
    let lowest = Infinity
    for (let candidate = 0; candidate < 8; candidate += 1) {
      grid.applyMask(candidate)
      grid.drawFormat(candidate)
      const penalty = grid.penalty()
      if (penalty < lowest) {
        chosen = candidate
        lowest = penalty
      }
      grid.applyMask(candidate)
    }
  }
  grid.applyMask(chosen)
  grid.drawFormat(chosen)
  return grid.modules
}

/** The code as SVG in the text's colour, with the four-module quiet zone scanners need. */
export function qrSvg(matrix: QrMatrix, label: string): string {
  const quiet = 4
  const size = matrix.length + quiet * 2
  const path = matrix.flatMap((row, y) => row.flatMap((dark, x) => (dark ? [`M${x + quiet} ${y + quiet}h1v1h-1z`] : []))).join('')
  const safeLabel = label.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))
  return `<svg viewBox="0 0 ${size} ${size}" role="img" aria-label="${safeLabel}" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="${path}"/></svg>`
}
