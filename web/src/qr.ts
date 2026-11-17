/**
 * A QR code for a short piece of text, so an authenticator can scan the two-step link instead of
 * the key being typed. Byte mode, error correction level M, the smallest version that fits.
 *
 * The console carries no dependency for this: what it needs is a few hundred lines of the
 * standard (ISO/IEC 18004), written out here after the well-known reference construction.
 */

/** Error-correction codewords per block, level M, by version (index 0 unused). */
const ECC_PER_BLOCK = [
  -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28,
  28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
];
/** Error-correction blocks, level M, by version (index 0 unused). */
const BLOCKS = [
  -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35,
  37, 38, 40, 43, 45, 47, 49,
];
/** Level M's two format bits. */
const LEVEL_M = 0;

export interface QrCode {
  readonly version: number;
  readonly size: number;
  readonly mask: number;
  /** Row by row, `true` for a dark module. */
  readonly modules: readonly (readonly boolean[])[];
}

/** Encode `text` as UTF-8; throws when it is longer than the largest code holds. */
export function encodeQr(text: string): QrCode {
  const bytes = [...new TextEncoder().encode(text)];
  for (let version = 1; version <= 40; version++) {
    const capacity = dataCodewords(version) * 8;
    const countBits = version < 10 ? 8 : 16;
    if (4 + countBits + bytes.length * 8 <= capacity) return build(version, bytes, countBits, capacity);
  }
  throw new RangeError("too long for a QR code");
}

function build(version: number, bytes: number[], countBits: number, capacity: number): QrCode {
  const bits: number[] = [];
  const append = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  append(0b0100, 4);
  append(bytes.length, countBits);
  for (const byte of bytes) append(byte, 8);
  append(0, Math.min(4, capacity - bits.length));
  append(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) append(pad, 8);

  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((byte, bit) => (byte << 1) | bit, 0));

  const grid = new Grid(version);
  grid.drawFunctionPatterns();
  grid.drawCodewords(withErrorCorrection(version, data));

  let best = 0;
  let lowest = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    grid.applyMask(mask);
    grid.drawFormat(mask);
    const penalty = grid.penalty();
    if (penalty < lowest) {
      best = mask;
      lowest = penalty;
    }
    grid.applyMask(mask); // the same mask again undoes it
  }
  grid.applyMask(best);
  grid.drawFormat(best);
  return { version, size: grid.size, mask: best, modules: grid.modules };
}

function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const alignments = Math.floor(version / 7) + 2;
    result -= (25 * alignments - 10) * alignments - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function dataCodewords(version: number): number {
  return Math.floor(rawDataModules(version) / 8) - ECC_PER_BLOCK[version]! * BLOCKS[version]!;
}

/** Split into blocks, add each block's Reed–Solomon codewords, and interleave them. */
function withErrorCorrection(version: number, data: number[]): number[] {
  const blocks = BLOCKS[version]!;
  const eccLength = ECC_PER_BLOCK[version]!;
  const raw = Math.floor(rawDataModules(version) / 8);
  const shortBlocks = blocks - (raw % blocks);
  const shortLength = Math.floor(raw / blocks);
  const divisor = reedSolomonDivisor(eccLength);

  const pieces: number[][] = [];
  for (let i = 0, at = 0; i < blocks; i++) {
    const piece = data.slice(at, at + shortLength - eccLength + (i < shortBlocks ? 0 : 1));
    at += piece.length;
    const ecc = reedSolomonRemainder(piece, divisor);
    if (i < shortBlocks) piece.push(0);
    pieces.push([...piece, ...ecc]);
  }
  const result: number[] = [];
  for (let i = 0; i < pieces[0]!.length; i++) {
    pieces.forEach((piece, j) => {
      // A short block's placeholder byte is not sent.
      if (i !== shortLength - eccLength || j >= shortBlocks) result.push(piece[i]!);
    });
  }
  return result;
}

