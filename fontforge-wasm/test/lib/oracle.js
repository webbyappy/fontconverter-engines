'use strict';
// The op table and the one gate (P2 plan, sections 3.5 and 2.3), shared by make-oracle.mjs and N0, N2-N4, N12.

const fs = require('fs');
const path = require('path');
const { FONT_FIXTURES, fontOracle, fontwrapOracle, twinFile } = require('./fixtures');

const FFCONV_ORACLE = 'ffconv-oracle.json';
const PARITY_MAX_INPUT_BYTES = 8 * 1024 * 1024; // 8 MiB: D8's cap bounds the parity set (P2-19)
const REFUSED = ['fvar', 'COLR', 'CBDT', 'sbix', 'SVG ', 'CFF2'];
const TARGETS = { truetype: ['otf', 'svg'], cff: ['ttf', 'svg'], svg: ['ttf', 'otf'] };
const INNER_EXT = { truetype: 'ttf', cff: 'otf', svg: 'svg' };

// The twin's set p2 (P2 plan 3.3, grown in B10 by P2-25's evidence), with their targets; cff-65534 -> ttf is N6's
// failure, not an entry. Every FontForge-engine fixture but the 5 MiB font is judged against production.
const P2_TWIN = {
  'generated/aliases/slick-aliases-fmt4.ttf': ['otf', 'svg'],
  'generated/aliases/slick-aliases-fmt12.ttf': ['otf', 'svg'],
  'generated/aliases/slick-aliases-nonames.ttf': ['otf', 'svg'],
  'generated/aliases/slick-aliases-uvs.ttf': ['otf', 'svg'],
  'generated/aliases/slick-aliases-uvs-nonascii.ttf': ['otf', 'svg'],
  'generated/cid/NotoSansCJKjp-cid-small.otf': ['ttf', 'svg'],
  'generated/limits/cff-65533.otf': ['ttf', 'svg'],
  'generated/limits/cff-65534.otf': ['svg'],
  'generated/mislabelled/OpenSans-Regular-truetype.otf': ['svg'],
  ...Object.fromEntries(['bad-checksum', 'italic-bold', 'mac-names-and-cmap', 'noncanonical', 'os2-v0', 'with-hdmx']
    .map((n) => [`generated/structure/${n}.ttf`, ['otf', 'svg']])),
};
// Judged against their source only: production returns an upload unchanged when its extension already is the
// target's (the twin ran no FontForge for this one: a TrueType font named .otf comes back as the same file), so the
// twin cannot judge ffconv's conversion of it. The 5 MiB font (LARGE) is over the twin's amd64 limit.
const SOURCE_ONLY = { 'generated/mislabelled/OpenSans-Regular-truetype.otf': ['otf'] };
const LARGE = 'generated/large/NotoSansCJKjp-cid-5mib.otf';
const PINNED = { entries: 68, twinJudged: 66, sourceOnly: 2 };

// The policy parity_diff.py --classes prints, pinned here so that a change on either side is caught (N0, N12).
const ALLOWED = ['table-bytes:FFTM', 'head-checksum', 'cmap-encoding', 'layout-feature-order', 'svg-metadata-generator',
  'cmap-uvs-default-kept', 'GDEF-class-as-source', 'cmap-source-alias-kept', 'svg-source-mapping-kept',
  'svg-uvs-text-corrected', 'svg-empty-duplicate-omitted'];
const ALLOWED_CFF_TO_TRUETYPE = ['table-bytes:glyf', 'table-bytes:loca', 'table-bytes:hmtx', 'table-bytes:maxp'];
// Named exceptions (P2 plan 2.3; P2-25, the owner's decisions of 2026-11-18): classes accepted beyond the policy
// (`details`: a class accepted only with exactly that detail), scorer checks allowed to fail against the twin, and
// `scorerUnavailable`: the scorer messages that mean it cannot load this SVG (either side); then its verdicts are not
// required and parity_diff judges alone.
const SLICK_SVG = { classes: ['os2-field:sTypoAscender', 'os2-field:sTypoDescender'], scorer: ['metrics'],
  reason: 'FontForge 20230101 sets OS/2 typo ascender/descender from an SVG input differently (S3 5.4)' };
const OPENSANS_SVG = { classes: ['os2-field:ulUnicodeRange3'], details: { 'os2-field:ulUnicodeRange3': '32 -> 40' },
  scorer: [], reason: 'FontForge 20230101 corrected its Unicode range table: U+FEFF is in Arabic Presentation ' +
    'Forms-B (bit 67), as the OpenType spec says; 20190801 ended that range at U+FEEF (P2-25 B)' };
