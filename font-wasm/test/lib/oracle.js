'use strict';
// font-oracle.json views and fontwrap-oracle.json's op table and verdict gate (P1 plan, section 2.3). One
// definition, used by N12 and by make-oracle.mjs, so the two can never disagree.

const fs = require('fs');
const path = require('path');
const { fontOracle, fx, readFixture } = require('./fixtures');
const { readCollection, readSfnt } = require('./sfnt');

const FONTWRAP_ORACLE = 'fontwrap-oracle.json';
const MIB = 1024 * 1024;
const Q11_MAX_BYTES = 2 * MIB; // WOFF2 quality 11 up to 2 MiB (roadmap 4.6)
const Q10_MAX_BYTES = 8 * MIB; // quality 10 up to 8 MiB, 9 above
const ENCODE_FOLDERS = ['samples/', 'real/', 'generated/structure/', 'generated/mislabelled/'];
const OUTLINE_TAGS = ['glyf', 'CFF ', 'CFF2'];
const NON_STRICT_GATED = ['parses', 'cmap', 'metrics', 'outline', 'layout', 'names', 'special'];
// The one font whose WOFF2 google/woff2 writes with a long loca (normalize.cc:126-162: glyphs padded to 4 bytes push
// glyf past what a short loca addresses). Owner-approved exception, bound to this file's bytes (P1 results 12.3).
const LOCA_SWITCH = { id: 'real/sourcesans-vf/SourceSans3VF-Upright.ttf',
  sha256: '1147db9a3f0edd4956068de77930148acce2742dd76d57f7239b2b1c687ac63f' };
const LOCA_PROBLEM = /^head differs beyond the allowed fields at byte offsets \[(50, )?51\]$/;
// fontTools rebuilds the transformed hmtx of these three WOFF2 files (which it wrote) 2 bytes short and then cannot
// read it ("not enough 'hmtx' table data: expected 22 bytes, got 20" for slick); each file's directory keeps the
// source's length and fontwrap's decode equals the source. A scorer reading them through fontTools judges fontwrap
// against a broken reference, so their decode is scored against the source font instead (ttf-ttf, strict na, every
// other verdict gated); N5 proves the signature for each, that no other fixture shows it, and the decode equal to the
// source table by table. Bound to the files' bytes (P1 results 12.5; reviewed by Codex).
const FONTTOOLS_HMTX_MISREAD = [
  { id: 'generated/fonttools-wrapped/real/twemoji/Twemoji.Mozilla.ttf.hmtx.woff2',
    sha256: '4f956e7879e88f33e93e53a945fc0d27406366a5389f0cf52d39edaedffb94d3' },
  { id: 'generated/fonttools-wrapped/real/vera/Vera.ttf.hmtx.woff2',
    sha256: 'a7e4b79ed288e250fce44919c575a7efcec8ddcb6688febca48d1889c8736c7e' },
  { id: 'generated/fonttools-wrapped/samples/slick.ttf.hmtx.woff2',
    sha256: 'f18cd46dd34a9fd49fcb5a160859d81880f1ee7ad91f4ea4f080c29d3148e30c' },
];
const HMTX_MISREAD_REASON = "fontTools rebuilds this file's transformed hmtx short and cannot read it; " +
  'judged against its source font (P1 results 12.5)';

function entries() {
  return Object.entries(fontOracle().fixtures);
}

function woff2Quality(size) {
  return size <= Q11_MAX_BYTES ? 11 : size <= Q10_MAX_BYTES ? 10 : 9;
}

function extOf(flavour) {
  return flavour === 'cff' || flavour === 'cff2' ? 'otf' : 'ttf';
}

function tagsOf(fact) {
  return fact && fact.font ? fact.font.tables.map((t) => t.tag) : [];
}

// True when any table of the font (any face of a collection) does not start on a 4-byte boundary: google/woff2
// refuses such a font, so fontwrap refuses it for WOFF2 with a precise message (P1 results 12.3).
function hasUnalignedTable(id) {
  const buf = readFixture(id);
  const bases = buf.toString('latin1', 0, 4) === 'ttcf' ? readCollection(buf) : [0];
  return bases.some((b) => readSfnt(buf, b).tables.some((t) => t.offset % 4 !== 0));
}

