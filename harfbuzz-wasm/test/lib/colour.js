'use strict';
// Colour tables as the harness reads them (fontconverter-web P3b plan, section 4.1, N5): COLR's base glyphs and
// layers, sbix's per-glyph data, CBLC's strikes, and the SVG table's document index with each document's text.
// Independent of hbfont's own code; N0 checks these readers against fontTools' numbers where the oracle has them.

const zlib = require('zlib');
const { table } = require('./sfnt');

// COLR: version, v0 base glyph records [{gid, first, count}], v0 layers [{gid, palette}], v1 base glyph ids.
function colrFacts(buf) {
  const c = table(buf, 'COLR');
  if (!c) return null;
  const version = c.readUInt16BE(0);
  const nBase = c.readUInt16BE(2);
  const baseAt = c.readUInt32BE(4);
  const layerAt = c.readUInt32BE(8);
  const nLayers = c.readUInt16BE(12);
  const base = [];
  for (let i = 0; i < nBase; i++) {
    const r = baseAt + 6 * i;
    base.push({ gid: c.readUInt16BE(r), first: c.readUInt16BE(r + 2), count: c.readUInt16BE(r + 4) });
  }
  const layers = [];
  for (let i = 0; i < nLayers; i++) {
    const r = layerAt + 4 * i;
    layers.push({ gid: c.readUInt16BE(r), palette: c.readUInt16BE(r + 2) });
  }
  const v1 = [];
  if (version >= 1) {
    const listAt = c.readUInt32BE(14);
    if (listAt) {
      const n = c.readUInt32BE(listAt);
      for (let i = 0; i < n; i++) v1.push(c.readUInt16BE(listAt + 4 + 6 * i));
    }
  }
  const sorted = (xs) => xs.every((x, i) => i === 0 || xs[i - 1] < x);
  return { version, base, layers, v1, baseSorted: sorted(base.map((b) => b.gid)), v1Sorted: sorted(v1) };
}

// sbix: per strike its ppem and a Map gid -> the glyph's data record bytes (originOffsets, graphicType, data).
function sbixFacts(buf) {
  const s = table(buf, 'sbix');
  if (!s) return null;
  const glyphs = table(buf, 'maxp').readUInt16BE(4);
  const n = s.readUInt32BE(4);
  const strikes = [];
  for (let i = 0; i < n; i++) {
    const at = s.readUInt32BE(8 + 4 * i);
    const data = new Map();
    for (let g = 0; g < glyphs; g++) {
      const a = s.readUInt32BE(at + 4 + 4 * g);
      const b = s.readUInt32BE(at + 8 + 4 * g);
      if (b > a) data.set(g, Buffer.from(s.subarray(at + a, at + b)));
    }
    strikes.push({ ppem: s.readUInt16BE(at), data });
  }
  return { strikes };
}

// CBLC: the number of strikes and, per strike, its glyph range.
function cblcFacts(buf) {
  const c = table(buf, 'CBLC');
  if (!c) return null;
  const n = c.readUInt32BE(4);
  const sizes = [];
  for (let i = 0; i < n; i++) {
    const r = 8 + 48 * i;
    sizes.push({ start: c.readUInt16BE(r + 40), end: c.readUInt16BE(r + 42) });
  }
  return { sizes };
}

// SVG: the document index [{start, end, doc}] and each document's text (gzip undone).
function svgFacts(buf) {
  const s = table(buf, 'SVG ');
  if (!s) return null;
  const listAt = s.readUInt32BE(2);
  const n = s.readUInt16BE(listAt);
  const entries = [];
  const docs = new Map();
  for (let i = 0; i < n; i++) {
    const r = listAt + 2 + 12 * i;
    const start = s.readUInt16BE(r);
    const end = s.readUInt16BE(r + 2);
    const off = s.readUInt32BE(r + 4);
    const len = s.readUInt32BE(r + 8);
    const key = `${off}:${len}`;
    if (!docs.has(key)) {
      const raw = s.subarray(listAt + off, listAt + off + len);
      const text = raw[0] === 0x1f && raw[1] === 0x8b ? zlib.gunzipSync(raw).toString('utf8') : raw.toString('utf8');
      docs.set(key, text);
    }
    entries.push({ start, end, doc: docs.get(key) });
  }
  const sorted = entries.every((e, i) => e.start <= e.end && (i === 0 || entries[i - 1].end < e.start));
  return { entries, sorted };
}

// The glyph ids an SVG document names as glyph elements (id="glyphN").
function svgGlyphIds(doc) {
  return [...doc.matchAll(/\bid\s*=\s*["']glyph(\d+)["']/g)].map((m) => Number(m[1]));
}

module.exports = { cblcFacts, colrFacts, sbixFacts, svgFacts, svgGlyphIds };