const LIMIT_SVG = { classes: [], scorer: [], scorerUnavailable: [/^cannot load output: OverflowError: int too big to convert/,
  /^cannot load input: error: 'H' format requires 0 <= number <= 65535/],
reason: "the scorer's SVG loader cannot build its temporary font for an SVG font of 65,533 glyphs or more, ours or " +
    "production's (P2-25 F); parity_diff, which names only source-backed additions, judges it" };
// P2-25 H: a Mac-Roman-only font's alias code points come from iconv's MACINTOSH table (GNU libiconv here, glibc in
// production): ffconv adds U+00A4 to currency where production adds U+E01E to apple, and in SVG .notdef carries
// U+2126/U+2206 where production's carries U+0394. Pinned exactly; N8 pins ffconv's mappings themselves.
const MAC_OTF = { classes: ['cmap-mapping'], scorer: ['cmap'], details: {
  'cmap-mapping': '2 code points differ: U+00A4 None->currency, U+E01E apple->None' },
reason: "alias code points from iconv's MACINTOSH table: GNU libiconv here, glibc in production (P2-25 H)" };
const MAC_SVG = { classes: ['svg-glyph-extra', 'svg-glyph-missing'], scorer: ['cmap'], details: {
  'svg-glyph-extra': '3: .notdef, .notdef, currency', 'svg-glyph-missing': '2: .notdef, apple' },
reason: MAC_OTF.reason };
const EXCEPTIONS = { 'derived/slick.svg#ttf': SLICK_SVG, 'derived/slick.svg#otf': SLICK_SVG,
  'generated/structure/mac-names-and-cmap.ttf#otf': MAC_OTF, 'generated/structure/mac-names-and-cmap.ttf#svg': MAC_SVG,
  'derived/OpenSans-Regular.svg#ttf': OPENSANS_SVG, 'derived/OpenSans-Regular.svg#otf': OPENSANS_SVG,
  'generated/limits/cff-65533.otf#svg': LIMIT_SVG, 'generated/limits/cff-65534.otf#svg': LIMIT_SVG };
const NONE = { classes: [], scorer: [] };
// Exemption counts, pinned after the first authoritative oracle's review (C4, 2026-11-18, engine d8270ec2): 12 SVG
// outputs fail the scorer's structure check exactly as production's do (ligature-result glyphs written only under
// their ligature string, DejaVu's Arabic forms, code points XML 1.0 cannot carry); 8 named exceptions above.
const PINNED_EXEMPTIONS = { inheritedSanitizer: 12, namedExceptions: 8 };

const GATED_SOURCE = ['parses', 'sanitizer', 'cmap', 'metrics', 'outline', 'layout', 'names', 'special'];
const RANK = { pass: 3, na: 3, info: 3, fail: 2, error: 0 };

function op(fid, target, flavour, input, twin) {
  const inner = INNER_EXT[flavour];
  return { key: `${fid}#${target}`, fid, target, flavour, route: `${flavour}-${target}`, input,
    inName: `input.${inner}`, outName: `output.${target}`, twin, sourcePair: `${inner}-${target}`,
    twinPair: `${target}-${target}` };
}

function inputOf(fid, f) {
  if (f.kind !== 'woff' && f.kind !== 'woff2') return { from: 'fixture', rel: fid, sha256: f.sha256 };
  const e = fontwrapOracle().outputs[`${fid}#decode`];
  if (!e) throw new Error(`fontwrap-oracle.json has no decode of ${fid}`);
  return { from: 'fontwrap', rel: e.file.path, sha256: e.file.sha256 };
}

function flavourOfFixture(f) {
  return f.kind === 'svg' ? 'svg' : f.flavour;
}

