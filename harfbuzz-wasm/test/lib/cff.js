'use strict';
// A CFF table as the harness reads it (fontconverter-web P3b plan, section 4.1, N4): the FontName and the byte ranges
// a FontName change must leave equal: CharStrings, Global Subrs, charset, FDSelect, and every Private DICT with its
// local Subrs (the top one, or each FDArray font's). Independent of hbfont's cff.cc.

function index(c, at) {
  const count = c.readUInt16BE(at);
  if (count === 0) return { count, items: [], end: at + 2 };
  const off = c[at + 2];
  const data = at + 3 + (count + 1) * off - 1;
  const o = (i) => c.readUIntBE(at + 3 + i * off, off);
  const items = [];
  for (let i = 0; i < count; i++) items.push(c.subarray(data + o(i), data + o(i + 1)));
  return { count, items, end: data + o(count) };
}

function dict(d) {
  const out = new Map();
  let stack = [];
  for (let p = 0; p < d.length;) {
    const b = d[p];
    if (b <= 21) {
      const op = b === 12 ? 1200 + d[p + 1] : b;
      p += b === 12 ? 2 : 1;
      out.set(op, stack);
      stack = [];
    } else if (b === 28) { stack.push(d.readInt16BE(p + 1)); p += 3; }
    else if (b === 29) { stack.push(d.readInt32BE(p + 1)); p += 5; }
    else if (b === 30) { p++; while ((d[p] & 0x0f) !== 0x0f && (d[p] >> 4) !== 0x0f) p++; p++; stack.push(0); }
    else if (b <= 246) { stack.push(b - 139); p += 1; }
    else if (b <= 250) { stack.push((b - 247) * 256 + d[p + 1] + 108); p += 2; }
    else { stack.push(-(b - 251) * 256 - d[p + 1] - 108); p += 2; }
  }
  return out;
}

// The parts of a CFF table: {fontName, charStrings[], globalSubrs[], charset, fdSelect, privates: [{dict, subrs[]}]}.
function cffParts(c) {
  const names = index(c, c[2]);
  const top = index(c, names.end);
  const strings = index(c, top.end);
  const gsubrs = index(c, strings.end);
  const t = dict(top.items[0]);
  const charStrings = index(c, t.get(17)[0]);
  const privateOf = (entry) => {
    if (!entry) return null;
    const [size, at] = entry;
    const p = c.subarray(at, at + size);
    const subrs = dict(p).get(19);
    return { dict: p, subrs: subrs ? index(c, at + subrs[0]).items : [] };
  };
  const privates = [];
  if (t.has(1236)) {
    for (const fd of index(c, t.get(1236)[0]).items) privates.push(privateOf(dict(fd).get(18)));
  } else {
    privates.push(privateOf(t.get(18)));
  }
  const n = charStrings.count;
  const cs = t.get(15) ? t.get(15)[0] : 0;
  const charset = cs > 2 ? charsetBytes(c, cs, n) : Buffer.alloc(0);
  const fdSelect = t.has(1237) ? fdSelectBytes(c, t.get(1237)[0], n) : Buffer.alloc(0);
  return { fontName: names.items[0].toString('latin1'), charStrings: charStrings.items, globalSubrs: gsubrs.items,
    charset, fdSelect, privates };
}

function charsetBytes(c, at, n) {
  const f = c[at];
  if (f === 0) return c.subarray(at, at + 1 + 2 * (n - 1));
  let p = at + 1;
  let g = 1;
  while (g < n) {
    const left = f === 1 ? c[p + 2] : c.readUInt16BE(p + 2);
    p += f === 1 ? 3 : 4;
    g += left + 1;
  }
  return c.subarray(at, p);
}

function fdSelectBytes(c, at, n) {
  const f = c[at];
  if (f === 0) return c.subarray(at, at + 1 + n);
  const ranges = c.readUInt16BE(at + 1);
  return c.subarray(at, at + 3 + 3 * ranges + 2);
}

// The parts that must stay byte for byte, as one comparable list of [label, Buffer].
function invariantParts(parts) {
  const out = [['charset', parts.charset], ['FDSelect', parts.fdSelect]];
  parts.charStrings.forEach((b, i) => out.push([`CharStrings ${i}`, b]));
  parts.globalSubrs.forEach((b, i) => out.push([`Global Subrs ${i}`, b]));
  parts.privates.forEach((p, i) => {
    if (!p) return;
    out.push([`Private ${i}`, p.dict]);
    p.subrs.forEach((b, k) => out.push([`Private ${i} Subrs ${k}`, b]));
  });
  return out;
}

