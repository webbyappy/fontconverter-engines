'use strict';
// The harness's own font container reader (P1 plan, P1-13): sfnt, TTC, WOFF 1.0, WOFF 2.0 and EOT directories,
// table checksums, OS/2 and name fields, and the EOT header fontwrap must write. Written independently of the engine's
// C++ code; N0 proves it against font-oracle.json (fontTools) and sfntly's EOT headers.

const zlib = require('zlib');

const EOT_MAGIC = 0x504c;
const EOT_XOR_FLAG = 0x10000000;
const EOT_MTX_FLAG = 0x00000004;
const EOT_XOR_KEY = 0x50;
const EOT_ROOT_CHECKSUM = 0x50475342; // sfntly's RootStringCheckSum for an empty RootString

function tagAt(buf, off) {
  return buf.toString('latin1', off, off + 4);
}

function need(cond, msg) {
  if (!cond) throw new Error(msg);
}

// Directory of one sfnt starting at `base` (0 for a plain font, a face offset in a collection).
function readSfnt(buf, base = 0) {
  need(buf.length >= base + 12, 'sfnt header truncated');
  const numTables = buf.readUInt16BE(base + 4);
  need(buf.length >= base + 12 + 16 * numTables, 'sfnt directory truncated');
  const tables = [];
  for (let i = 0; i < numTables; i++) {
    const r = base + 12 + 16 * i;
    const t = { tag: tagAt(buf, r), recorded: buf.readUInt32BE(r + 4), offset: buf.readUInt32BE(r + 8),
      length: buf.readUInt32BE(r + 12) };
    need(t.offset + t.length <= buf.length, `table ${t.tag} runs past the end`);
    tables.push(t);
  }
  return { sfntVersion: buf.readUInt32BE(base), tables };
}

function tableBytes(buf, t) {
  return buf.subarray(t.offset, t.offset + t.length);
}

// OpenType table checksum; head is summed with checkSumAdjustment zeroed (the oracle's convention).
function checksum(data, tag) {
  let sum = 0;
  const n = data.length;
  for (let i = 0; i < n; i += 4) {
    let word = 0;
    for (let j = 0; j < 4; j++) {
      let b = i + j < n ? data[i + j] : 0;
      if (tag === 'head' && i + j >= 8 && i + j < 12) b = 0;
      word = (word * 256 + b) >>> 0;
    }
    sum = (sum + word) >>> 0;
  }
  return sum;
}

