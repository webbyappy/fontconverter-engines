'use strict';
// N0: the harness's own readers are right before they judge the engine (P1 plan, P1-13).
//   - lib/sfnt.js reproduces font-oracle.json (fontTools) for every sfnt, collection, WOFF and plain/XOR EOT fixture;
//   - lib/sfnt.js's predicted EOT header equals sfntly's for the 8 sfntly plain EOTs;
//   - lib/glyf.js agrees with fontTools on which glyphs generated/damaged/ changed;
//   - lib/sfnt.js's WOFF2 directory reader agrees with fontTools' facts for every WOFF2 fixture.

const { fontOracle, readFixture } = require('../lib/fixtures');
const { eotPayload, factsOfTables, predictEot, readCollection, readEotHeader, sfntEntries, woffEntries } =
  require('../lib/sfnt');
const { compareGlyphs } = require('../lib/glyf');
const { locaSwitchProblems } = require('../lib/checks');
const { gateViolations } = require('../lib/oracle');
const { readSfnt } = require('../lib/sfnt');

// Decoded glyphs that differ from generated/damaged/control.ttf, per fontTools (computed 2026-11-17 with fontTools
// 4.68.0: glyph A is id 36; the rest are composites using A, whose bounding box fontTools recomputed).
const A_AND_COMPOSITES_X = [36, 130, 131, 132, 133, 134, 135, 194, 196, 198, 358, 367, 447, 638, 640, 706, 716, 718,
  720, 722, 724, 726, 728, 730, 732, 734, 736, 738];
const A_AND_COMPOSITES_Y = A_AND_COMPOSITES_X.filter((g) => g !== 728 && g !== 738);
const DAMAGED_GLYPHS = {
  'control.ttf': [], 'advance-A-plus20.ttf': [], 'cmap-A-dropped.ttf': [], 'kern-AV-removed.ttf': [],
  'kern-Ty-removed.ttf': [], 'name-family-changed.ttf': [],
  'shiftx30.ttf': A_AND_COMPOSITES_X, 'shiftx30-nolsb.ttf': A_AND_COMPOSITES_X,
  'shifty1.ttf': A_AND_COMPOSITES_Y, 'shifty2.ttf': A_AND_COMPOSITES_Y, 'shifty4.ttf': A_AND_COMPOSITES_Y,
  'shifty8.ttf': A_AND_COMPOSITES_Y, 'shifty15.ttf': A_AND_COMPOSITES_Y, 'shifty30.ttf': A_AND_COMPOSITES_Y,
};

function sameTable(a, b) {
  return Boolean(a && b) && a.tag === b.tag && a.length === b.length && a.checksum === b.checksum;
}

function sameFacts(got, want) {
  return got.tables.length === want.tables.length && got.tables.every((t, i) => sameTable(t, want.tables[i])) &&
    got.numGlyphs === want.numGlyphs;
}

function firstTableDifference(got, want) {
  for (let i = 0; i < Math.max(got.tables.length, want.tables.length); i++) {
    if (!sameTable(got.tables[i], want.tables[i])) {
      return `table ${i}: ${JSON.stringify(got.tables[i])} vs oracle ${JSON.stringify(want.tables[i])}`;
    }
  }
  return `numGlyphs ${got.numGlyphs} vs oracle ${want.numGlyphs}`;
}