function locaSwitchAllowed(id) {
  return id === LOCA_SWITCH.id && fontOracle().fixtures[id].sha256 === LOCA_SWITCH.sha256;
}

function hmtxMisreadListed(id) {
  const e = FONTTOOLS_HMTX_MISREAD.find((x) => x.id === id);
  return Boolean(e) && fontOracle().fixtures[id].sha256 === e.sha256;
}

function bitmapOnly(fact) {
  const tags = tagsOf(fact);
  return tags.length > 0 && !OUTLINE_TAGS.some((t) => tags.includes(t));
}

// Every single sfnt font fontwrap encodes (27 by the oracle of 2026-11-17).
function encodeSet() {
  return entries().filter(([id, f]) => ENCODE_FOLDERS.some((p) => id.startsWith(p)) && f.kind === 'sfnt' &&
    !f.font_error && f.font).map(([id]) => id).sort();
}

function collections() {
  return entries().filter(([, f]) => f.kind === 'collection').map(([id]) => id).sort();
}

function decodable(kind) {
  return entries().filter(([, f]) => f.kind === kind && !f.font_error).map(([id]) => id).sort();
}

function eotFixtures(compression) {
  return entries().filter(([, f]) => f.kind === 'eot' && f.eot && f.eot.compression === compression)
    .map(([id]) => id).sort();
}

// The op table: one entry per recorded output. `backend` decides only the MTX file wasm cannot decode (P1-15).
function opTable(backend = 'wasm') {
  const fo = fontOracle().fixtures;
  const ops = [];
  const add = (fixture, op, argv, inputFrom, extra) => ops.push({ key: `${fixture}#${op}`, fixture, op, argv,
    inputFrom, ...extra });
  for (const id of encodeSet()) {
    const f = fo[id];
    const ext = extOf(f.flavour);
    const bitmap = bitmapOnly(f);
    const ots = f.ots && f.ots.accepted === false;
    const q = woff2Quality(f.size);
    add(id, 'woff', ['woff-encode'], null, { outExt: 'woff', pair: `${ext}-woff`, scoreIn: 'fixture',
      scoreOut: 'output', strictNa: false, bitmap, otsRejected: ots });
    const aligned = !hasUnalignedTable(id);
    if (aligned) {
      add(id, 'woff2', ['woff2-encode', `--quality=${q}`], null, { outExt: 'woff2', pair: `${ext}-woff2`,
        scoreIn: 'fixture', scoreOut: 'output', strictNa: false, bitmap, otsRejected: ots,
        locaSwitch: locaSwitchAllowed(id) });
    }
    if (ext === 'ttf') {
      add(id, 'eot', ['eot-encode'], null, { outExt: 'eot', pair: 'ttf-eot', scoreIn: 'fixture', scoreOut: 'output',
        strictNa: bitmap, bitmap, otsRejected: ots, eotOutput: true });
    } else {
      add(id, 'eot-allow-cff', ['eot-encode', '--allow-cff'], null, { outExt: 'eot', pair: 'otf-eot',
        scoreIn: 'fixture', scoreOut: 'output', strictNa: true, bitmap, otsRejected: ots, eotOutput: true });
    }
    if (aligned) {
      add(id, 'woff2-roundtrip', ['woff2-decode'], `${id}#woff2`, { outExt: ext, pair: `woff2-${ext}`,
        scoreIn: 'input', scoreOut: 'output', strictNa: bitmap, bitmap, otsRejected: ots });
    }
  }
  for (const id of collections().filter((c) => !hasUnalignedTable(c))) {
    add(id, 'woff2', ['woff2-encode', `--quality=${woff2Quality(fo[id].size)}`], null, { outExt: 'woff2',
      unscored: true });
    add(id, 'woff2-roundtrip', ['woff2-decode'], `${id}#woff2`, { outExt: 'ttc', unscored: true });
  }
  for (const kind of ['woff', 'woff2']) {
    for (const id of decodable(kind)) {
      const f = fo[id];
      const ext = extOf(f.flavour);
      if (kind === 'woff2' && hmtxMisreadListed(id)) {
        const src = fo[f.source];
        add(id, 'decode', ['woff2-decode'], null, { outExt: ext, pair: `${ext}-${ext}`, scoreIn: 'expected',
          scoreOut: 'output', strictNa: true, bitmap: bitmapOnly(src),
          otsRejected: src.ots && src.ots.accepted === false, expectedFrom: f.source, reason: HMTX_MISREAD_REASON });
        continue;
      }
      add(id, 'decode', [`${kind}-decode`], null, { outExt: ext, pair: `${kind}-${ext}`, scoreIn: 'fixture',
        scoreOut: 'output', strictNa: false, bitmap: bitmapOnly(f), otsRejected: f.ots && f.ots.accepted === false });
    }
  }
  for (const id of [...eotFixtures('none'), ...eotFixtures('xor')]) {
    const f = fo[id];
    add(id, 'decode', ['eot-decode'], null, { outExt: 'ttf', pair: 'ttf-eot', scoreIn: 'output',
      scoreOut: 'fixture', strictNa: bitmapOnly(f), bitmap: bitmapOnly(f), otsRejected: false, eotOutput: true });
  }
  for (const id of eotFixtures('mtx')) {
    if (backend === 'wasm' && id === 'generated/eot/Noto-COLRv1.mtx.eot') continue; // P1-15: a known limit
    const f = fo[id];
    const src = fo[f.expected_font_from];
    add(id, 'decode', ['eot-decode'], null, { outExt: 'ttf', pair: 'ttf-ttf', scoreIn: 'expected', scoreOut: 'output',
      strictNa: true, bitmap: bitmapOnly(src), otsRejected: src.ots && src.ots.accepted === false,
      expectedFrom: f.expected_font_from });
  }
  return ops;
}