function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function reedSolomonDivisor(degree: number): number[] {
  const result = Array.from({ length: degree }, () => 0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMultiply(result[j]!, root);
      if (j + 1 < degree) result[j]! ^= result[j + 1]!;
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function reedSolomonRemainder(data: number[], divisor: number[]): number[] {
  const result = divisor.map(() => 0);
  for (const byte of data) {
    const factor = byte ^ result.shift()!;
    result.push(0);
    divisor.forEach((coefficient, i) => {
      result[i]! ^= gfMultiply(coefficient, factor);
    });
  }
  return result;
}

const bit = (value: number, index: number) => ((value >>> index) & 1) !== 0;

class Grid {
  readonly size: number;
  readonly modules: boolean[][];
  private readonly fixed: boolean[][];

  constructor(private readonly version: number) {
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => Array.from({ length: this.size }, () => false));
    this.fixed = Array.from({ length: this.size }, () => Array.from({ length: this.size }, () => false));
  }

  private set(x: number, y: number, dark: boolean): void {
    this.modules[y]![x] = dark;
    this.fixed[y]![x] = true;
  }

  drawFunctionPatterns(): void {
    const size = this.size;
    for (let i = 0; i < size; i++) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    for (const [x, y] of [[3, 3], [size - 4, 3], [3, size - 4]] as const) {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const distance = Math.max(Math.abs(dx), Math.abs(dy));
          if (x + dx >= 0 && x + dx < size && y + dy >= 0 && y + dy < size) {
            this.set(x + dx, y + dy, distance !== 2 && distance !== 4);
          }
        }
      }
    }
    const positions = this.alignmentPositions();
    const last = positions.length - 1;
    positions.forEach((y, i) => {
      positions.forEach((x, j) => {
        // The three corners already hold finder patterns.
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) this.set(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      });
    });
    this.drawFormat(0);
    this.drawVersion();
  }

  private alignmentPositions(): number[] {
    if (this.version === 1) return [];
    const count = Math.floor(this.version / 7) + 2;
    const step = Math.floor((this.version * 8 + count * 3 + 5) / (count * 4 - 4)) * 2;
    const result = [6];
    for (let position = this.size - 7; result.length < count; position -= step) result.splice(1, 0, position);
    return result;
  }

  drawFormat(mask: number): void {
    const data = (LEVEL_M << 3) | mask;
    let remainder = data;
    for (let i = 0; i < 10; i++) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
    const bits = ((data << 10) | remainder) ^ 0x5412;
    const size = this.size;
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(bits, i));
    this.set(8, 7, bit(bits, 6));
    this.set(8, 8, bit(bits, 7));
    this.set(7, 8, bit(bits, 8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(bits, i));
    for (let i = 0; i < 8; i++) this.set(size - 1 - i, 8, bit(bits, i));
    for (let i = 8; i < 15; i++) this.set(8, size - 15 + i, bit(bits, i));
    this.set(8, size - 8, true);
  }

  private drawVersion(): void {
    if (this.version < 7) return;
    let remainder = this.version;
    for (let i = 0; i < 12; i++) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
    const bits = (this.version << 12) | remainder;
    for (let i = 0; i < 18; i++) {
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.set(a, b, bit(bits, i));
      this.set(b, a, bit(bits, i));
    }
  }

  /** Lay the codewords in the zigzag of two-module columns, right to left, skipping the timing column. */
  drawCodewords(data: number[]): void {
    const size = this.size;
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let step = 0; step < size; step++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - step : step;
          if (!this.fixed[y]![x] && i < data.length * 8) {
            this.modules[y]![x] = bit(data[i >>> 3]!, 7 - (i & 7));
            i++;
          }
        }
      }
    }
  }

  applyMask(mask: number): void {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (this.fixed[y]![x]) continue;
        let invert: boolean;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        }
        if (invert) this.modules[y]![x] = !this.modules[y]![x];
      }
    }
  }

  /** The standard's four penalty rules; the mask with the lowest score is the easiest to read. */
  penalty(): number {
    const size = this.size;
    const at = (x: number, y: number) => this.modules[y]![x]!;
    let result = 0;
    const lines = (read: (a: number, b: number) => boolean) => {
      for (let a = 0; a < size; a++) {
        let run = 1;
        for (let b = 1; b <= size; b++) {
          if (b < size && read(a, b) === read(a, b - 1)) {
            run++;
            continue;
          }
          if (run >= 5) result += run - 2;
          run = 1;
        }
        // Finder-like 1:1:3:1:1 with four light modules on one side.
        const line = Array.from({ length: size }, (_, b) => read(a, b));
        const dark = (b: number) => b >= 0 && b < size && line[b]!;
        for (let b = 0; b + 6 < size; b++) {
          const core = dark(b) && !dark(b + 1) && dark(b + 2) && dark(b + 3) && dark(b + 4) && !dark(b + 5) && dark(b + 6);
          if (!core) continue;
          const lightBefore = [1, 2, 3, 4].every((k) => !dark(b - k));
          const lightAfter = [7, 8, 9, 10].every((k) => !dark(b + k));
          if (lightBefore || lightAfter) result += 40;
        }
      }
    };
    lines((y, x) => at(x, y));
    lines((x, y) => at(x, y));
    for (let y = 0; y + 1 < size; y++) {
      for (let x = 0; x + 1 < size; x++) {
        const c = at(x, y);
        if (c === at(x + 1, y) && c === at(x, y + 1) && c === at(x + 1, y + 1)) result += 3;
      }
    }
    let darkCount = 0;
    for (const row of this.modules) for (const module of row) if (module) darkCount++;
    const total = size * size;
    result += Math.floor(Math.abs(darkCount * 20 - total * 10) / total) * 10;
    return result;
  }
}

/** An SVG path drawing every dark module, offset by a four-module quiet zone. */
export function qrPath(code: QrCode, quiet = 4): string {
  const parts: string[] = [];
  code.modules.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) parts.push(`M${x + quiet} ${y + quiet}h1v1h-1z`);
    });
  });
  return parts.join("");
}