async function readerFacts(ctx) {
  const fo = fontOracle().fixtures;
  let want = 0;
  let seen = 0;
  for (const [id, f] of Object.entries(fo)) {
    if (f.font_error || !ctx.keep(id)) continue;
    let pairs = null;
    if (f.kind === 'sfnt' && f.font) pairs = () => [[factsOfTables(sfntEntries(readFixture(id))), f.font]];
    else if (f.kind === 'woff' && f.font) pairs = () => [[factsOfTables(woffEntries(readFixture(id))), f.font]];
    else if (f.kind === 'eot' && f.font) pairs = () => [[factsOfTables(sfntEntries(eotPayload(readFixture(id)))), f.font]];
    else if (f.kind === 'collection' && f.faces) {
      pairs = () => {
        const buf = readFixture(id);
        return readCollection(buf).map((base, i) => [factsOfTables(sfntEntries(buf, base)), f.faces[i]]);
      };
    }
    if (!pairs) continue;
    want++;
    const list = pairs();
    seen++;
    const bad = list.findIndex(([got, exp]) => !exp || !sameFacts(got, exp));
    ctx.rep.check(`reader facts ${id}`, bad < 0 && list.length === (f.faces ? f.faces.length : 1),
      bad < 0 ? `face count ${list.length}` : `face ${bad}: ${firstTableDifference(list[bad][0], list[bad][1] || { tables: [] })}`);
  }
  ctx.count('reader facts', seen, want);
}

async function eotPrediction(ctx) {
  const fo = fontOracle().fixtures;
  const plain = Object.keys(fo).filter((id) => /^generated\/eot\/.*\.plain\.eot$/.test(id) && ctx.keep(id)).sort();
  for (const id of plain) {
    const eot = readFixture(id);
    const h = readEotHeader(eot);
    const predicted = predictEot(readFixture(fo[id].source));
    const same = predicted.length === eot.length &&
      predicted.subarray(0, h.fontDataOffset).equals(eot.subarray(0, h.fontDataOffset));
    let where = '';
    if (!same) {
      const n = Math.min(predicted.length, eot.length, h.fontDataOffset);
      let i = 0;
      while (i < n && predicted[i] === eot[i]) i++;
      where = `first difference at byte ${i}; sizes ${predicted.length} vs ${eot.length}`;
    }
    ctx.rep.check(`predicted EOT header = sfntly's for ${id}`, same, where);
  }
  ctx.count('sfntly plain EOTs', plain.length, 8);
}

async function glyphComparator(ctx) {
  const control = readFixture('generated/damaged/control.ttf');
  let seen = 0;
  for (const [name, expected] of Object.entries(DAMAGED_GLYPHS)) {
    const r = compareGlyphs({ font: control }, { font: readFixture(`generated/damaged/${name}`) });
    seen++;
    ctx.rep.check(`glyph comparator on damaged/${name}`, JSON.stringify(r.differing) === JSON.stringify(expected),
      `reported ${r.differing.length} [${r.differing.slice(0, 8).join(',')}…], fontTools ${expected.length}`);
  }
  ctx.count('damaged fonts', seen, 14);
}

function withLocFormat(font, value) {
  const head = readSfnt(font).tables.find((t) => t.tag === 'head');
  const b = Buffer.from(font);
  b.writeInt16BE(value, head.offset + 50);
  return b;
}

// The loca-switch checker and the verdict gate reject everything but the qualified case (P1 results 12.3).
async function exceptionCheckers(ctx) {
  const short = readFixture('samples/OpenSans-Regular.ttf'); // short loca, glyf 78,592 bytes
  ctx.rep.check('the loca checker rejects an unqualified 0 -> 1 (glyf below 128 KiB, a short-sized loca)',
    locaSwitchProblems(short, withLocFormat(short, 1)).length >= 2);
  ctx.rep.check('the loca checker rejects 1 -> 0',
    locaSwitchProblems(withLocFormat(short, 1), short).some((p) => p.includes('1 -> 0')));
  const verdicts = { parses: 'pass', sanitizer: 'pass', cmap: 'pass', metrics: 'pass', outline: 'pass', layout: 'pass',
    names: 'pass', special: 'na', hinting: 'info', size: 'info', strict: 'fail' };
  const op = { locaSwitch: true, strictNa: false, bitmap: false, otsRejected: false };
  const evidence = { verdicts, strict_revised: 'pass',
    strict_problems: ['head differs beyond the allowed fields at byte offsets [51]'] };
  const rows = [
    ['accepts the qualified strict fail', op, evidence, true],
    ['rejects that evidence on any other entry', { ...op, locaSwitch: false }, evidence, false],
    ['rejects two strict problems', op, { ...evidence, strict_problems: [...evidence.strict_problems, 'x'] }, false],
    ['rejects missing problems', op, { verdicts, strict_revised: 'pass' }, false],
    ['rejects a missing revised verdict', op, { verdicts, strict_problems: evidence.strict_problems }, false],
    ['rejects a difference at another head byte', op, { ...evidence,
      strict_problems: ['head differs beyond the allowed fields at byte offsets [18]'] }, false],
  ];
  for (const [what, o, score, accepted] of rows) {
    ctx.rep.check(`the gate ${what}`, (gateViolations(o, score).length === 0) === accepted, gateViolations(o, score).join('; '));
  }
}

