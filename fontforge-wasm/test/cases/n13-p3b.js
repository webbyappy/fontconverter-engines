'use strict';
// N13: fontconverter-web P3b (docs/audits/P3b-VARIABLE-COLOUR-PLAN-2026-11-18.md): the failure line and its ids
// (P3b-7), --glyph-map (P3b-9), the 1 GiB ceiling and the abort record (P3b-5).

const fs = require('fs');
const { fx, readFixture } = require('../lib/fixtures');
const { IN, MAP, OUT } = require('../lib/engine');
const { cleanFailure, describe, success, usageFailure } = require('../lib/checks');
const { bestUnicodeMap, table } = require('../lib/sfnt');
const { buildCff, withTable } = require('../lib/cffbuild');

const CEILING_BYTES = 1073741824; // 1 GiB (P3b-5)
const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MUST_LIST = ['usage', 'input-empty', 'cff2', 'lossy-table', 'glyph-map-invalid', 'glyph-map-unavailable',
  'out-of-memory'];

function numGlyphs(buf) {
  return table(buf, 'maxp').readUInt16BE(4);
}

function upm(buf) {
  return table(buf, 'head').readUInt16BE(18);
}

// Advance width per glyph id, from hhea and hmtx.
function advances(buf) {
  const n = numGlyphs(buf);
  const metrics = table(buf, 'hhea').readUInt16BE(34);
  const hmtx = table(buf, 'hmtx');
  const out = [];
  for (let g = 0; g < n; g++) out.push(hmtx.readUInt16BE(4 * Math.min(g, metrics - 1)));
  return out;
}

// The map's own checks (shape, .notdef, injectivity, bounds) and, independently of FontForge, that every pair has
// the same advance (scaled) and every code point of the source's cmap maps to the paired glyph in the output.
// `cidOf(gid)` gives the key a source glyph has in a map keyed by CID.
function mapProblems(src, out, gm, keyedBy, cidOf) {
  const p = [];
  if (!gm || gm.v !== 1 || gm.keyedBy !== keyedBy || !Array.isArray(gm.map)) return [`map ${JSON.stringify(gm).slice(0, 120)}`];
  const n = numGlyphs(src);
  const m = numGlyphs(out);
  if (gm.outputGlyphs !== m) p.push(`outputGlyphs ${gm.outputGlyphs}, the output has ${m}`);
  if (keyedBy === 'gid' && gm.sourceGlyphs !== n) p.push(`sourceGlyphs ${gm.sourceGlyphs}, the source has ${n}`);
  if (gm.map.length !== gm.sourceGlyphs) p.push(`map length ${gm.map.length}, sourceGlyphs ${gm.sourceGlyphs}`);
  if (gm.map[0] !== 0) p.push('.notdef is not glyph 0');
  const used = gm.map.filter((o) => o >= 0);
  if (new Set(used).size !== used.length) p.push('two source glyphs share an output glyph');
  if (used.some((o) => o >= m)) p.push('an output id past the output');
  const sa = advances(src);
  const oa = advances(out);
  const scale = upm(src) / upm(out);
  let pairs = 0;
  for (let g = 0; g < n; g++) {
    const o = gm.map[cidOf(g)];
    if (o === undefined || o < 0) continue;
    pairs++;
    if (Math.abs(sa[g] - oa[o] * scale) > 1) p.push(`glyph ${g} -> ${o}: advance ${sa[g]} vs ${oa[o]}`);
  }
  const sc = bestUnicodeMap(src);
  const oc = bestUnicodeMap(out);
  let encoded = 0;
  for (const [cp, g] of sc) {
    if (g === 0) continue;
    encoded++;
    const want = gm.map[cidOf(g)];
    if (oc.get(cp) !== want) p.push(`U+${cp.toString(16)}: source glyph ${g} maps to ${want}, the output's cmap says ${oc.get(cp)}`);
  }
  if (pairs < 2 || encoded < 1) p.push(`only ${pairs} pairs and ${encoded} code points checked`);
  return p.slice(0, 6);
}

async function ids(ctx) {
  const r = await ctx.eng.run(['error-ids']);
  const list = r.json && Array.isArray(r.json.ids) ? r.json.ids : [];
  ctx.rep.check('error-ids prints {"ok":true,"v":1,"ids":[...]}, unique kebab-case ids',
    r.code === 0 && r.json && r.json.ok === true && r.json.v === 1 && new Set(list).size === list.length &&
    list.every((i) => ID_RE.test(i)) && MUST_LIST.every((i) => list.includes(i)), describe(r));
  const unknown = await ctx.eng.run(['frobnicate-x7']);
  const u = usageFailure(unknown);
  ctx.rep.check('an unknown command fails with command null, error usage, the argument never echoed',
    u.ok && unknown.json.command === null && !unknown.stdout[0].includes('frobnicate'), u.why);
  const empty = await ctx.eng.run(['convert', IN, OUT], { input: Buffer.alloc(0), inName: 'input.ttf',
    outName: 'output.otf' });
  const e = cleanFailure(empty, 'input-empty');
  ctx.rep.check('an empty input fails as input-empty, the command named', e.ok && empty.json.command === 'convert', e.why);
  const svg = await ctx.eng.run(['convert', '--glyph-map', MAP, IN, OUT], { input: readFixture('samples/slick.ttf'),
    inName: 'input.ttf', outName: 'output.svg' });
  const s = usageFailure(svg);
  ctx.rep.check('--glyph-map with an svg output is a usage error', s.ok && !svg.glyphMap, s.why);
}