function hex32(v) {
  return '0x' + (v >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

// {tag: Buffer} for a plain sfnt (or a face of a collection).
function tablesOf(buf, base = 0) {
  const out = {};
  for (const t of readSfnt(buf, base).tables) out[t.tag] = tableBytes(buf, t);
  return out;
}

// Tables in the order fontTools' reader lists them, as font-oracle.json records them: by offset in the file, ties
// in directory order (fontTools/ttLib/sfnt.py:100, a stable sort).
function byOffset(entries) {
  return entries.map((e, i) => [e, i]).sort((a, b) => a[0].offset - b[0].offset || a[1] - b[1]).map(([e]) => e);
}

// The facts font-oracle.json records for a font: tables in reader order, numGlyphs.
function factsOfTables(entries) {
  const maxp = entries.find((e) => e.tag === 'maxp');
  return {
    tables: byOffset(entries).map((e) => ({ tag: e.tag, length: e.data.length,
      checksum: hex32(checksum(e.data, e.tag)) })),
    numGlyphs: maxp && maxp.data.length >= 6 ? maxp.data.readUInt16BE(4) : null,
  };
}

function sfntEntries(buf, base = 0) {
  return readSfnt(buf, base).tables.map((t) => ({ tag: t.tag, offset: t.offset, data: tableBytes(buf, t) }));
}

function readCollection(buf) {
  need(tagAt(buf, 0) === 'ttcf', 'not a collection');
  const n = buf.readUInt32BE(8);
  const faces = [];
  for (let i = 0; i < n; i++) faces.push(buf.readUInt32BE(12 + 4 * i));
  return faces;
}

// WOFF 1.0: header, directory, and the decoded tables (independent zlib inflate).
function readWoff(buf) {
  need(tagAt(buf, 0) === 'wOFF', 'not a WOFF');
  const numTables = buf.readUInt16BE(12);
  const dir = [];
  for (let i = 0; i < numTables; i++) {
    const r = 44 + 20 * i;
    dir.push({ tag: tagAt(buf, r), offset: buf.readUInt32BE(r + 4), compLength: buf.readUInt32BE(r + 8),
      origLength: buf.readUInt32BE(r + 12), origChecksum: buf.readUInt32BE(r + 16) });
  }
  return { flavor: buf.readUInt32BE(4), length: buf.readUInt32BE(8), totalSfntSize: buf.readUInt32BE(16), dir };
}

function woffEntries(buf) {
  return readWoff(buf).dir.map((d) => {
    const raw = buf.subarray(d.offset, d.offset + d.compLength);
    const data = d.compLength < d.origLength ? zlib.inflateSync(raw) : Buffer.from(raw);
    need(data.length === d.origLength, `${d.tag} inflates to ${data.length}, not ${d.origLength}`);
    return { tag: d.tag, offset: d.offset, data };
  });
}

// ---------------------------------------------------------------- WOFF2

// The 63 known table tags of the WOFF 2.0 spec (section 5.2, "Known Table Tags"), by flags index.
const WOFF2_KNOWN_TAGS = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ',
  'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS',
  'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc',
  'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop',
  'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill'];
const WOFF2_HEADER_BYTES = 48;
const WOFF2_ARBITRARY_TAG = 63;

// UIntBase128 (spec section 4.1): at most 5 bytes, no leading zero byte, no overflow past 32 bits.
function base128(buf, at) {
  let v = 0;
  for (let i = 0; i < 5; i++) {
    const b = buf[at + i];
    need(b !== undefined, 'UIntBase128 runs past the end');
    need(!(i === 0 && b === 0x80), 'UIntBase128 with a leading zero');
    need(v < 2 ** 25, 'UIntBase128 overflows 32 bits');
    v = v * 128 + (b & 0x7f);
    if ((b & 0x80) === 0) return { value: v, next: at + i + 1 };
  }
  throw new Error('UIntBase128 longer than 5 bytes');
}

// WOFF 2.0 table directory (spec section 5.2): tag, transform version, whether the table is transformed (glyf and
// loca when version 0, any other table when its version is not 0, as google/woff2 reads it), origLength and
// transformLength.
function woff2Directory(buf) {
  need(tagAt(buf, 0) === 'wOF2', 'not a WOFF2');
  const numTables = buf.readUInt16BE(12);
  const tables = [];
  let at = WOFF2_HEADER_BYTES;
  for (let i = 0; i < numTables; i++) {
    const flags = buf[at++];
    const index = flags & 0x3f;
    const version = flags >> 6;
    let tag;
    if (index === WOFF2_ARBITRARY_TAG) {
      tag = tagAt(buf, at);
      at += 4;
    } else {
      tag = WOFF2_KNOWN_TAGS[index];
    }
    const orig = base128(buf, at);
    at = orig.next;
    const transformed = tag === 'glyf' || tag === 'loca' ? version === 0 : version !== 0; // as google/woff2
    let transformLength = null;
    if (transformed) {
      const t = base128(buf, at);
      transformLength = t.value;
      at = t.next;
    }
    tables.push({ tag, version, transformed, origLength: orig.value, transformLength });
  }
  return { flavor: buf.readUInt32BE(4), numTables, tables };
}

// ---------------------------------------------------------------- EOT

function readEotHeader(buf) {
  need(buf.length >= 82, 'EOT header truncated');
  const h = {
    eotSize: buf.readUInt32LE(0), fontDataSize: buf.readUInt32LE(4), version: buf.readUInt32LE(8),
    flags: buf.readUInt32LE(12), panose: [...buf.subarray(16, 26)], charset: buf[26], italic: buf[27],
    weight: buf.readUInt32LE(28), fsType: buf.readUInt16LE(32), magic: buf.readUInt16LE(34),
    unicodeRange: [0, 1, 2, 3].map((i) => buf.readUInt32LE(36 + 4 * i)),
    codePageRange: [0, 1].map((i) => buf.readUInt32LE(52 + 4 * i)),
    checkSumAdjustment: buf.readUInt32LE(60), reserved: [0, 1, 2, 3].map((i) => buf.readUInt32LE(64 + 4 * i)),
  };
  need(h.magic === EOT_MAGIC, 'EOT magic missing');
  let pos = 80;
  const str = () => {
    const pad = buf.readUInt16LE(pos);
    const size = buf.readUInt16LE(pos + 2);
    const s = buf.subarray(pos + 4, pos + 4 + size);
    pos += 4 + size;
    return { pad, text: s.toString('utf16le') };
  };
  const names = [str(), str(), str(), str()];
  h.familyName = names[0].text; h.styleName = names[1].text; h.versionName = names[2].text;
  h.fullName = names[3].text; h.paddings = names.map((n) => n.pad);
  if (h.version >= 0x00020001) {
    const s = str();
    h.paddings.push(s.pad);
    h.rootString = s.text;
  }
  if (h.version >= 0x00020002) {
    h.rootStringCheckSum = buf.readUInt32LE(pos); h.eudcCodePage = buf.readUInt32LE(pos + 4);
    h.paddings.push(buf.readUInt16LE(pos + 8));
    const sig = buf.readUInt16LE(pos + 10);
    pos += 12 + sig;
    h.signatureSize = sig;
    h.eudcFlags = buf.readUInt32LE(pos); h.eudcFontSize = buf.readUInt32LE(pos + 4);
    pos += 8 + h.eudcFontSize;
  }
  h.fontDataOffset = pos;
  need(h.eotSize === buf.length, 'EOTSize is not the file size');
  need(pos + h.fontDataSize === buf.length, 'font data does not end the file');
  h.compression = h.flags & EOT_MTX_FLAG ? 'mtx' : h.flags & EOT_XOR_FLAG ? 'xor' : 'none';
  return h;
}

// The embedded font of a plain or XOR EOT, sliced (and un-XORed) independently of the engine.
function eotPayload(buf) {
  const h = readEotHeader(buf);
  need(h.compression !== 'mtx', 'MTX payloads need a decompressor');
  const data = Buffer.from(buf.subarray(h.fontDataOffset, h.fontDataOffset + h.fontDataSize));
  if (h.compression === 'xor') for (let i = 0; i < data.length; i++) data[i] ^= EOT_XOR_KEY;
  return data;
}

// ---------------------------------------------------------------- names and the predicted EOT header

const MAC_ROMAN = new TextDecoder('macintosh');

function nameRecords(name) {
  const count = name.readUInt16BE(2);
  const strings = name.readUInt16BE(4);
  const recs = [];
  for (let i = 0; i < count; i++) {
    const r = 6 + 12 * i;
    const rec = { platform: name.readUInt16BE(r), encoding: name.readUInt16BE(r + 2), language: name.readUInt16BE(r + 4),
      id: name.readUInt16BE(r + 6), length: name.readUInt16BE(r + 8), offset: name.readUInt16BE(r + 10) };
    rec.bytes = name.subarray(strings + rec.offset, strings + rec.offset + rec.length);
    recs.push(rec);
  }
  return recs;
}

// UTF-16LE bytes of name `id`, chosen as sfntly does with fontwrap's fallbacks (S2, section 4.3): Windows English
// (3,1,0x409), any (3,1), (3,10), (3,0), then the Unicode platform, then Macintosh Roman.
function eotName(name, id) {
  const recs = nameRecords(name).filter((r) => r.id === id);
  const rank = [
    (r) => r.platform === 3 && r.encoding === 1 && r.language === 0x409,
    (r) => r.platform === 3 && r.encoding === 1,
    (r) => r.platform === 3 && r.encoding === 10,
    (r) => r.platform === 3 && r.encoding === 0,
    (r) => r.platform === 0,
    (r) => r.platform === 1 && r.encoding === 0,
  ];
  for (const test of rank) {
    const r = recs.find(test);
    if (!r) continue;
    if (r.platform === 1) return Buffer.from(MAC_ROMAN.decode(r.bytes), 'utf16le');
    const le = Buffer.from(r.bytes);
    le.swap16();
    return le;
  }
  return Buffer.alloc(0);
}

// The whole EOT (version 0x00020002, flags 0) fontwrap must write for `font`: header as sfntly's, then the font.
function predictEot(font) {
  const t = tablesOf(font);
  const os2 = t['OS/2'];
  const head = t.head;
  const parts = [];
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); parts.push(b); };
  const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); parts.push(b); };
  u32(0); u32(font.length); u32(0x00020002); u32(0);
  parts.push(Buffer.from(os2.subarray(32, 42)));
  parts.push(Buffer.from([1, os2.readUInt16BE(62) & 1]));
  u32(os2.readUInt16BE(4)); u16(os2.readUInt16BE(8)); u16(EOT_MAGIC);
  for (let i = 0; i < 4; i++) u32(os2.readUInt32BE(42 + 4 * i));
  const hasCodePages = os2.readUInt16BE(0) >= 1 && os2.length >= 86;
  u32(hasCodePages ? os2.readUInt32BE(78) : 1); u32(hasCodePages ? os2.readUInt32BE(82) : 0);
  u32(head.readUInt32BE(8));
  for (let i = 0; i < 4; i++) u32(0);
  for (const id of [1, 2, 5, 4]) {
    const s = eotName(t.name, id);
    u16(0); u16(s.length); parts.push(s);
  }
  u16(0); u16(0); // Padding5, RootStringSize
  u32(EOT_ROOT_CHECKSUM); u32(0); u16(0); u16(0); u32(0); u32(0); // RootStringCheckSum … EUDCFontSize
  parts.push(font);
  const eot = Buffer.concat(parts);
  eot.writeUInt32LE(eot.length, 0);
  return eot;
}

// sfnt flavour by the oracle's rule (facts.py:67-76, 110): outline table first, else the sfnt version.
function flavourOf(tags, sfntVersion) {
  if (tags.includes('CFF2')) return 'cff2';
  if (tags.includes('CFF ')) return 'cff';
  if (tags.includes('glyf')) return 'truetype';
  if (sfntVersion === 0x4f54544f) return 'cff';
  if (sfntVersion === 0x00010000 || sfntVersion === 0x74727565) return 'truetype';
  return null;
}

module.exports = { EOT_XOR_FLAG, checksum, eotPayload, factsOfTables, flavourOf, hex32, predictEot, readCollection,
  readEotHeader, readSfnt, readWoff, sfntEntries, tableBytes, tablesOf, woff2Directory, woffEntries };
