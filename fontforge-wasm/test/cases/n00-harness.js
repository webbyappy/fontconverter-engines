'use strict';
// N0: the harness checks itself before it judges the engine (P2 plan, section 5).

const fs = require('fs');
const { STEP0, fontOracle, readFixture, readJson } = require('../lib/fixtures');
const { facts } = require('../lib/sfnt');
const svg = require('../lib/svgfont');
const oracle = require('../lib/oracle');

// Measured in step 0 with Python's ElementTree (P2 plan 2.2): <glyph> elements, exact repeats, <hkern> rules.
const SVG_FACTS = [
  ['twin/arm64/real/fontawesome-web/fa-solid-900.ttf/svg/folder/fa-solid-900.svg', 1977, 0, null],
  [`${STEP0}/m1/out/real/fontawesome-web/fa-solid-900.ttf/svg.svg`, 2551, 574, null],
  ['twin/arm64/real/inter/Inter-Regular.ttf/svg/folder/Inter-Regular.svg', 2956, 0, 11323],
  [`${STEP0}/m1/out/real/inter/Inter-Regular.ttf/svg.svg`, 2975, 19, 11323],
  ['twin/arm64/real/dejavu/DejaVuSans.ttf/svg/folder/DejaVuSans.svg', 6253, null, 805],
];

function passing() {
  const verdicts = { parses: 'pass', sanitizer: 'pass', cmap: 'pass', metrics: 'pass', outline: 'pass', layout: 'pass',
    names: 'pass', special: 'na', hinting: 'info', size: 'info', strict: 'na' };
  const score = () => ({ verdicts: { ...verdicts }, outline_failing_revised: 0, unmapped_failing_revised: 0,
    unmapped_verdict: 'pass', ink_box_over_1px: 0, pair_matrix_mismatches: 0 });
  return { score_source: score(), baseline: score(), twin: { reference: 'arm64', arm64: { sha256: 'x', score: score(),
    parity: { differences: [{ class: 'table-bytes:FFTM' }, { class: 'head-checksum' }] } } } };
}

const NEGATIVE = [
  ['a worse baseline verdict', (e) => { e.score_source.verdicts.outline = 'fail'; }],
  ['a grown pair-matrix count', (e) => { e.score_source.pair_matrix_mismatches = 3; }],
  ['a grown unmapped count', (e) => { e.score_source.unmapped_failing_revised = 2; }],
  ['a first-run error verdict', (e) => { e.score_source.verdicts.names = 'error'; e.baseline.verdicts.names = 'error'; }],
  ['a missing score record', (e) => { e.score_source = null; }],
  ['a twin scorer verdict over the bound', (e) => { e.twin.arm64.score.verdicts.outline = 'fail'; }],
  ['an unmapped-glyph failure on a twin pair', (e) => { e.twin.arm64.score.unmapped_verdict = 'fail'; }],
  ['a parity class outside the allowed set', (e) => { e.twin.arm64.parity.differences.push({ class: 'os2-field:usFirstCharIndex' }); }],
  ["another entry's exception", (e) => { e.twin.arm64.parity.differences.push({ class: 'os2-field:sTypoAscender' }); }],
  ['a sanitizer fail without inherited evidence', (e) => {
    e.score_source.verdicts.sanitizer = 'fail'; e.baseline.verdicts.sanitizer = 'fail'; }],
];

