'use strict';
// An independent sfnt reader for the harness (P2 plan, section 5): the table directory, checksums, maxp, the
// flavour by font-oracle.json's rule, the special tables, OS/2's first and last character, and cmap code points.
// readSfnt, checksum, flavourOf and factsOfTables follow font-wasm/test/lib/sfnt.js at 840fd65d8 (P2-21).

const SPECIAL = ['fvar', 'gvar', 'CFF2', 'COLR', 'CPAL', 'CBDT', 'CBLC', 'sbix', 'SVG ']; // facts.py's list
const MAC_ROMAN = new TextDecoder('macintosh');

function tagAt(buf, off) {
  return buf.toString('latin1', off, off + 4);
}

function need(cond, msg) {
  if (!cond) throw new Error(msg);
}

function readSfnt(buf) {
  need(buf.length >= 12, 'sfnt header truncated');
  const numTables = buf.readUInt16BE(4);
  need(buf.length >= 12 + 16 * numTables, 'sfnt directory truncated');
  const tables = [];
  for (let i = 0; i < numTables; i++) {
    const r = 12 + 16 * i;
    const t = { tag: tagAt(buf, r), recorded: buf.readUInt32BE(r + 4), offset: buf.readUInt32BE(r + 8),
      length: buf.readUInt32BE(r + 12) };
    need(t.offset + t.length <= buf.length, `table ${t.tag} runs past the end`);
    tables.push(t);
  }
  return { sfntVersion: buf.readUInt32BE(0), tables };
}

function table(buf, tag) {
  const t = readSfnt(buf).tables.find((x) => x.tag === tag);
  return t ? buf.subarray(t.offset, t.offset + t.length) : null;
}

function checksum(data, tag) {
  let sum = 0;
  const padded = Buffer.alloc((data.length + 3) & ~3);
  data.copy(padded);
  if (tag === 'head' && padded.length >= 12) padded.writeUInt32BE(0, 8); // checkSumAdjustment zeroed, as the oracle
  for (let i = 0; i < padded.length; i += 4) sum = (sum + padded.readUInt32BE(i)) >>> 0;
  return sum;
}

function flavourOf(tags, sfntVersion) {
  if (tags.includes('CFF2')) return 'cff2';
  if (tags.includes('CFF ')) return 'cff';
  if (tags.includes('glyf')) return 'truetype';
  if (sfntVersion === 0x4f54544f) return 'cff';
  if (sfntVersion === 0x00010000 || sfntVersion === 0x74727565) return 'truetype';
  return null;
}

// font-oracle.json's facts of one sfnt: tables in offset order (ties in directory order), numGlyphs, flavour, special.
function facts(buf) {
  const { sfntVersion, tables } = readSfnt(buf);
  const ordered = tables.map((t, i) => ({ ...t, i })).sort((a, b) => a.offset - b.offset || a.i - b.i);
  const maxp = table(buf, 'maxp');
  const tags = tables.map((t) => t.tag);
  return {
    tables: ordered.map((t) => ({ tag: t.tag, length: t.length,
      checksum: '0x' + checksum(buf.subarray(t.offset, t.offset + t.length), t.tag).toString(16).toUpperCase()
        .padStart(8, '0') })),
    numGlyphs: maxp && maxp.length >= 6 ? maxp.readUInt16BE(4) : null,
    flavour: flavourOf(tags, sfntVersion),
    special: SPECIAL.filter((s) => tags.includes(s)),
  };
}

function os2FirstLast(buf) {
  const os2 = table(buf, 'OS/2');
  return os2 && os2.length >= 68 ? [os2.readUInt16BE(64), os2.readUInt16BE(66)] : null;
}