// The parity set's rule (P2-19), the same as step 0's M1 job list.
function paritySet(fixtures) {
  const out = [];
  for (const fid of Object.keys(fixtures).sort()) {
    if (!/^(samples|derived|real)\//.test(fid)) continue;
    const f = fixtures[fid];
    if (f.font_error || !['sfnt', 'woff', 'woff2', 'svg'].includes(f.kind)) continue;
    const flavour = flavourOfFixture(f);
    if (!TARGETS[flavour]) continue;
    const special = (f.font && f.font.special) || [];
    if (REFUSED.some((t) => special.includes(t) || special.includes(t.trim()))) continue;
    const input = inputOf(fid, f);
    if (fs.statSync(path.join(FONT_FIXTURES, input.rel)).size > PARITY_MAX_INPUT_BYTES) continue;
    for (const target of TARGETS[flavour]) out.push(op(fid, target, flavour, input, true));
  }
  return out;
}

function opTable() {
  const fixtures = fontOracle().fixtures;
  const ops = paritySet(fixtures);
  for (const [fid, targets] of Object.entries(P2_TWIN)) {
    const f = fixtures[fid];
    for (const t of targets) ops.push(op(fid, t, flavourOfFixture(f), inputOf(fid, f), true));
  }
  for (const [fid, targets] of Object.entries(SOURCE_ONLY)) {
    const f = fixtures[fid];
    for (const t of targets) ops.push(op(fid, t, flavourOfFixture(f), inputOf(fid, f), false));
  }
  ops.push(op(LARGE, 'ttf', 'cff', inputOf(LARGE, fixtures[LARGE]), false));
  return ops.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

// The twin outputs of an op, and the one that stands for production: amd64 wherever the two differ (D15, P2-14).
function twinRefs(o) {
  const arm64 = twinFile('arm64', o.fid, o.target);
  const amd64 = twinFile('amd64', o.fid, o.target);
  // On CFF -> TrueType arm64 is not production (S5 6.5, D15): without the amd64 twin there is no reference.
  const reference = amd64 && (!arm64 || amd64.sha256 !== arm64.sha256) ? 'amd64'
    : (o.route === 'cff-ttf' && !amd64 ? null : 'arm64');
  return { arm64, amd64, reference };
}

function scoreProblems(s, where) {
  if (!s) return [`${where}: no score`];
  if (s.error) return [`${where}: scorer failed: ${s.error}`];
  return Object.entries(s.verdicts || {}).filter(([, v]) => v === 'error').map(([k]) => `${where}: ${k} is error`);
}

// A scorer error the entry's exception names as the scorer's inability to load the file.
function unavailable(o, s) {
  const ex = EXCEPTIONS[o.key] || NONE;
  return Boolean(s && s.error && ex.scorerUnavailable && ex.scorerUnavailable.some((re) => re.test(s.error)));
}

// P2-25: an SVG structure failure production shares, shown with complete code-point sets (never the scorer's text,
// which truncates): every problem the scorer names is of the two kinds the sets describe, and ours are a subset of
// production's.
const STRUCTURE_KINDS = [/^\d+ input code points have no <glyph unicode>/, /^\d+ input code points have more than one <glyph>/];

function sharedStructure(ev) {
  const sub = (a, b) => (a || []).every((x) => (b || []).includes(x));
  if (ev.kind !== 'twin-structure' || !ev.ours || !ev.twin || !(ev.scorer_problems || []).length) return false;
  // Each problem's count must be the size of the set it describes (the sets are what the scorer judged), and a kind
  // the scorer did not report must be empty.
  const count = (re) => {
    const p = ev.scorer_problems.find((x) => re.test(x));
    return p ? Number(p.match(/^(\d+)/)[1]) : 0;
  };
  return ev.scorer_problems.every((p) => STRUCTURE_KINDS.some((re) => re.test(p))) &&
    count(STRUCTURE_KINDS[0]) === (ev.ours.missing || []).length &&
    count(STRUCTURE_KINDS[1]) === (ev.ours.repeated || []).length &&
    sub(ev.ours.missing, ev.twin.missing) && sub(ev.ours.repeated, ev.twin.repeated);
}

function sourceViolations(e, o) {
  const s = e.score_source;
  if (o && unavailable(o, s)) return [];
  const v = scoreProblems(s, 'source');
  if (v.length) return v;
  if (s.verdicts.parses !== 'pass') v.push(`source: parses ${s.verdicts.parses}`);
  if (s.verdicts.sanitizer !== 'pass') {
    const ev = e.sanitizer_evidence;
    const inherited = s.verdicts.sanitizer === 'fail' && ev &&
      ((ev.kind === 'source-ots' && ev.source_accepted === false && (ev.source_messages || []).length > 0 &&
        JSON.stringify(ev.source_messages) === JSON.stringify(ev.output_messages)) ||
       (ev.kind === 'twin' && ev.twin_verdict === 'fail' && (ev.twin_problems || []).length > 0 &&
        JSON.stringify(ev.twin_problems) === JSON.stringify(ev.output_problems)) || sharedStructure(ev));
    if (!inherited) v.push(`source: sanitizer ${s.verdicts.sanitizer} without inherited evidence`);
  }
  return v;
}

const COUNTS = ['outline_failing_revised', 'unmapped_failing_revised', 'ink_box_over_1px', 'pair_matrix_mismatches'];

function baselineViolations(e, o) {
  const s = e.score_source;
  const b = e.baseline;
  if (!b) return ['baseline: missing'];
  if (o && unavailable(o, s) && unavailable(o, b)) return [];
  const v = [];
  for (const k of GATED_SOURCE) {
    if ((RANK[s.verdicts[k]] ?? -1) < (RANK[b.verdicts[k]] ?? -1)) v.push(`baseline: ${k} ${b.verdicts[k]} -> ${s.verdicts[k]}`);
  }
  for (const k of COUNTS) if ((s[k] || 0) > (b[k] || 0)) v.push(`baseline: ${k} ${b[k] || 0} -> ${s[k] || 0}`);
  return v;
}

function twinViolations(o, e) {
  const t = e.twin;
  if (!t || !t[t.reference]) return ['twin: no reference recorded'];
  const ref = t[t.reference];
  const ex = EXCEPTIONS[o.key] || NONE;
  const v = [];
  if (!unavailable(o, ref.score)) v.push(...twinScoreViolations(o, t, ref, ex));
  const allowed = new Set(ALLOWED.concat(o.route === 'cff-ttf' ? ALLOWED_CFF_TO_TRUETYPE : [], ex.classes));
  for (const d of (ref.parity && ref.parity.differences) || []) {
    const pinned = ex.details && ex.details[d.class];
    if (!allowed.has(d.class) || (pinned !== undefined && d.detail !== pinned)) {
      v.push(`twin ${t.reference}: parity ${d.class} (${d.detail || d.where})`);
    }
  }
  if (!ref.parity) v.push(`twin ${t.reference}: no parity comparison`);
  return v;
}

function twinScoreViolations(o, t, ref, ex) {
  const v = scoreProblems(ref.score, `twin ${t.reference}`);
  if (v.length) return v;
  const bound = o.route === 'cff-ttf' && t.twin_vs_twin ? t.twin_vs_twin : null;
  const checks = ['parses', 'cmap', 'metrics', 'outline'].concat(o.target === 'svg' ? [] : ['layout', 'sanitizer']);
  const corrected = ((ref.parity && ref.parity.differences) || []).some((d) => d.class === 'svg-uvs-text-corrected');
  for (const k of checks) {
    if (ref.score.verdicts[k] === 'pass' || ex.scorer.includes(k)) continue;
    // fontforge-0003: production's lone-selector element is now base + selector, which the scorer (production's SVG
    // as its input) counts as an unmapped code point; accepted only for lone selectors, with the corrected class.
    // Tied to what the scorer found: it counts exactly our lacking code points as missing (its list, when it lists
    // them, names only those), and nothing else in its cmap check failed.
    const c = ref.score.cmap;
    if (k === 'cmap' && o.target === 'svg' && corrected && c && (ref.lacking || []).length > 0 &&
      ref.lacking.every((cp) => (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef)) &&
      c.n_missing === ref.lacking.length && (c.missing || []).every((cp) => ref.lacking.includes(cp)) &&
      c.n_advance_mismatch === 0 && c.all_three_pct === c.mapped_pct) continue;  // every mapped one matches
    // P2-14: the twins' own disagreement bounds outline failures on CFF -> TrueType, no other check.
    const within = bound && k === 'outline' &&
      (ref.score.outline_failing_revised || 0) <= (bound.outline_failing_revised || 0);
    if (!within) v.push(`twin ${t.reference}: ${k} ${ref.score.verdicts[k]}`);
  }
  if (ref.score.unmapped_verdict && ref.score.unmapped_verdict !== 'pass' && ref.score.unmapped_verdict !== 'na') {
    const within = bound && (ref.score.unmapped_failing_revised || 0) <= (bound.unmapped_failing_revised || 0);
    if (!within) v.push(`twin ${t.reference}: unmapped glyphs ${ref.score.unmapped_verdict}`);
  }
  if ((ref.score.ink_box_over_1px || 0) > 0) v.push(`twin ${t.reference}: ink box over 1 px ${ref.score.ink_box_over_1px}`);
  return v;
}

// Every violation of one entry; [] when it meets the gate.
function gateViolations(o, e) {
  if (!e) return ['no entry'];
  const v = sourceViolations(e, o);
  if (!v.length) v.push(...baselineViolations(e, o));
  if (o.twin) v.push(...twinViolations(o, e));
  return v;
}

function ffconvOracle() {
  const p = process.env.FFCONV_ORACLE_FILE || path.join(FONT_FIXTURES, FFCONV_ORACLE);
  if (!fs.existsSync(p)) return null;
  const o = JSON.parse(fs.readFileSync(p, 'utf8'));
  o.root = path.dirname(p);
  return o;
}

module.exports = { ALLOWED, ALLOWED_CFF_TO_TRUETYPE, EXCEPTIONS, FFCONV_ORACLE, INNER_EXT, LARGE, P2_TWIN, PINNED,
  PINNED_EXEMPTIONS, REFUSED, SOURCE_ONLY, TARGETS, baselineViolations, ffconvOracle, gateViolations, opTable,
  paritySet, sourceViolations, twinRefs, twinViolations };