// P2-25 (B10): the gate's rules for an SVG structure failure production shares (complete code-point sets, ours a
// subset of production's), a scorer that cannot load an SVG of 65,533 glyphs (parity_diff still judges), and an
// exception pinned to its exact detail. Each with the near misses it must refuse.
function gateB10(ctx, ops) {
  const op = (key) => ops.find((o) => o.key === key);
  const check = (what, o, e, pass) => {
    const v = oracle.gateViolations(o, e);
    ctx.rep.check(`gate: ${what} ${pass ? 'passes' : 'is a violation'}`, pass ? v.length === 0 : v.length > 0,
      pass ? v.join('; ') : 'no violation');
  };
  const svgOp = op('samples/slick.ttf#svg');
  const shared = (ours, theirs, problems) => {
    const e = passing();
    e.score_source.verdicts.sanitizer = 'fail';
    e.baseline.verdicts.sanitizer = 'fail';
    e.sanitizer_evidence = { kind: 'twin-structure', reference: 'arm64', ours, twin: theirs,
      scorer_problems: problems || ["5 input code points have no <glyph unicode>: ['U+FB00']"] };
    return e;
  };
  check('an SVG structure failure production shares', svgOp,
    shared({ missing: [0xfb01], repeated: [] }, { missing: [0xfb01, 0xfb02], repeated: [] },
      ["1 input code points have no <glyph unicode>: ['U+FB01']"]), true);
  check("an SVG structure failure whose scorer count is not the set's size", svgOp,
    shared({ missing: [0xfb01], repeated: [] }, { missing: [0xfb01, 0xfb02], repeated: [] },
      ["2 input code points have no <glyph unicode>: ['U+FB01', 'U+FB02']"]), false);
  const ots = passing();
  ots.score_source.verdicts.sanitizer = 'fail';
  ots.baseline.verdicts.sanitizer = 'fail';
  ots.sanitizer_evidence = { kind: 'source-ots', source_accepted: false, source_messages: [], output_messages: [] };
  check('an OTS failure with no messages on either side', op('samples/slick.ttf#otf'), ots, false);
  const bigCff = { fid: 'real/notocjk/NotoSansCJKjp-Regular.otf', target: 'ttf', route: 'cff-ttf' };
  ctx.rep.check('twinRefs: no reference on CFF -> TrueType without the amd64 twin (never a fallback to arm64)',
    oracle.twinRefs(bigCff).reference === null, JSON.stringify(oracle.twinRefs(bigCff).reference));
  check('an SVG output missing a code point production maps', svgOp,
    shared({ missing: [0xfb01, 0x41], repeated: [] }, { missing: [0xfb01], repeated: [] }), false);
  check('an SVG structure problem of another kind', svgOp,
    shared({ missing: [], repeated: [] }, { missing: [], repeated: [] }, ['the file is not XML']), false);

  const limit = op('generated/limits/cff-65533.otf#svg');
  const unloadable = (srcError, twinError) => {
    const e = passing();
    e.score_source = { error: srcError, verdicts: {} };
    e.baseline = { error: srcError, verdicts: {} };
    e.twin.arm64.score = { error: twinError, verdicts: {} };
    e.twin.arm64.parity = { differences: [{ class: 'svg-metadata-generator' }, { class: 'svg-source-mapping-kept' }] };
    return e;
  };
  const OUR = 'cannot load output: OverflowError: int too big to convert';
  const THEIRS = "cannot load input: error: 'H' format requires 0 <= number <= 65535";
  check('a 65,533-glyph SVG the scorer cannot load, judged by parity_diff', limit, unloadable(OUR, THEIRS), true);
  const parityBad = unloadable(OUR, THEIRS);
  parityBad.twin.arm64.parity.differences.push({ class: 'svg-glyph-missing' });
  check('such an SVG with a parity class outside the allowed set', limit, parityBad, false);
  check('such an SVG failing the scorer another way', limit, unloadable('cannot load output: KeyError', THEIRS), false);
  check('an SVG the scorer cannot load on an entry without that exception', svgOp, unloadable(OUR, THEIRS), false);

  const os = op('derived/OpenSans-Regular.svg#ttf');
  const ranges = (detail) => {
    const e = passing();
    e.twin.arm64.parity.differences.push({ class: 'os2-field:ulUnicodeRange3', detail });
    return e;
  };
  check('the corrected Unicode range bit (pinned 32 -> 40)', os, ranges('32 -> 40'), true);
  check('another value of that pinned field', os, ranges('32 -> 48'), false);

  // fontforge-0003 writes a sequence as base + selector, so the scorer (production's SVG as its input) sees the
  // lone selector production mapped as unmapped: accepted only for lone selectors, with the corrected class present.
  const uvs = op('generated/aliases/slick-aliases-uvs.ttf#svg');
  const lacking = (cps, corrected, scorer) => {
    const e = passing();
    e.twin.arm64.score.verdicts.cmap = 'fail';
    e.twin.arm64.score.cmap = scorer || { n_missing: cps.length, missing: cps, n_advance_mismatch: 0, mapped_pct: 87.5,
      all_three_pct: 87.5 };
    e.twin.arm64.lacking = cps;
    if (corrected) e.twin.arm64.parity.differences.push({ class: 'svg-uvs-text-corrected' });
    return e;
  };
  check('a twin cmap failure on lone selectors production wrote, corrected', uvs, lacking([0xfe01], true), true);
  check('a twin cmap failure on an ordinary code point', uvs, lacking([0xfe01, 0x41], true), false);
  check('a twin cmap failure on lone selectors without the corrected class', uvs, lacking([0xfe01], false), false);
  check('a twin cmap failure the scorer counts differently', uvs, lacking([0xfe01], true,
    { n_missing: 2, missing: [0xfe01], n_advance_mismatch: 0, mapped_pct: 75, all_three_pct: 75 }), false);
  check('a twin cmap failure with an advance mismatch besides', uvs, lacking([0xfe01], true,
    { n_missing: 1, missing: [0xfe01], n_advance_mismatch: 1, mapped_pct: 87.5, all_three_pct: 75 }), false);
  check('a twin cmap failure with an outline mismatch on a mapped code point besides', uvs, lacking([0xfe01], true,
    { n_missing: 1, missing: [0xfe01], n_advance_mismatch: 0, mapped_pct: 87.5, all_three_pct: 75 }), false);

  const el = (name, u, d) => ({ tag: 'glyph', attrs: { 'glyph-name': name, unicode: u, d } });
  const prod = [el('a', 'a', 'M1'), el('a', 'A', 'M1'), el('b', 'b', 'M2')];
  const map = new Map([[0x61, 1], [0x41, 1], [0x100, 1], [0x62, 2]]);
  ctx.rep.check('aliasJustified: a source alias drawn like production\'s element', svg.aliasJustified(el('a', '\u0100', 'M1'), prod, map));
  ctx.rep.check('aliasJustified: an exact copy of production\'s element is not an alias', !svg.aliasJustified(el('a', 'a', 'M1'), prod, map));
  ctx.rep.check('aliasJustified: an alias on another glyph is not justified', !svg.aliasJustified(el('b', '\u0100', 'M2'), prod, map));
  const doc = (els) => els.map((e) => `<glyph glyph-name="${e[0]}" unicode="${e[1]}" d="M0"/>`).join('');
  ctx.rep.check('newRepeats: a second copy production does not have is a new repeat',
    svg.newRepeats(doc([['a', 'a'], ['a', 'a']]), doc([['a', 'a']])).length === 1);
  ctx.rep.check('newRepeats: a repeat production has too is not new',
    svg.newRepeats(doc([['a', 'a'], ['a', 'a']]), doc([['a', 'a'], ['a', 'a']])).length === 0);
}