// Code points of a cmap subtable: formats 0, 4, 6 and 12 (what FontForge writes and what the corpus holds).
function subtableCodes(cmap, off) {
  const fmt = cmap.readUInt16BE(off);
  const out = new Map();
  if (fmt === 0) {
    for (let c = 0; c < 256; c++) if (cmap[off + 6 + c]) out.set(c, cmap[off + 6 + c]);
  } else if (fmt === 6) {
    const first = cmap.readUInt16BE(off + 6);
    const n = cmap.readUInt16BE(off + 8);
    for (let i = 0; i < n; i++) {
      const g = cmap.readUInt16BE(off + 10 + 2 * i);
      if (g) out.set(first + i, g);
    }
  } else if (fmt === 4) {
    const segX2 = cmap.readUInt16BE(off + 6);
    const ends = off + 14;
    const starts = ends + segX2 + 2;
    const deltas = starts + segX2;
    const ranges = deltas + segX2;
    for (let s = 0; s < segX2 / 2; s++) {
      const end = cmap.readUInt16BE(ends + 2 * s);
      const start = cmap.readUInt16BE(starts + 2 * s);
      const delta = cmap.readInt16BE(deltas + 2 * s);
      const ro = cmap.readUInt16BE(ranges + 2 * s);
      for (let c = start; c <= end && c !== 0xffff; c++) {
        let g;
        if (ro === 0) g = (c + delta) & 0xffff;
        else {
          const at = ranges + 2 * s + ro + 2 * (c - start);
          g = cmap.readUInt16BE(at);
          if (g) g = (g + delta) & 0xffff;
        }
        if (g) out.set(c, g);
      }
    }
  } else if (fmt === 12) {
    const n = cmap.readUInt32BE(off + 12);
    for (let i = 0; i < n; i++) {
      const r = off + 16 + 12 * i;
      const a = cmap.readUInt32BE(r);
      const b = cmap.readUInt32BE(r + 4);
      const g = cmap.readUInt32BE(r + 8);
      for (let c = a; c <= b; c++) out.set(c, g + (c - a));
    }
  } else {
    return null;
  }
  return out;
}

function subtables(buf) {
  const cmap = table(buf, 'cmap');
  if (!cmap) return [];
  const n = cmap.readUInt16BE(2);
  const out = [];
  for (let i = 0; i < n; i++) {
    const r = 4 + 8 * i;
    const off = cmap.readUInt32BE(r + 4);
    out.push({ platform: cmap.readUInt16BE(r), encoding: cmap.readUInt16BE(r + 2), format: cmap.readUInt16BE(off),
      codes: subtableCodes(cmap, off) });
  }
  return out;
}

// The Unicode code points a font maps: its best Unicode subtable (3/10, 0/4, 3/1, 0/3); for a font with only a Mac
// Roman (1/0) subtable, its byte codes decoded as Mac Roman (N8's own reading, independent of fontTools).
function unicodeCodepoints(buf) {
  const subs = subtables(buf);
  for (const [p, e] of [[3, 10], [0, 4], [3, 1], [0, 3]]) {
    const s = subs.find((x) => x.platform === p && x.encoding === e && x.codes);
    if (s) return new Set(s.codes.keys());
  }
  const mac = subs.find((x) => x.platform === 1 && x.encoding === 0 && x.codes);
  if (!mac) return new Set();
  // Every mapped code: Mac Roman's 0x00-0x7F is ASCII, control codes included (a Mac font maps 0x00, 0x08, 0x09,
  // 0x0D and 0x1D to its null and return glyphs, and FontForge keeps those mappings).
  return new Set([...mac.codes.keys()].map((c) => MAC_ROMAN.decode(Buffer.from([c])).codePointAt(0)));
}

// The best Unicode subtable's mapping, code point -> glyph id (3/10, 0/4, 3/1, 0/3); an empty Map when none.
function bestUnicodeMap(buf) {
  const subs = subtables(buf);
  for (const [p, e] of [[3, 10], [0, 4], [3, 1], [0, 3]]) {
    const s = subs.find((x) => x.platform === p && x.encoding === e && x.codes);
    if (s) return s.codes;
  }
  return new Map();
}

// The code points the scorer judges an SVG output against (fontscore/view.py): fontTools' getBestCmap order, then a
// (3,0) symbol table, then a Mac Roman (1,0) table decoded; mappings to glyph 0 left out, as fontTools does.
function scorerCodepoints(buf) {
  const subs = subtables(buf);
  const keys = (s) => new Set([...s.codes].filter(([, gid]) => gid !== 0).map(([cp]) => cp));
  for (const [p, e] of [[3, 10], [0, 6], [0, 4], [3, 1], [0, 3], [0, 2], [0, 1], [0, 0], [3, 0]]) {
    const s = subs.find((x) => x.platform === p && x.encoding === e && x.codes);
    if (s) return keys(s);
  }
  const mac = subs.find((x) => x.platform === 1 && x.encoding === 0 && x.codes);
  if (!mac) return new Set();
  return new Set([...keys(mac)].map((c) => MAC_ROMAN.decode(Buffer.from([c])).codePointAt(0)));
}

