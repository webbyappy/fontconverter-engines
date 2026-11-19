'use strict';
// A CFF table built from parts, for the result check's length rows (fontconverter-web P3b, ffconv's bounded CFF
// validation): exact program lengths in CharStrings, Global Subrs and local Subrs (top or per FD), and a damaged
// INDEX. Programs are filler bytes (the check reads lengths, not charstrings). Put into slick.otf in place of its CFF.

const { checksum, readSfnt } = require('./sfnt');

// An INDEX with offSize 4 (valid at any size).
function index(items) {
  if (items.length === 0) return Buffer.from([0, 0]);
  const head = Buffer.alloc(3 + 4 * (items.length + 1));
  head.writeUInt16BE(items.length, 0);
  head[2] = 4;
  let off = 1;
  items.forEach((it, i) => { head.writeUInt32BE(off, 3 + 4 * i); off += it.length; });
  head.writeUInt32BE(off, 3 + 4 * items.length);
  return Buffer.concat([head, ...items]);
}

const int5 = (v) => { const b = Buffer.alloc(5); b[0] = 29; b.writeInt32BE(v, 1); return b; };
const op = (...bytes) => Buffer.from(bytes);
const program = (n) => Buffer.concat([Buffer.alloc(n - 1, 0x8b), Buffer.from([0x0e])]); // n bytes ending in endchar

// opts: charStrings (lengths, glyph 0 first), globalSubrs, localSubrs (lengths), cid (FD's local Subrs instead),
// damage ('charstrings-offset': an INDEX offset past the table).
function buildCff(opts) {
  const header = Buffer.from([1, 0, 4, 4]);
  const names = index([Buffer.from('Test')]);
  const strings = index(opts.cid ? [Buffer.from('Adobe'), Buffer.from('Identity')] : []);
  const gsubrs = index((opts.globalSubrs || []).map(program));
  const charStrings = index(opts.charStrings.map(program));
  const subrs = index((opts.localSubrs || []).map(program));
  const n = opts.charStrings.length;
  // The Top DICT's size does not depend on the offsets it holds (5-byte integers), so lay out with a placeholder first.
  const topDict = (cs, priv, fdArray, fdSelect) => Buffer.concat(opts.cid
    ? [int5(391), int5(392), int5(0), op(12, 30), int5(cs), op(17), int5(fdArray), op(12, 36), int5(fdSelect), op(12, 37)]
    : [int5(cs), op(17), int5(priv.size), int5(priv.at), op(18)]);
  // Always 6 bytes: Subrs at an offset, or defaultWidthX 0 (both as 5-byte integers), so the size is known first.
  const privDict = (subrsOff) => Buffer.concat(subrsOff ? [int5(subrsOff), op(19)] : [int5(0), op(20)]);
  const privSize = privDict(1).length;
  const placeholder = index([topDict(0, { size: 0, at: 0 }, 0, 0)]);
  let at = header.length + names.length + placeholder.length + strings.length + gsubrs.length;
  const csAt = at; at += charStrings.length;
  const privAt = at; at += privSize;
  const subrsAt = at; at += subrs.length;
  const privBytes = privDict(opts.localSubrs ? subrsAt - privAt : 0);
  let tail;
  let top;
  if (opts.cid) {
    const fd = index([Buffer.concat([int5(privSize), int5(privAt), op(18)])]);
    const fdArrayAt = at; at += fd.length;
    const fdSelectAt = at;
    const fdSelect = Buffer.from([3, 0, 1, 0, 0, 0, (n >> 8) & 0xff, n & 0xff]);
    top = index([topDict(csAt, null, fdArrayAt, fdSelectAt)]);
    tail = [charStrings, privBytes, subrs, fd, fdSelect];
  } else {
    top = index([topDict(csAt, { size: privSize, at: privAt }, 0, 0)]);
    tail = [charStrings, privBytes, subrs];
  }
  const cff = Buffer.concat([header, names, top, strings, gsubrs, ...tail]);
  if (opts.damage === 'charstrings-offset') {
    cff.writeUInt32BE(cff.length + 1000, csAt + 3 + 4 * n); // the last offset points past the table
  }
  return cff;
}

// The font with table `tag` replaced (tables laid out again, checksums recomputed; checkSumAdjustment zeroed).
function withTable(font, tag, data) {
  const { sfntVersion, tables } = readSfnt(font);
  const entries = tables.map((t) => ({ tag: t.tag, data: t.tag === tag ? data : font.subarray(t.offset, t.offset + t.length) }));
  const dir = Buffer.alloc(12 + 16 * entries.length);
  dir.writeUInt32BE(sfntVersion, 0);
  dir.writeUInt16BE(entries.length, 4);
  const parts = [dir];
  let at = dir.length;
  entries.forEach((t, i) => {
    const r = 12 + 16 * i;
    dir.write(t.tag, r, 4, 'latin1');
    dir.writeUInt32BE(checksum(t.data, t.tag), r + 4);
    dir.writeUInt32BE(at, r + 8);
    dir.writeUInt32BE(t.data.length, r + 12);
    const pad = (4 - (t.data.length % 4)) % 4;
    parts.push(Buffer.from(t.data), Buffer.alloc(pad));
    at += t.data.length + pad;
  });
  return Buffer.concat(parts);
}

module.exports = { buildCff, withTable };
