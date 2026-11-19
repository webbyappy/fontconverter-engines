'use strict';
// The post table's glyph names, read independently of the engine: format 2 through the 258 standard Macintosh names
// (facts/name-tables.json, from fontTools); format 3 has none. And a format 2 table built from a list of names.

const { table } = require('./sfnt');
const { macGlyphNames } = require('../facts/name-tables.json');

function postVersion(font) {
  return table(font, 'post').readUInt32BE(0);
}

// The names of every glyph, or null for a post table without names (format 3).
function postGlyphNames(font) {
  const p = table(font, 'post');
  const v = p.readUInt32BE(0);
  if (v === 0x00030000) return null;
  if (v !== 0x00020000) throw new Error(`post version 0x${v.toString(16)}`);
  const n = p.readUInt16BE(32);
  const custom = [];
  for (let q = 34 + 2 * n; q < p.length;) {
    custom.push(p.toString('latin1', q + 1, q + 1 + p[q]));
    q += 1 + p[q];
  }
  const out = [];
  for (let g = 0; g < n; g++) {
    const k = p.readUInt16BE(34 + 2 * g);
    out.push(k < 258 ? macGlyphNames[k] : custom[k - 258]);
  }
  return out;
}

// A format 2 post table with `base`'s header and these names (each stored as a custom string, .notdef as index 0).
function postV2(base, names) {
  const head = Buffer.from(table(base, 'post').subarray(0, 32));
  head.writeUInt32BE(0x00020000, 0);
  const n = Buffer.alloc(2 + 2 * names.length);
  n.writeUInt16BE(names.length, 0);
  const strings = [];
  let next = 258;
  names.forEach((name, g) => {
    if (name === '.notdef') { n.writeUInt16BE(0, 2 + 2 * g); return; }
    n.writeUInt16BE(next++, 2 + 2 * g);
    strings.push(Buffer.from([name.length]), Buffer.from(name, 'latin1'));
  });
  return Buffer.concat([head, n, ...strings]);
}

module.exports = { postGlyphNames, postV2, postVersion };