// The type of every GPOS lookup, extension lookups (type 9) resolved to the type they wrap.
function gposLookupTypes(buf) {
  const t = table(buf, 'GPOS');
  if (!t) return [];
  const list = t.readUInt16BE(8);
  const out = [];
  for (let i = 0; i < t.readUInt16BE(list); i++) {
    const at = list + t.readUInt16BE(list + 2 + 2 * i);
    let type = t.readUInt16BE(at);
    if (type === 9 && t.readUInt16BE(at + 4) > 0) type = t.readUInt16BE(at + t.readUInt16BE(at + 6) + 2);
    out.push(type);
  }
  return out;
}

// Every device-table offset in GPOS (fontforge-0008): the value records of single (1) and pair (2) positioning and the
// anchors of cursive and mark attachment (3 to 6), extension lookups (9) followed. Returns the value records (with a
// non-empty ValueFormat) and anchors read, the non-null device offsets by DeltaFormat, how many of those lead to no
// hinting device table (a DeltaFormat outside 1-3, VariationIndex 0x8000 included; a start size above the end size;
// past the table), with the first few, and the value records' device bits with a NULL offset (legal OpenType).
function gposDevices(buf) {
  const out = { records: 0, formats: {}, bad: 0, examples: [], nullBits: 0 };
  const t = table(buf, 'GPOS');
  if (!t) return out;
  const u16 = (o) => t.readUInt16BE(o);
  const device = (base, off, where) => {
    if (!off) return;
    const at = base + off;
    const fmt = at + 6 <= t.length ? u16(at + 4) : null;
    const key = fmt === null ? 'past the table' : '0x' + fmt.toString(16);
    out.formats[key] = (out.formats[key] || 0) + 1;
    if (fmt === null || fmt < 1 || fmt > 3 || u16(at) > u16(at + 2)) {
      out.bad++;
      if (out.examples.length < 3) out.examples.push(`${where}: DeltaFormat ${key}`);
    }
  };
  const valueRecord = (base, at, vf, where) => { // its size in bytes
    let o = at;
    for (let bit = 0; bit < 4; bit++) if (vf & (1 << bit)) o += 2;
    for (let bit = 4; bit < 8; bit++) {
      if (!(vf & (1 << bit))) continue;
      if (u16(o)) device(base, u16(o), where);
      else out.nullBits++;
      o += 2;
    }
    if (vf & 0xff) out.records++;
    return o - at;
  };
  const anchor = (base, off, where) => {
    if (!off) return;
    out.records++;
    if (u16(base + off) === 3) {
      device(base + off, u16(base + off + 6), where);
      device(base + off, u16(base + off + 8), where);
    }
  };
  const subtable = (type, st, where) => {
    const fmt = u16(st);
    if (type === 1) {
      const vf = u16(st + 4);
      if (fmt === 1) valueRecord(st, st + 6, vf, where);
      let o = st + 8;
      if (fmt === 2) for (let i = 0; i < u16(st + 6); i++) o += valueRecord(st, o, vf, where);
    } else if (type === 2 && fmt === 1) {
      // A PairPosFormat1's device offsets count from its PairSet (OpenType's ValueRecord; fontTools and HarfBuzz).
      for (let i = 0; i < u16(st + 8); i++) {
        const ps = st + u16(st + 10 + 2 * i);
        let o = ps + 2;
        for (let j = 0; j < u16(ps); j++) {
          o += 2; // secondGlyph
          o += valueRecord(ps, o, u16(st + 4), where);
          o += valueRecord(ps, o, u16(st + 6), where);
        }
      }
    } else if (type === 2 && fmt === 2) {
      let o = st + 16;
      for (let i = 0; i < u16(st + 12) * u16(st + 14); i++) {
        o += valueRecord(st, o, u16(st + 4), where);
        o += valueRecord(st, o, u16(st + 6), where);
      }
    } else if (type === 3) {
      for (let i = 0; i < u16(st + 4); i++) {
        anchor(st, u16(st + 6 + 4 * i), where);
        anchor(st, u16(st + 8 + 4 * i), where);
      }
    } else if (type >= 4 && type <= 6) {
      const classes = u16(st + 6);
      const marks = st + u16(st + 8);
      for (let i = 0; i < u16(marks); i++) anchor(marks, u16(marks + 4 + 4 * i), where);
      const arr = st + u16(st + 10);
      if (type === 5) {
        for (let i = 0; i < u16(arr); i++) {
          const lig = arr + u16(arr + 2 + 2 * i);
          for (let k = 0; k < u16(lig) * classes; k++) anchor(lig, u16(lig + 2 + 2 * k), where);
        }
      } else {
        for (let k = 0; k < u16(arr) * classes; k++) anchor(arr, u16(arr + 2 + 2 * k), where);
      }
    }
  };
  const list = u16(8);
  for (let i = 0; i < u16(list); i++) {
    const lookup = list + u16(list + 2 + 2 * i);
    for (let s = 0; s < u16(lookup + 4); s++) {
      let st = lookup + u16(lookup + 6 + 2 * s);
      let type = u16(lookup);
      if (type === 9) {
        type = u16(st + 2);
        st += t.readUInt32BE(st + 4);
      }
      subtable(type, st, `lookup ${i} subtable ${s} (type ${type})`);
    }
  }
  return out;
}