async function maps(ctx) {
  const cases = [
    ['samples/slick.ttf', 'otf', [], 'gid', (g) => g],
    ['real/twemoji/Twemoji.Mozilla.ttf', 'otf', ['--allow-lossy'], 'gid', (g) => g],
    ['generated/colour/Twemoji-cff.otf', 'ttf', ['--allow-lossy'], 'gid', (g) => g],
    // Twemoji-cid's charset gives glyph i the CID 7 + 3i (fontconverter-web tests/tools/fixturegen/p3b_cases.py).
    ['generated/colour/Twemoji-cid.otf', 'ttf', ['--allow-lossy'], 'cid', (g) => (g === 0 ? 0 : 7 + 3 * g)],
  ];
  for (const [id, to, extra, keyedBy, cidOf] of cases) {
    const src = readFixture(id);
    const inName = id.endsWith('.otf') ? 'input.otf' : 'input.ttf';
    const outName = `output.${to}`;
    const r = await ctx.eng.run(['convert', ...extra, '--glyph-map', MAP, IN, OUT], { input: src, inName, outName });
    const s = success(r, to);
    const files = JSON.stringify([...r.outDir].sort());
    if (!ctx.rep.check(`${id} to ${to} with --glyph-map converts and writes a map beside the output, nothing else`,
      s.ok && r.glyphMap !== null && files === JSON.stringify(['glyph-map.json', outName].sort()),
      `${s.why}; out/ ${files}`)) continue;
    const problems = mapProblems(src, r.out, r.glyphMap, keyedBy, cidOf);
    ctx.rep.check(`${id} to ${to}: the map (keyed by ${keyedBy}) pairs equal advances and code points`,
      problems.length === 0, problems.join('; '));
    const plain = await ctx.eng.run(['convert', ...extra, IN, OUT], { input: src, inName, outName });
    ctx.rep.check(`${id} to ${to}: the font is the same bytes without --glyph-map`,
      success(plain, to).ok && plain.out.equals(r.out) && plain.glyphMap === null, describe(plain));
  }
}

async function memory(ctx) {
  if (ctx.kind !== 'wasm') {
    const r = await ctx.eng.run(['selftest-oom']);
    const u = usageFailure(r);
    ctx.rep.check('selftest-oom refuses natively (no ceiling to reach)', u.ok, u.why);
    ctx.rep.notApplicable('the glue\'s ceiling', 'native binaries have no wasm memory');
    return;
  }
  const glue = fs.readFileSync(ctx.eng.gluePath, 'latin1');
  ctx.rep.check('the glue caps memory at 1 GiB and aborts when it cannot grow (ABORTING_MALLOC)',
    glue.includes(String(CEILING_BYTES)) && !glue.includes('2147483648') && glue.includes('abortOnCannotGrowMemory'),
    'looked for 1073741824 and abortOnCannotGrowMemory, and for no 2147483648');
  const r = await ctx.eng.run(['selftest-oom']);
  const heap = r.M ? r.M.heapBytes() : null;
  ctx.rep.check('selftest-oom aborts as out of memory at the ceiling: lastAbort() is "oom"',
    r.threw !== null && r.M && typeof r.M.lastAbort === 'function' && r.M.lastAbort() === 'oom' &&
    heap <= CEILING_BYTES && heap > CEILING_BYTES - 64 * 1048576, `${describe(r)}; heap ${heap}`);
  const next = await ctx.eng.run(['convert', IN, OUT], { input: readFixture('samples/slick.ttf'), inName: 'input.ttf',
    outName: 'output.otf' });
  ctx.rep.check('a fresh instance after the abort converts', success(next, 'otf').ok, describe(next));
  const v = await ctx.eng.run(['version']);
  ctx.rep.check('lastAbort() is null on an instance that never aborted',
    v.M && typeof v.M.lastAbort === 'function' && v.M.lastAbort() === null, describe(v));
  // The accepted breach (P3b-6): the full NotoSansCJKjp (16.5 MB, 65,535 glyphs) to svg needed 1,014 MiB uncapped
  // (IMPLEMENTATION_GUIDE.md, section 4), beyond the app's limits. Under the ceiling it converts or aborts as out of
  // memory, leaving no output; anything else fails.
  const big = await ctx.eng.run(['convert', IN, OUT], { input: { path: fx('real/notocjk/NotoSansCJKjp-Regular.otf') },
    inName: 'input.otf', outName: 'output.svg' });
  const converted = success(big, 'svg').ok;
  const oom = big.threw !== null && big.M && big.M.lastAbort() === 'oom' && !big.outExists;
  ctx.rep.check(`the full NotoSansCJKjp to svg converts or aborts oom (${converted ? 'converted' : oom ? 'aborted oom'
    : 'neither'}; heap ${big.M ? big.M.heapBytes() : null})`, converted || oom, describe(big));
}