module.exports = {
  id: 'N0', title: 'harness self-check', needsEngine: false,
  async run(ctx) {
    const fixtures = fontOracle().fixtures;
    let n = 0;
    for (const [fid, f] of Object.entries(fixtures)) {
      if (f.kind !== 'sfnt' || f.font_error || !ctx.keep(fid)) continue;
      n++;
      const got = facts(readFixture(fid));
      const want = { tables: f.font.tables.map((t) => ({ tag: t.tag, length: t.length, checksum: t.checksum })),
        numGlyphs: f.font.numGlyphs, flavour: f.flavour, special: f.font.special };
      ctx.rep.check(`sfnt facts ${fid}`, JSON.stringify(got) === JSON.stringify(want),
        `got ${JSON.stringify(got).slice(0, 200)} want ${JSON.stringify(want).slice(0, 200)}`);
    }
    ctx.count('sfnt fixtures read', n, 77); // font-oracle.json's sfnt fixtures (B10 added one, fontforge-0009 one; P3b 18, scorer R8 1)

    for (const [rel, glyphs, repeats, kerns] of SVG_FACTS) {
      const text = readFixture(rel).toString('utf8');
      const g = svg.glyphs(text).filter((el) => el.tag === 'glyph').length;
      const r = svg.repeats(text);
      const k = svg.kerns(text).length;
      ctx.rep.check(`svg reader ${rel.split('/').slice(-3).join('/')}`, g === glyphs && (repeats === null || r === repeats) &&
        (kerns === null || k === kerns), `glyphs ${g}/${glyphs} repeats ${r}/${repeats} kerns ${k}/${kerns}`);
    }

    const ops = oracle.opTable();
    const twin = ops.filter((o) => o.twin);
    ctx.rep.check('op table size', ops.length === oracle.PINNED.entries && twin.length === oracle.PINNED.twinJudged &&
      ops.length - twin.length === oracle.PINNED.sourceOnly, `${ops.length} entries, ${twin.length} twin-judged`);
    const step0 = readJson(`${STEP0}/m1/jobs.json`).jobs.map((j) => `${j.fid}#${j.target}`).sort();
    const parity = oracle.paritySet(fixtures).map((o) => o.key).sort();
    ctx.rep.check('parity set equals step 0 jobs', JSON.stringify(parity) === JSON.stringify(step0),
      `${parity.length} vs ${step0.length}`);
    const p2 = twin.filter((o) => !step0.includes(o.key)).map((o) => o.key);
    ctx.rep.check('the p2 jobs', p2.length === 28 && p2.every((k) => k.startsWith('generated/')), p2.join(', '));
    ctx.rep.check('every op input exists', ops.every((o) => fs.existsSync(require('../lib/fixtures').fx(o.input.rel))),
      'a missing input');

    const base = ops.find((o) => o.key === 'samples/slick.ttf#otf');
    ctx.rep.check('gate: a passing entry passes', oracle.gateViolations(base, passing()).length === 0,
      oracle.gateViolations(base, passing()).join('; '));
    const inherited = passing();
    inherited.score_source.verdicts.sanitizer = 'fail';
    inherited.baseline.verdicts.sanitizer = 'fail';
    inherited.sanitizer_evidence = { kind: 'twin', twin_verdict: 'fail', twin_problems: ['x'], output_problems: ['x'] };
    ctx.rep.check('gate: an inherited sanitizer fail passes', oracle.gateViolations(base, inherited).length === 0,
      oracle.gateViolations(base, inherited).join('; '));
    for (const [what, mutate] of NEGATIVE) {
      const e = passing();
      mutate(e);
      const v = oracle.gateViolations(base, e);
      ctx.rep.check(`gate: ${what} is a violation`, v.length > 0, 'no violation');
    }
    // P2-14: on CFF -> TrueType the twins' own disagreement bounds outline and unmapped-glyph failures, nothing else.
    const cffTtf = ops.find((o) => o.key === 'samples/slick.otf#ttf');
    const bounded = () => {
      const e = passing();
      e.twin.twin_vs_twin = { verdicts: {}, outline_failing_revised: 5, unmapped_failing_revised: 0 };
      e.twin.arm64.score.verdicts.outline = 'fail';
      e.twin.arm64.score.outline_failing_revised = 5;
      return e;
    };
    ctx.rep.check('gate: a CFF -> TrueType outline failure within the twins\' bound passes',
      oracle.gateViolations(cffTtf, bounded()).length === 0, oracle.gateViolations(cffTtf, bounded()).join('; '));
    const cmapFail = bounded();
    cmapFail.twin.arm64.score.verdicts.cmap = 'fail';
    ctx.rep.check('gate: a CFF -> TrueType cmap failure is a violation even within the bound',
      oracle.gateViolations(cffTtf, cmapFail).length > 0, 'no violation');
    gateB10(ctx, ops);
  },
};