// A Coverage table (formats 1 and 2) as its glyph ids in coverage-index order.
function coverageGlyphs(t, off) {
  const out = [];
  const fmt = t.readUInt16BE(off);
  if (fmt === 1) {
    for (let i = 0; i < t.readUInt16BE(off + 2); i++) out.push(t.readUInt16BE(off + 4 + 2 * i));
  } else if (fmt === 2) {
    for (let i = 0; i < t.readUInt16BE(off + 2); i++) {
      const r = off + 4 + 6 * i;
      for (let g = t.readUInt16BE(r); g <= t.readUInt16BE(r + 2); g++) out.push(g);
    }
  } else {
    throw new Error(`Coverage format ${fmt}`);
  }
  return out;
}

const DEVICE_FIELDS = ['XPlaDevice', 'YPlaDevice', 'XAdvDevice', 'YAdvDevice']; // ValueFormat bits 4 to 7

// Every GPOS device table of pair and single positioning, keyed by what it adjusts (fontforge-0009): `pair <first>
// <second> v1|v2 <field>` (class pairs expanded to their glyph pairs) and `single <glyph> <field>`, glyphs named by
// their smallest code point (FontForge renumbers glyphs), offsets read at OpenType's bases (a PairPosFormat1's
// PairSet, the subtable otherwise). Each value lists the decoded tables, `<start>-<end>/f<format>:<deltas>`, sorted;
// a NULL offset adds nothing.
function gposDeviceMap(buf) {
  const map = new Map();
  const t = table(buf, 'GPOS');
  if (!t) return map;
  const u16 = (o) => t.readUInt16BE(o);
  const cps = new Map();
  for (const [cp, gid] of bestUnicodeMap(buf)) if (!cps.has(gid) || cp < cps.get(gid)) cps.set(gid, cp);
  const name = (g) => (cps.has(g) ? 'U+' + cps.get(g).toString(16).toUpperCase().padStart(4, '0') : `gid${g}`);
  const numGlyphs = table(buf, 'maxp').readUInt16BE(4);
  const decode = (at) => {
    if (at + 6 > t.length) return 'past the table';
    const [start, end, fmt] = [u16(at), u16(at + 2), u16(at + 4)];
    if (fmt < 1 || fmt > 3 || start > end) return `not a device table: ${start}-${end}/f0x${fmt.toString(16)}`;
    const bits = 1 << fmt; // 2, 4 or 8 bits per delta
    const deltas = [];
    for (let i = 0; i <= end - start; i++) {
      const word = u16(at + 6 + 2 * Math.floor((i * bits) / 16));
      const v = (word >> (16 - bits - ((i * bits) % 16))) & ((1 << bits) - 1);
      deltas.push(v >= 1 << (bits - 1) ? v - (1 << bits) : v);
    }
    return `${start}-${end}/f${fmt}:${deltas.join(',')}`;
  };
  const add = (key, at) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(decode(at));
  };
  // A value record's device offsets as [field, absolute position], and its size in bytes.
  const record = (base, at, vf) => {
    let o = at;
    const found = [];
    for (let bit = 0; bit < 4; bit++) if (vf & (1 << bit)) o += 2;
    for (let bit = 4; bit < 8; bit++) {
      if (!(vf & (1 << bit))) continue;
      if (u16(o)) found.push([DEVICE_FIELDS[bit - 4], base + u16(o)]);
      o += 2;
    }
    return { found, size: o - at };
  };
  const subtable = (type, st) => {
    const fmt = u16(st);
    const cov = coverageGlyphs(t, st + u16(st + 2));
    if (type === 1) {
      const vf = u16(st + 4);
      cov.forEach((g, i) => {
        const r = record(st, fmt === 1 ? st + 6 : st + 8 + i * record(st, st + 8, vf).size, vf);
        for (const [field, at] of r.found) add(`single ${name(g)} ${field}`, at);
      });
    } else if (type === 2 && fmt === 1) {
      const [vf1, vf2] = [u16(st + 4), u16(st + 6)];
      cov.forEach((g, i) => {
        const ps = st + u16(st + 10 + 2 * i);
        let o = ps + 2;
        for (let j = 0; j < u16(ps); j++) {
          const pair = `pair ${name(g)} ${name(u16(o))}`;
          o += 2;
          for (const [v, vf] of [['v1', vf1], ['v2', vf2]]) {
            const r = record(ps, o, vf);
            for (const [field, at] of r.found) add(`${pair} ${v} ${field}`, at);
            o += r.size;
          }
        }
      });
    } else if (type === 2 && fmt === 2) {
      const [vf1, vf2] = [u16(st + 4), u16(st + 6)];
      const cd1 = classDef(t, st + u16(st + 8));
      const cd2 = classDef(t, st + u16(st + 10));
      const [c1, c2] = [u16(st + 12), u16(st + 14)];
      const firsts = (c) => cov.filter((g) => (cd1.get(g) || 0) === c);
      const seconds = (c) => [...Array(numGlyphs).keys()].filter((g) => (cd2.get(g) || 0) === c);
      let o = st + 16;
      for (let i = 0; i < c1; i++) {
        for (let j = 0; j < c2; j++) {
          for (const [v, vf] of [['v1', vf1], ['v2', vf2]]) {
            const r = record(st, o, vf);
            for (const [field, at] of r.found) {
              for (const a of firsts(i)) for (const b of seconds(j)) add(`pair ${name(a)} ${name(b)} ${v} ${field}`, at);
            }
            o += r.size;
          }
        }
      }
    }
  };
  const list = u16(8);
  for (let i = 0; i < u16(list); i++) {
    const lookup = list + u16(list + 2 + 2 * i);
    for (let s = 0; s < u16(lookup + 4); s++) {
      let st = lookup + u16(lookup + 6 + 2 * s);
      let type = u16(lookup);
      if (type === 9) {
        type = u16(st + 2);
        st += t.readUInt32BE(st + 4);
      }
      subtable(type, st);
    }
  }
  for (const v of map.values()) v.sort();
  return map;
}