// lib/sfnt.js's WOFF2 directory reader agrees with fontTools on all 29 (single-font) WOFF2 fixtures: the same tags,
// and every table stored as is has origLength equal to fontTools' decoded length (glyf, loca and a transformed hmtx
// are rebuilt by a decoder, so their decoded length is the decoder's, not the directory's); hmtx is transformed
// exactly in the *.hmtx.woff2 files.
async function woff2Directories(ctx) {
  const sfnt = require('../lib/sfnt');
  const fo = fontOracle().fixtures;
  let n = 0;
  for (const [id, f] of Object.entries(fo).sort()) {
    if (f.kind !== 'woff2' || f.font_error || !f.font) continue;
    n++;
    if (typeof sfnt.woff2Directory !== 'function') {
      ctx.rep.fail(`the WOFF2 directory reader agrees with fontTools: ${id}`, 'lib/sfnt.js has no woff2Directory');
      continue;
    }
    const dir = sfnt.woff2Directory(readFixture(id));
    const want = new Map(f.font.tables.map((t) => [t.tag, t.length]));
    const p = [];
    if (dir.tables.length !== want.size) p.push(`${dir.tables.length} tables, oracle ${want.size}`);
    for (const t of dir.tables) {
      if (!want.has(t.tag)) { p.push(`${t.tag} not in the oracle`); continue; }
      const rebuilt = t.tag === 'glyf' || t.tag === 'loca' || (t.tag === 'hmtx' && t.transformed);
      if (!rebuilt && t.origLength !== want.get(t.tag)) {
        p.push(`${t.tag} origLength ${t.origLength}, oracle ${want.get(t.tag)}`);
      }
    }
    const hmtx = dir.tables.find((t) => t.tag === 'hmtx');
    // A .hmtx.woff2 asks fontTools for the hmtx transform, which WOFF2 allows only when every glyph's lsb is its xMin;
    // fontTools then writes hmtx untransformed (checked with fontTools' WOFF2Reader: transformVersion 0).
    const untransformable = HMTX_UNTRANSFORMABLE.has(id);
    if (hmtx && hmtx.transformed !== (id.endsWith('.hmtx.woff2') && !untransformable)) {
      p.push(`hmtx transformed: ${hmtx.transformed}`);
    }
    ctx.rep.check(`the WOFF2 directory reader agrees with fontTools: ${id}`, p.length === 0, p.join('; '));
  }
  // +4 in P3b: fontTools' WOFF2 of Nabla and of Bungee Color's SVG build, plain and .hmtx (fontconverter-web P3b plan, §2)
  ctx.count('WOFF2 fixtures read by the directory reader', n, 33);
}

// Fonts some of whose glyphs have an lsb other than their xMin (Bungee Color's SVG build: 16 glyphs), so fontTools
// cannot transform hmtx (WOFF2 section 5.4) though the file is named .hmtx.woff2 (P3b).
const HMTX_UNTRANSFORMABLE = new Set(['generated/fonttools-wrapped/real/color-svg/BungeeColor-Regular_svg.ttf.hmtx.woff2']);

module.exports = {
  id: 'N0', title: 'harness self-check', needsEngine: false,
  async run(ctx) {
    await readerFacts(ctx);
    await eotPrediction(ctx);
    await glyphComparator(ctx);
    await exceptionCheckers(ctx);
    await woff2Directories(ctx);
  },
};
