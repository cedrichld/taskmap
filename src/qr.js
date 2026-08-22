'use strict';
// qr.js — a small QR encoder, byte mode, versions 1-10, error correction M (or L
// when the payload needs the room). Enough to put a share link on a phone camera;
// not a general-purpose library. No dependencies, which is the point.
//
// Reference: ISO/IEC 18004. Tables below are transcribed from it, not derived.

// ---------- GF(256), primitive polynomial 0x11d ----------
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function buildTables() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

// Generator polynomial for `degree` error-correction codewords.
function generator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= mul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function ecCodewords(data, count) {
  const gen = generator(count);
  const rem = new Array(count).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem[0];
    rem.shift();
    rem.push(0);
    for (let i = 0; i < count; i++) rem[i] ^= mul(gen[i + 1], factor);
  }
  return rem;
}

// ---------- version tables (ISO/IEC 18004 tables 9 and E.1) ----------
// [ec codewords per block, group1 blocks, group1 data codewords, group2 blocks, group2 data codewords]
const BLOCKS = {
  L: [
    null,
    [7, 1, 19, 0, 0], [10, 1, 34, 0, 0], [15, 1, 55, 0, 0], [20, 1, 80, 0, 0], [26, 1, 108, 0, 0],
    [18, 2, 68, 0, 0], [20, 2, 78, 0, 0], [24, 2, 97, 0, 0], [30, 2, 116, 0, 0], [18, 2, 68, 2, 69],
  ],
  M: [
    null,
    [10, 1, 16, 0, 0], [16, 1, 28, 0, 0], [26, 1, 44, 0, 0], [18, 2, 32, 0, 0], [24, 2, 43, 0, 0],
    [16, 4, 27, 0, 0], [18, 4, 31, 0, 0], [22, 2, 38, 2, 39], [22, 3, 36, 2, 37], [26, 4, 43, 1, 44],
  ],
};
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
const VERSION_BITS = [0, 0, 0, 0, 0, 0, 0, 0x07c94, 0x085bc, 0x09a99, 0x0a4d3];
const FORMAT_BITS = {
  L: [0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976],
  M: [0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0],
};
const MAX_VERSION = 10;

const dataCodewords = (version, level) => {
  const [, g1, d1, g2, d2] = BLOCKS[level][version];
  return g1 * d1 + g2 * d2;
};

// Bytes that fit in byte mode: 4 mode bits + the character count field.
const capacity = (version, level) => dataCodewords(version, level) - (version >= 10 ? 3 : 2);

function chooseVersion(byteLength) {
  for (const level of ['M', 'L']) {
    for (let v = 1; v <= MAX_VERSION; v++) if (capacity(v, level) >= byteLength) return { version: v, level };
  }
  throw new Error(`qr: ${byteLength} bytes is more than this encoder handles (max ${capacity(MAX_VERSION, 'L')})`);
}

// ---------- bit stream ----------
class Bits {
  constructor() {
    this.bits = [];
  }
  push(value, length) {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >> i) & 1);
  }
  get length() {
    return this.bits.length;
  }
  toBytes() {
    const out = [];
    for (let i = 0; i < this.bits.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | (this.bits[i + j] || 0);
      out.push(b);
    }
    return out;
  }
}

function encodeData(bytes, version, level) {
  const total = dataCodewords(version, level);
  const bits = new Bits();
  bits.push(0b0100, 4); // byte mode
  bits.push(bytes.length, version >= 10 ? 16 : 8);
  for (const b of bytes) bits.push(b, 8);
  const room = total * 8;
  bits.push(0, Math.min(4, room - bits.length)); // terminator
  while (bits.length % 8) bits.push(0, 1);
  const words = bits.toBytes();
  for (let i = 0; words.length < total; i++) words.push(i % 2 ? 0x11 : 0xec);
  return words;
}

// Split into blocks, append error correction, interleave (ISO/IEC 18004 section 8.6).
function interleave(words, version, level) {
  const [ecPer, g1, d1, g2, d2] = BLOCKS[level][version];
  const blocks = [];
  let at = 0;
  for (let i = 0; i < g1; i++) blocks.push(words.slice(at, (at += d1)));
  for (let i = 0; i < g2; i++) blocks.push(words.slice(at, (at += d2)));
  const ecBlocks = blocks.map((b) => ecCodewords(b, ecPer));
  const out = [];
  const maxData = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < ecPer; i++) for (const b of ecBlocks) out.push(b[i]);
  return out;
}

// ---------- matrix ----------
function newMatrix(size) {
  return { size, mod: Array.from({ length: size }, () => new Int8Array(size).fill(-1)) };
}
const set = (m, r, c, v) => {
  if (r >= 0 && c >= 0 && r < m.size && c < m.size) m.mod[r][c] = v ? 1 : 0;
};

