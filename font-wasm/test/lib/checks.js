'use strict';
// Assertions shared by the cases: the result contract (P1 plan, P1-2) and font comparisons.

const { compareGlyphs } = require('./glyf');
const { checksum, readCollection, readSfnt, tableBytes } = require('./sfnt');

const ERROR_LINE = /^fontwrap: error: /;
const USAGE_LINE = /^fontwrap: usage error: /;

function describe(r) {
  const err = r.threw ? `threw ${r.threw.message}` : `exit ${r.code}`;
  return `${err}; stdout ${JSON.stringify(r.stdout).slice(0, 160)}; stderr ${JSON.stringify(r.stderr).slice(0, 240)}`;
}

// The ids `fontwrap error-ids` lists (the driver loads them before any case; P3b plan, P3b-7).
let ERROR_IDS = null;
function setErrorIds(ids) {
  ERROR_IDS = new Set(ids);
}

// The only stdout line of a failure: {"ok":false,"v":1,"command":...,"error":<a listed id>} (`id` when given).
function failureLine(r, id) {
  const j = r.json;
  return r.stdout.length === 1 && j !== null && j.ok === false && j.v === 1 && 'command' in j &&
    typeof j.error === 'string' && ERROR_IDS !== null && ERROR_IDS.has(j.error) && (!id || j.error === id);
}

// Exit 1, exactly one error line (matching `re` when given), the failure line (with `id` when given), no output
// file, nothing thrown.
function cleanFailure(r, re, id) {
  const errs = r.stderr.filter((l) => ERROR_LINE.test(l));
  return !r.threw && r.code === 1 && !r.outExists && failureLine(r, id) && errs.length === 1 &&
    (!re || re.test(errs[0]));
}

function usageFailure(r) {
  return !r.threw && r.code === 2 && failureLine(r, 'usage') && r.stderr.length > 0 && USAGE_LINE.test(r.stderr[0]);
}

// Exit 0, one JSON line with ok:true, and an output file unless `noOutput`.
function success(r, noOutput) {
  return !r.threw && r.code === 0 && r.json !== null && r.json.ok === true && (noOutput || r.outExists);
}

function warnings(r) {
  return r.stderr.filter((l) => /^fontwrap: warning: /.test(l));
}

function faceBases(buf) {
  return buf.toString('latin1', 0, 4) === 'ttcf' ? readCollection(buf) : [0];
}

function tablesByTag(buf, base = 0) {
  const m = new Map();
  for (const t of readSfnt(buf, base).tables) m.set(t.tag, tableBytes(buf, t));
  return m;
}

// head with checkSumAdjustment zeroed and, when asked, flags bit 11 (WOFF2) and indexToLocFormat (MTX) masked.
function maskedHead(head, opts) {
  const h = Buffer.from(head);
  h.fill(0, 8, 12);
  if (opts.bit11) h[16] &= ~0x08;
  if (opts.locFormat) h.fill(0, 50, 52);
  return h;
}

// head.checkSumAdjustment is right for the whole file (a plain sfnt).
function adjustmentOk(buf) {
  const head = readSfnt(buf).tables.find((t) => t.tag === 'head');
  if (!head) return false;
  const copy = Buffer.from(buf);
  copy.fill(0, head.offset + 8, head.offset + 12);
  const sum = checksum(copy, '');
  return ((0xb1b0afba - sum) >>> 0) === buf.readUInt32BE(head.offset + 8);
}