// Every way an entry's recorded score breaks the gate (empty when it meets it).
function gateViolations(op, score) {
  if (op.unscored) return score === null ? [] : ['a collection entry must have score null'];
  if (!score || !score.verdicts) return ['no score recorded'];
  const v = score.verdicts;
  const out = [];
  const qualifiedLocaSwitch = op.locaSwitch === true && v.strict === 'fail' && score.strict_revised === 'pass' &&
    Array.isArray(score.strict_problems) && score.strict_problems.length === 1 &&
    LOCA_PROBLEM.test(score.strict_problems[0]);
  if (op.strictNa ? v.strict !== 'na' : v.strict !== 'pass' && !qualifiedLocaSwitch) {
    out.push(`strict is ${v.strict}, expected ${op.strictNa ? 'na' : 'pass'}`);
  }
  const sanitizerOk = v.sanitizer === 'pass' || (!op.eotOutput && op.otsRejected && v.sanitizer === 'fail');
  if (!sanitizerOk) out.push(`sanitizer is ${v.sanitizer}`);
  if (!op.bitmap) {
    for (const k of NON_STRICT_GATED) if (v[k] === undefined || v[k] === 'fail' || v[k] === 'error') out.push(`${k} is ${v[k]}`);
  }
  return out;
}

// The engine oracle, with `root`: the folder its file paths are relative to. FONTWRAP_ORACLE_FILE points at another
// one (a make-oracle.mjs trial under a scratch root), which N12 must then refuse as partial or scratch.
function engineOracle() {
  const p = process.env.FONTWRAP_ORACLE_FILE || fx(FONTWRAP_ORACLE);
  if (!fs.existsSync(p)) return null;
  return { ...JSON.parse(fs.readFileSync(p, 'utf8')), root: path.dirname(path.resolve(p)) };
}

module.exports = { FONTTOOLS_HMTX_MISREAD, FONTWRAP_ORACLE, LOCA_SWITCH, bitmapOnly, collections, decodable, encodeSet,
  engineOracle, entries, eotFixtures, extOf, gateViolations, hasUnalignedTable, locaSwitchAllowed, opTable, tagsOf,
  woff2Quality };