// The result check's bounded CFF validation (P3b, after the colour transplants met it): every INDEX inside the table,
// no program (charstring, global or local subroutine, per FD too) over the Type 2 limit of 65,535 bytes. FontForge
// writes a 114,947-byte charstring for Noto-COLRv1 (production's FontForge too), which OTS and the Chromium and
// Firefox engines refuse.
async function cffLimits(ctx) {
  const slick = readFixture('samples/slick.otf');
  const check = async (what, opts, want) => {
    const font = withTable(slick, 'CFF ', buildCff(opts));
    const r = await ctx.eng.run(['selftest-check', IN, 'otf'], { input: font, inName: 'x.otf' });
    const ok = want === 'pass' ? !r.threw && r.code === 0 : cleanFailure(r, 'output-invalid').ok;
    ctx.rep.check(`the result check: ${what} ${want === 'pass' ? 'passes' : 'is refused (output-invalid)'}`, ok, describe(r));
  };
  await check('a charstring of 65,535 bytes', { charStrings: [16, 65535] }, 'pass');
  await check('a charstring of 65,536 bytes', { charStrings: [16, 65536] }, 'fail');
  await check('a global subroutine of 65,536 bytes', { charStrings: [16, 16], globalSubrs: [65536] }, 'fail');
  await check('a local subroutine of 65,535 bytes', { charStrings: [16, 16], localSubrs: [65535] }, 'pass');
  await check('a local subroutine of 65,536 bytes', { charStrings: [16, 16], localSubrs: [65536] }, 'fail');
  await check("an FD's local subroutine of 65,536 bytes (CID-keyed)", { charStrings: [16, 16], localSubrs: [65536],
    cid: true }, 'fail');
  await check('a CID-keyed font within the limits', { charStrings: [16, 16], localSubrs: [100], cid: true }, 'pass');
  await check('a CharStrings INDEX offset past the table', { charStrings: [16, 16], damage: 'charstrings-offset' }, 'fail');
  const noto = await ctx.eng.run(['convert', '--allow-lossy', '--glyph-map', MAP, IN, OUT],
    { input: readFixture('real/color-colr/Noto-COLRv1.ttf'), inName: 'input.ttf', outName: 'output.otf' });
  ctx.rep.check("Noto-COLRv1 to otf: FontForge's 114,947-byte charstring refused (output-invalid), no font, no map",
    cleanFailure(noto, 'output-invalid').ok && noto.glyphMap === null && noto.outDir.length === 0, describe(noto));
  // A plain font (no colour, no transplant): an SVG font whose one glyph is a path of 30,000 segments.
  const segs = [];
  // Coordinates far apart (3-byte operands), so the glyph's charstring is 182,003 bytes (measured, 2026-11-19).
  for (let i = 0; i < 30000; i++) segs.push('L' + ((i * 7919) % 30000 - 15000) + ' ' + ((i * 104729) % 30000 - 15000));
  const d = 'M0 0 ' + segs.join(' ') + ' Z';
  const svg = '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><defs><font id="Big" horiz-adv-x="1000">' +
    '<font-face font-family="Big" units-per-em="1000" ascent="800" descent="-200"/>' +
    '<missing-glyph horiz-adv-x="500"/><glyph unicode="A" glyph-name="A" horiz-adv-x="1000" d="' + d + '"/>' +
    '</font></defs></svg>';
  const big = await ctx.eng.run(['convert', IN, OUT], { input: Buffer.from(svg), inName: 'input.svg',
    outName: 'output.otf' });
  ctx.rep.check('a plain SVG font with a 30,000-segment glyph to otf: refused (output-invalid), no output',
    cleanFailure(big, 'output-invalid').ok, describe(big));
}

module.exports = {
  id: 'N13', title: 'P3b: failure ids, the glyph map, the memory ceiling', needsEngine: true,
  async run(ctx) {
    await ids(ctx);
    await maps(ctx);
    await cffLimits(ctx);
    await memory(ctx);
  },
};