// The deepest operand run of a Type 2 charstring: the most operands on the stack before an operator clears it (width
// included). CFF1 allows 48. Hint masks are skipped by their stem count; a subroutine call ends a run (HarfBuzz's
// downgrade writes none here: N3 checks the font's Subrs are empty first).
function maxOperandRun(cs) {
  let depth = 0;
  let worst = 0;
  let stems = 0;
  for (let p = 0; p < cs.length;) {
    const b = cs[p];
    if (b === 28) { depth++; p += 3; } else if (b >= 32 && b <= 246) { depth++; p += 1; }
    else if (b >= 247 && b <= 254) { depth++; p += 2; } else if (b === 255) { depth++; p += 5; }
    else {
      worst = Math.max(worst, depth);
      if (b === 1 || b === 3 || b === 18 || b === 23) stems += Math.floor(depth / 2); // h/v stem (hm)
      if (b === 19 || b === 20) { // hintmask, cntrmask: implicit vstems, then the mask bytes
        stems += Math.floor(depth / 2);
        p += 1 + Math.ceil(stems / 8);
      } else {
        p += b === 12 ? 2 : 1;
      }
      depth = 0;
    }
  }
  return Math.max(worst, depth);
}

// The glyph names of a name-keyed CFF (charset SIDs through the standard strings and the String INDEX), or null for a
// CID-keyed one (ROS in its Top DICT). `standard`: the 391 standard strings (facts/name-tables.json).
function cffGlyphNames(c, standard) {
  const names = index(c, c[2]);
  const top = index(c, names.end);
  const strings = index(c, top.end);
  const t = dict(top.items[0]);
  if (t.has(1230)) return null;
  const n = index(c, t.get(17)[0]).count;
  const sid = (s) => (s < 391 ? standard[s] : strings.items[s - 391].toString('latin1'));
  const at = t.get(15) ? t.get(15)[0] : 0;
  if (at <= 2) throw new Error(`a predefined charset (${at})`);
  const out = ['.notdef'];
  let p = at + 1;
  if (c[at] === 0) {
    for (let g = 1; g < n; g++, p += 2) out.push(sid(c.readUInt16BE(p)));
  } else {
    while (out.length < n) {
      const first = c.readUInt16BE(p);
      const left = c[at] === 1 ? c[p + 2] : c.readUInt16BE(p + 2);
      p += c[at] === 1 ? 3 : 4;
      for (let k = 0; k <= left && out.length < n; k++) out.push(sid(first + k));
    }
  }
  return out;
}

// The Top DICT's operators, in order.
function topDictOps(c) {
  const names = index(c, c[2]);
  return [...dict(index(c, names.end).items[0]).keys()];
}

// A CID-keyed CFF whose FDArray is replaced by an INDEX of `fdDicts` (DICT bytes) appended to the table; the Top DICT's
// FDArray operand must be a 5-byte integer (HarfBuzz writes them so) and is rewritten in place.
function withFdArray(c, fdDicts) {
  const names = index(c, c[2]);
  const topAt = names.end;
  const top = index(c, topAt);
  const d = top.items[0];
  const start = d.byteOffset - c.byteOffset;
  let operand = -1;
  for (let p = 0; p < d.length;) {
    const b = d[p];
    if (b <= 21) {
      const op = b === 12 ? 1200 + d[p + 1] : b;
      if (op === 1236) break;
      operand = -1;
      p += b === 12 ? 2 : 1;
    } else {
      operand = b === 29 ? p : -1;
      p += b === 28 ? 3 : b === 29 ? 5 : b === 30 ? (() => { let q = p + 1; while ((d[q] & 0x0f) !== 0x0f && (d[q] >> 4) !== 0x0f) q++; return q + 1 - p; })() : b <= 246 ? 1 : 2;
    }
  }
  if (operand < 0) throw new Error('the FDArray operand is not a 5-byte integer');
  const head = Buffer.alloc(3 + 4 * (fdDicts.length + 1));
  head.writeUInt16BE(fdDicts.length, 0);
  head[2] = 4;
  let off = 1;
  fdDicts.forEach((x, i) => { head.writeUInt32BE(off, 3 + 4 * i); off += x.length; });
  head.writeUInt32BE(off, 3 + 4 * fdDicts.length);
  const out = Buffer.concat([c, head, ...fdDicts]);
  out.writeInt32BE(c.length, start + operand + 1);
  return out;
}

// The FD dicts of a CID-keyed CFF (DICT bytes).
function fdDicts(c) {
  const names = index(c, c[2]);
  const t = dict(index(c, names.end).items[0]);
  return index(c, t.get(1236)[0]).items.map((x) => Buffer.from(x));
}

module.exports = { cffGlyphNames, cffParts, fdDicts, invariantParts, maxOperandRun, topDictOps, withFdArray };
