'use strict';
// The name table for the harness (P3b plan, section 3.4): read every record decoded, write a table from records, and
// put a table into an sfnt (the tables laid out again, 4-byte aligned, checksums and checkSumAdjustment recomputed).
// N4 plants a localized family with it; nothing is written to the drive.

const { checksum, readSfnt } = require('./sfnt');

const MAC_ROMAN = new TextDecoder('macintosh');

function decode(platform, encoding, bytes) {
  if (platform === 1 && encoding === 0) return MAC_ROMAN.decode(bytes);
  if (platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10))) {
    let s = '';
    for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode(bytes.readUInt16BE(i));
    return s;
  }
  return null;
}

// Every record of the font's name table: {platform, encoding, language, id, text (null when not decodable), bytes}.
function nameRecords(buf) {
  const t = readSfnt(buf).tables.find((x) => x.tag === 'name');
  if (!t) return [];
  const n = buf.subarray(t.offset, t.offset + t.length);
  const count = n.readUInt16BE(2);
  const strings = n.readUInt16BE(4);
  const out = [];
  for (let i = 0; i < count; i++) {
    const r = 6 + 12 * i;
    const [platform, encoding, language, id, length, offset] = [0, 2, 4, 6, 8, 10].map((k) => n.readUInt16BE(r + k));
    const bytes = n.subarray(strings + offset, strings + offset + length);
    out.push({ platform, encoding, language, id, text: decode(platform, encoding, bytes), bytes: Buffer.from(bytes) });
  }
  return out;
}

// The text of record (platform, encoding, language, id), or undefined.
function nameText(buf, id, platform = 3, encoding = 1, language = 0x409) {
  const r = nameRecords(buf).find((x) => x.id === id && x.platform === platform && x.encoding === encoding &&
    x.language === language);
  return r ? r.text : undefined;
}

function utf16be(s) {
  const b = Buffer.alloc(s.length * 2);
  for (let i = 0; i < s.length; i++) b.writeUInt16BE(s.charCodeAt(i), 2 * i);
  return b;
}

// A format-0 name table from records {platform, encoding, language, id, bytes}, sorted as the specification asks.
function nameTable(records) {
  const sorted = [...records].sort((a, b) => a.platform - b.platform || a.encoding - b.encoding ||
    a.language - b.language || a.id - b.id);
  const head = Buffer.alloc(6 + 12 * sorted.length);
  head.writeUInt16BE(0, 0);
  head.writeUInt16BE(sorted.length, 2);
  head.writeUInt16BE(head.length, 4);
  let offset = 0;
  sorted.forEach((r, i) => {
    const at = 6 + 12 * i;
    [r.platform, r.encoding, r.language, r.id, r.bytes.length, offset].forEach((v, k) => head.writeUInt16BE(v, at + 2 * k));
    offset += r.bytes.length;
  });
  return Buffer.concat([head, ...sorted.map((r) => r.bytes)]);
}

// The font with table `tag` replaced by `data` (or added).
function withTable(buf, tag, data) {
  const { sfntVersion, tables } = readSfnt(buf);
  const entries = tables.map((t) => ({ tag: t.tag, data: t.tag === tag ? data : buf.subarray(t.offset, t.offset + t.length) }));
  if (!entries.some((e) => e.tag === tag)) entries.push({ tag, data });
  entries.sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  const n = entries.length;
  const dir = Buffer.alloc(12 + 16 * n);
  dir.writeUInt32BE(sfntVersion, 0);
  dir.writeUInt16BE(n, 4);
  let p = 1;
  let e = 0;
  while (p * 2 <= n) { p *= 2; e++; }
  dir.writeUInt16BE(p * 16, 6);
  dir.writeUInt16BE(e, 8);
  dir.writeUInt16BE(n * 16 - p * 16, 10);
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
  const out = Buffer.concat(parts);
  const head = readSfnt(out).tables.find((t) => t.tag === 'head');
  if (head) {
    out.writeUInt32BE(0, head.offset + 8);
    out.writeUInt32BE((0xb1b0afba - checksum(out, '')) >>> 0, head.offset + 8);
  }
  return out;
}

module.exports = { nameRecords, nameTable, nameText, utf16be, withTable };