// Problems between a source font and a converted one, face by face. opts: rebuilt (glyf/loca compared by glyphs),
// bit11, locFormat (head masks), dropped (tags the converted font may lack), normalizePushes (MTX glyph programs).
function fontProblems(src, out, opts = {}) {
  const problems = [];
  const sb = faceBases(src);
  const ob = faceBases(out);
  if (sb.length !== ob.length) return [`${sb.length} faces became ${ob.length}`];
  sb.forEach((base, face) => {
    const a = tablesByTag(src, base);
    const b = tablesByTag(out, ob[face]);
    const dropped = opts.dropped || [];
    for (const tag of a.keys()) if (!b.has(tag) && !dropped.includes(tag)) problems.push(`face ${face}: ${tag} missing`);
    for (const tag of b.keys()) if (!a.has(tag)) problems.push(`face ${face}: ${tag} added`);
    for (const [tag, data] of a) {
      if (!b.has(tag)) continue;
      if (tag === 'head') {
        if (!maskedHead(data, opts).equals(maskedHead(b.get(tag), opts))) problems.push(`face ${face}: head differs`);
      } else if (opts.rebuilt && (tag === 'glyf' || tag === 'loca')) {
        // judged through the glyphs below
      } else if (!data.equals(b.get(tag))) {
        problems.push(`face ${face}: ${tag} differs (${data.length} vs ${b.get(tag).length} bytes)`);
      }
    }
    if (opts.rebuilt && a.has('glyf')) {
      const g = compareGlyphs({ tables: Object.fromEntries(a) }, { tables: Object.fromEntries(b) },
        { normalizePushes: opts.normalizePushes });
      if (!g.equal) problems.push(`face ${face}: ${g.note || `${g.differing.length} glyphs differ, first ${g.differing[0]}`}`);
    }
  });
  return problems;
}

// What google/woff2's loca switch must look like to be allowed (P1 results 12.3; normalize.cc:126-162): short in
// the source, long after the round trip, the normalised (4-byte padded) glyf at least as long as a short loca can
// address, a loca of exactly 4 x (numGlyphs + 1) bytes whose offsets start at 0, never fall, stay inside glyf and end
// at its length. Empty when all of that holds.
const SHORT_LOCA_LIMIT_BYTES = 1 << 17; // 131,072: a short loca addresses glyf offsets up to 2 x 0xFFFF
function locaSwitchProblems(src, out) {
  const a = tablesByTag(src);
  const b = tablesByTag(out);
  const p = [];
  const from = a.get('head').readInt16BE(50);
  const to = b.get('head').readInt16BE(50);
  if (from !== 0 || to !== 1) p.push(`indexToLocFormat ${from} -> ${to}; only 0 -> 1 is allowed`);
  const n = b.get('maxp').readUInt16BE(4);
  const glyf = b.get('glyf');
  const loca = b.get('loca');
  if (glyf.length < SHORT_LOCA_LIMIT_BYTES) p.push(`glyf is ${glyf.length} bytes, below the ${SHORT_LOCA_LIMIT_BYTES} that force a long loca`);
  if (loca.length !== 4 * (n + 1)) {
    p.push(`loca is ${loca.length} bytes, not 4 x (numGlyphs + 1) = ${4 * (n + 1)}`);
    return p;
  }
  let prev = 0;
  for (let i = 0; i <= n; i++) {
    const o = loca.readUInt32BE(4 * i);
    if ((i === 0 && o !== 0) || o < prev || o > glyf.length) { p.push(`loca offset ${i} is ${o}`); return p; }
    prev = o;
  }
  if (prev !== glyf.length) p.push(`the last loca offset ${prev} is not the glyf length ${glyf.length}`);
  return p;
}

// A copy of a plain sfnt whose physically last table starts one byte later (not on a 4-byte boundary).
function withUnalignedTable(buf) {
  const tables = readSfnt(buf).tables;
  const last = tables.reduce((a, b) => (b.offset > a.offset ? b : a));
  const out = Buffer.alloc(buf.length + 4);
  buf.copy(out, 0, 0, last.offset);
  buf.copy(out, last.offset + 1, last.offset, last.offset + last.length);
  out.writeUInt32BE(last.offset + 1, 12 + 16 * tables.indexOf(last) + 8);
  return { font: out, tag: last.tag, offset: last.offset + 1 };
}

module.exports = { adjustmentOk, cleanFailure, describe, faceBases, fontProblems, locaSwitchProblems, maskedHead,
  success, tablesByTag, usageFailure, warnings, withUnalignedTable, failureLine, setErrorIds };