// A ClassDef table (formats 1 and 2) as glyph id -> class; class 0 (no entry) left out.
function classDef(t, off) {
  const out = new Map();
  const fmt = t.readUInt16BE(off);
  if (fmt === 1) {
    const start = t.readUInt16BE(off + 2);
    for (let i = 0; i < t.readUInt16BE(off + 4); i++) {
      const c = t.readUInt16BE(off + 6 + 2 * i);
      if (c) out.set(start + i, c);
    }
  } else if (fmt === 2) {
    for (let i = 0; i < t.readUInt16BE(off + 2); i++) {
      const r = off + 4 + 6 * i;
      const c = t.readUInt16BE(r + 4);
      for (let g = t.readUInt16BE(r); g <= t.readUInt16BE(r + 2); g++) if (c) out.set(g, c);
    }
  } else {
    throw new Error(`ClassDef format ${fmt}`);
  }
  return out;
}

// GDEF's version, its GlyphClassDef as the number of glyphs in each class (1 base, 2 ligature, 3 mark, 4 component;
// counts, because FontForge renumbers glyphs) and its number of mark glyph sets; null without a GDEF (fontforge-0006).
function gdefFacts(buf) {
  const t = table(buf, 'GDEF');
  if (!t) return null;
  const version = t.readUInt32BE(0);
  const gc = t.readUInt16BE(4);
  const mas = version >= 0x00010002 ? t.readUInt16BE(12) : 0;
  const classes = { 1: 0, 2: 0, 3: 0, 4: 0 };
  if (gc) for (const c of classDef(t, gc).values()) classes[c] = (classes[c] || 0) + 1;
  return { version: '0x' + version.toString(16).padStart(8, '0'), classes,
    markSets: mas && t.readUInt16BE(mas) === 1 ? t.readUInt16BE(mas + 2) : 0 };
}

module.exports = { SPECIAL, bestUnicodeMap, checksum, classDef, coverageGlyphs, facts, flavourOf, gdefFacts,
  gposDeviceMap, gposDevices, gposLookupTypes, os2FirstLast, readSfnt, scorerCodepoints, subtables, table,
  unicodeCodepoints };
