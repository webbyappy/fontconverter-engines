'use strict';
// Decoded glyph comparison (P1 plan, P1-13), independent of google/woff2 and libeot: two fonts' glyphs are equal
// when their contours, bounding boxes, on-curve and overlap bits, coordinates, components (glyph, semantic flags,
// offsets or point numbers, transform) and instructions are equal, whatever bytes encode them. N0 proves it against
// fontTools' verdict on generated/damaged/.

const { tablesOf } = require('./sfnt');

// Component flags that change meaning (ARGS_ARE_XY_VALUES, ROUND_XY_TO_GRID, USE_MY_METRICS, OVERLAP_COMPOUND,
// SCALED/UNSCALED_COMPONENT_OFFSET); the others only choose an encoding.
const COMPONENT_SEMANTIC_FLAGS = 0x1e06;

function readLoca(loca, numGlyphs, longFormat) {
  const offs = [];
  for (let i = 0; i <= numGlyphs; i++) {
    offs.push(longFormat ? loca.readUInt32BE(4 * i) : loca.readUInt16BE(2 * i) * 2);
  }
  return offs;
}

// Leading PUSH instructions as values, the rest as bytes: MTX re-packs pushes (S2, section 4.2).
function splitPushes(ins) {
  const values = [];
  let i = 0;
  for (;;) {
    const op = ins[i];
    if (op === undefined) break;
    let count; let words;
    if (op >= 0xb0 && op <= 0xb7) { count = op - 0xaf; words = false; i += 1; }
    else if (op >= 0xb8 && op <= 0xbf) { count = op - 0xb7; words = true; i += 1; }
    else if (op === 0x40 || op === 0x41) { count = ins[i + 1]; words = op === 0x41; i += 2; }
    else break;
    for (let k = 0; k < count; k++) {
      values.push(words ? ins.readInt16BE(i) : ins[i]);
      i += words ? 2 : 1;
    }
  }
  return { values, rest: ins.subarray(i).toString('hex') };
}

function instructions(ins, opts) {
  return opts.normalizePushes ? splitPushes(ins) : ins.toString('hex');
}

function simpleGlyph(g, n, opts) {
  let p = 10;
  const endPts = [];
  for (let c = 0; c < n; c++) { endPts.push(g.readUInt16BE(p)); p += 2; }
  const insLen = g.readUInt16BE(p);
  const ins = g.subarray(p + 2, p + 2 + insLen);
  p += 2 + insLen;
  const points = n ? endPts[n - 1] + 1 : 0;
  const flags = [];
  while (flags.length < points) {
    const f = g[p++];
    flags.push(f);
    if (f & 0x08) { const r = g[p++]; for (let k = 0; k < r; k++) flags.push(f); }
  }
  const coord = (shortBit, sameBit) => {
    const out = [];
    let v = 0;
    for (const f of flags) {
      if (f & shortBit) { const d = g[p++]; v += f & sameBit ? d : -d; }
      else if (!(f & sameBit)) { v += g.readInt16BE(p); p += 2; }
      out.push(v);
    }
    return out;
  };
  const xs = coord(0x02, 0x10);
  const ys = coord(0x04, 0x20);
  return { endPts, on: flags.map((f) => f & 1).join(''), overlap: flags.length ? (flags[0] >> 6) & 1 : 0, xs, ys,
    ins: instructions(ins, opts) };
}

function compositeGlyph(g, opts) {
  let p = 10;
  const comps = [];
  let hasIns = false;
  for (;;) {
    const flags = g.readUInt16BE(p);
    const glyph = g.readUInt16BE(p + 2);
    p += 4;
    let a1; let a2;
    if (flags & 0x0001) {
      a1 = flags & 0x0002 ? g.readInt16BE(p) : g.readUInt16BE(p);
      a2 = flags & 0x0002 ? g.readInt16BE(p + 2) : g.readUInt16BE(p + 2);
      p += 4;
    } else {
      a1 = flags & 0x0002 ? g.readInt8(p) : g[p];
      a2 = flags & 0x0002 ? g.readInt8(p + 1) : g[p + 1];
      p += 2;
    }
    const t = [];
    const n = flags & 0x0008 ? 1 : flags & 0x0040 ? 2 : flags & 0x0080 ? 4 : 0;
    for (let k = 0; k < n; k++) { t.push(g.readInt16BE(p)); p += 2; }
    comps.push({ flags: flags & COMPONENT_SEMANTIC_FLAGS, glyph, a1, a2, t });
    if (flags & 0x0100) hasIns = true;
    if (!(flags & 0x0020)) break;
  }
  let ins = Buffer.alloc(0);
  if (hasIns) { const len = g.readUInt16BE(p); ins = g.subarray(p + 2, p + 2 + len); }
  return { comps, ins: instructions(ins, opts) };
}

// One string per glyph: the decoded glyph, or 'empty'.
function glyphSignatures(font, opts = {}, tables = null) {
  const t = tables || tablesOf(font);
  if (!t.glyf || !t.loca) return null;
  const numGlyphs = t.maxp.readUInt16BE(4);
  const offs = readLoca(t.loca, numGlyphs, t.head.readInt16BE(50) === 1);
  const out = [];
  for (let i = 0; i < numGlyphs; i++) {
    const g = t.glyf.subarray(offs[i], offs[i + 1]);
    if (g.length === 0) { out.push('empty'); continue; }
    const n = g.readInt16BE(0);
    const bbox = [g.readInt16BE(2), g.readInt16BE(4), g.readInt16BE(6), g.readInt16BE(8)];
    const body = n >= 0 ? simpleGlyph(g, n, opts) : compositeGlyph(g, opts);
    out.push(JSON.stringify({ n, bbox, ...body }));
  }
  return out;
}

// { equal, differing: [glyph ids], count } for two fonts' glyf tables (or tables maps).
function compareGlyphs(a, b, opts = {}) {
  const sa = glyphSignatures(a.font, opts, a.tables);
  const sb = glyphSignatures(b.font, opts, b.tables);
  if (!sa || !sb) return { equal: !sa && !sb, differing: [], count: 0, note: 'no glyf on one side' };
  if (sa.length !== sb.length) return { equal: false, differing: [], count: sa.length, note: 'glyph counts differ' };
  const differing = [];
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) differing.push(i);
  return { equal: differing.length === 0, differing, count: sa.length };
}

module.exports = { compareGlyphs, glyphSignatures, splitPushes };