function placeFunctionPatterns(m, version) {
  const n = m.size;
  const finder = (r0, c0) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const inner = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        const dark = inner && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
        set(m, r0 + r, c0 + c, inner ? dark : 0);
      }
    }
  };
  finder(0, 0);
  finder(0, n - 7);
  finder(n - 7, 0);

  for (let i = 8; i < n - 8; i++) {
    const dark = i % 2 === 0;
    set(m, 6, i, dark);
    set(m, i, 6, dark);
  }

  const centers = ALIGN[version];
  for (const r of centers) {
    for (const c of centers) {
      if ((r <= 8 && c <= 8) || (r <= 8 && c >= n - 9) || (r >= n - 9 && c <= 8)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          set(m, r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        }
      }
    }
  }

  set(m, n - 8, 8, 1); // the always-dark module
  // Reserve the format areas so data placement skips them.
  for (let i = 0; i < 9; i++) {
    if (m.mod[8][i] === -1) set(m, 8, i, 0);
    if (m.mod[i][8] === -1) set(m, i, 8, 0);
  }
  for (let i = 0; i < 8; i++) {
    if (m.mod[8][n - 1 - i] === -1) set(m, 8, n - 1 - i, 0);
    if (m.mod[n - 1 - i][8] === -1) set(m, n - 1 - i, 8, 0);
  }
  if (version >= 7) {
    const bits = VERSION_BITS[version];
    for (let i = 0; i < 18; i++) {
      const bit = (bits >> i) & 1;
      set(m, Math.floor(i / 3), n - 11 + (i % 3), bit);
      set(m, n - 11 + (i % 3), Math.floor(i / 3), bit);
    }
  }
}

function placeData(m, bytes) {
  const n = m.size;
  let bit = 0;
  const next = () => {
    const b = (bytes[bit >> 3] >> (7 - (bit & 7))) & 1;
    bit += 1;
    return b;
  };
  let upward = true;
  for (let right = n - 1; right > 0; right -= 2) {
    if (right === 6) right = 5; // the vertical timing column carries no data
    for (let step = 0; step < n; step++) {
      const r = upward ? n - 1 - step : step;
      for (const c of [right, right - 1]) {
        if (m.mod[r][c] !== -1) continue;
        m.mod[r][c] = bit < bytes.length * 8 ? next() : 0;
      }
    }
    upward = !upward;
  }
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

// Penalty rules 1-4 (ISO/IEC 18004 section 8.8.2).
function penalty(grid) {
  const n = grid.length;
  let score = 0;
  const line = (get) => {
    for (let a = 0; a < n; a++) {
      let run = 1;
      for (let b = 1; b < n; b++) {
        if (get(a, b) === get(a, b - 1)) {
          run += 1;
          if (run === 5) score += 3;
          else if (run > 5) score += 1;
        } else run = 1;
      }
    }
  };
  line((r, c) => grid[r][c]);
  line((c, r) => grid[r][c]);

  for (let r = 0; r < n - 1; r++) {
    for (let c = 0; c < n - 1; c++) {
      const v = grid[r][c];
      if (v === grid[r][c + 1] && v === grid[r + 1][c] && v === grid[r + 1][c + 1]) score += 3;
    }
  }

  const PAT = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const hit = (cells) => {
    for (let i = 0; i + 11 <= cells.length; i++) {
      let fwd = true;
      let rev = true;
      for (let j = 0; j < 11; j++) {
        if (cells[i + j] !== PAT[j]) fwd = false;
        if (cells[i + j] !== PAT[10 - j]) rev = false;
      }
      if (fwd || rev) score += 40;
    }
  };
  for (let r = 0; r < n; r++) hit(grid[r]);
  for (let c = 0; c < n; c++) hit(grid.map((row) => row[c]));

  let dark = 0;
  for (const row of grid) for (const v of row) dark += v;
  score += Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10;
  return score;
}

function applyFormat(grid, reserved, level, mask) {
  const n = grid.length;
  const bits = FORMAT_BITS[level][mask];
  for (let i = 0; i < 15; i++) {
    const bit = (bits >> i) & 1;
    if (i < 6) grid[i][8] = bit;
    else if (i < 8) grid[i + 1][8] = bit;
    else if (i === 8) grid[8][7] = bit;
    else grid[8][14 - i] = bit;

    if (i < 8) grid[8][n - 1 - i] = bit;
    else grid[n - 15 + i][8] = bit;
  }
  grid[n - 8][8] = 1;
  return reserved;
}

// A boolean grid: true = dark module. Includes no quiet zone.
function encode(text) {
  const bytes = Array.from(Buffer.from(String(text), 'utf8'));
  const { version, level } = chooseVersion(bytes.length);
  const words = interleave(encodeData(bytes, version, level), version, level);

  const size = 17 + version * 4;
  const m = newMatrix(size);
  placeFunctionPatterns(m, version);
  const reserved = m.mod.map((row) => Array.from(row, (v) => v !== -1));
  placeData(m, words);

  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const grid = m.mod.map((row, r) => Array.from(row, (v, c) => (!reserved[r][c] && MASKS[mask](r, c) ? v ^ 1 : v)));
    applyFormat(grid, reserved, level, mask);
    const score = penalty(grid);
    if (!best || score < best.score) best = { score, grid };
  }
  return { size, version, level, grid: best.grid.map((row) => row.map(Boolean)) };
}

// Two module rows per text row, so modules come out roughly square in a terminal.
// Light modules are drawn, dark ones are gaps: with `color`, explicit white-on-black
// keeps the polarity right whatever the terminal theme is.
function toText(text, { quiet = 4, color = true } = {}) {
  const { grid, size } = encode(text);
  const at = (r, c) => {
    const rr = r - quiet;
    const cc = c - quiet;
    return rr >= 0 && cc >= 0 && rr < size && cc < size ? grid[rr][cc] : false;
  };
  const width = size + quiet * 2;
  const height = size + quiet * 2;
  const lines = [];
  for (let r = 0; r < height; r += 2) {
    let line = '';
    for (let c = 0; c < width; c++) {
      const top = !at(r, c); // light module -> drawn
      const bottom = r + 1 < height ? !at(r + 1, c) : true;
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(color ? `\x1b[97;40m${line}\x1b[0m` : line);
  }
  return lines.join('\n');
}

module.exports = { encode, toText };
