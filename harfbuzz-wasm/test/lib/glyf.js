'use strict';
// The glyf overlap flags, read independently of the engine: OVERLAP_SIMPLE (0x40) on the first point flag of a simple
// glyph with contours, OVERLAP_COMPOUND (0x0400) on the first component of a composite. Empty glyphs carry neither.

const { table } = require('./sfnt');

function overlapFlags(font) {
  const head = table(font, 'head');
  const loca = table(font, 'loca');
  const glyf = table(font, 'glyf');
  const n = table(font, 'maxp').readUInt16BE(4);
  const long = head.readInt16BE(50) === 1;
  const at = (g) => (long ? loca.readUInt32BE(4 * g) : 2 * loca.readUInt16BE(2 * g));
  const r = { simple: 0, simpleFlagged: 0, composite: 0, compositeFlagged: 0, unflagged: [] };
  for (let g = 0; g < n; g++) {
    const start = at(g);
    if (at(g + 1) === start) continue; // empty
    const contours = glyf.readInt16BE(start);
    if (contours > 0) {
      const instructions = start + 10 + 2 * contours;
      const flag = glyf[instructions + 2 + glyf.readUInt16BE(instructions)];
      r.simple++;
      if (flag & 0x40) r.simpleFlagged++; else r.unflagged.push(g);
    } else if (contours < 0) {
      r.composite++;
      if (glyf.readUInt16BE(start + 10) & 0x0400) r.compositeFlagged++; else r.unflagged.push(g);
    }
  }
  return r;
}

module.exports = { overlapFlags };
