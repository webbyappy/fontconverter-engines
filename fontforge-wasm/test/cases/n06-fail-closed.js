'use strict';
// N6: ffconv fails closed (P2-3, P2-4, P2-5): refusals, a conversion FontForge cannot finish, bad outputs, usage
// errors, and --allow-lossy.

const { fx, readFixture } = require('../lib/fixtures');
const { IN, IN_ALIAS, OUT } = require('../lib/engine');
const { cleanFailure, describe, success, usageFailure } = require('../lib/checks');
const { gdefFacts, gposDevices, readSfnt, table } = require('../lib/sfnt');
const zlib = require('zlib');

const STALE = Buffer.from('stale output from an earlier run');
const TRUNCATED = [4, 11, 12, 68, 300, 310, 4272, 9689, 48984, 113520, 114516, 114519]
  .map((n) => `generated/bad-input/truncated/OpenSans-Regular.cut-${n}.ttf`);
const MAX_INPUT_BYTES = 32 * 1024 * 1024; // P2-4

// [what, input (fixture path or Buffer), the refusal's message must match]
function refusals() {
  const slick = readFixture('samples/slick.ttf');
  const dir = (mutate) => { const b = Buffer.from(slick); mutate(b); return b; };
  const glyfAt = readSfnt(slick).tables.findIndex((t) => t.tag === 'glyf');
  const locaAt = readSfnt(slick).tables.findIndex((t) => t.tag === 'loca');
  const maxpAt = readSfnt(slick).tables.findIndex((t) => t.tag === 'maxp');
  const big = Buffer.alloc(MAX_INPUT_BYTES + 1024 * 1024);
  slick.copy(big);
  return [
    ['an empty file', 'generated/bad-input/empty.ttf', /empty/i],
    ...TRUNCATED.map((p) => [`truncated ${p.split('cut-')[1]}`, p, /truncated|past the end|directory|not a/i]),
    ['random bytes', 'generated/bad-input/random-64k.ttf', /not a|unknown/i],
    ['a zip named .ttf', 'generated/bad-input/zip-named.ttf', /zip/i],
    ['a WOFF', 'samples/OpenSans-Regular.woff', /WOFF/],
    ['a WOFF2', 'derived/OpenSans-Regular.woff2', /WOFF2/],
    ['an EOT', 'derived/OpenSans-Regular.eot', /EOT/],
    ['a collection', 'generated/structure/synthetic.ttc', /collection/i],
    // The closing documents' review (C7): these refusals had no row.
    ['a Type 1 font (PFB)', 'samples/slick.pfb', /Type 1/],
    ['a Type 1 font (PFA)', 'real/urw-base35/NimbusSans-Regular.pfa', /Type 1/],
    ['gzip data', zlib.gzipSync(slick, { level: 9 }), /gzip/],
    ['an XML file without a <font> element',
      Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>\n'),
      /<font>/],
    ['a variable TrueType font', 'real/var-ttf/OpenSans-VF.ttf', /fvar/],
    ['a CFF2 font', 'real/sourcesans-vf/SourceSans3VF-Upright.otf', /CFF2/],
    ['a COLR font', 'real/twemoji/Twemoji.Mozilla.ttf', /COLR/],
    ['a CBDT font', 'real/color-cbdt/NotoColorEmoji.ttf', /CBDT|outline/],
    ['an sbix font', 'generated/special/slick-sbix.ttf', /sbix/],
    ['an SVG-table font', 'generated/special/slick-svg-table.ttf', /SVG /],
    ['a 33 MiB input', big, /32 MiB|too large/i],
    ['0 tables', dir((b) => b.writeUInt16BE(0, 4)), /table/i],
    ['4,097 tables', dir((b) => b.writeUInt16BE(4097, 4)), /table/i],
    ['a table past 2^32', dir((b) => { b.writeUInt32BE(0xfffffff0, 12 + 16 * glyfAt + 8); }), /past the end|table/i],
    ['a 4-byte maxp', dir((b) => { b.writeUInt32BE(4, 12 + 16 * maxpAt + 12); }), /maxp/],
    ['no outline tables', dir((b) => { b.write('xxxx', 12 + 16 * glyfAt, 'latin1'); b.write('yyyy', 12 + 16 * locaAt, 'latin1'); }),
      /outline/i],
  ];
}

function bytesOf(input) {
  return Buffer.isBuffer(input) ? input : readFixture(input);
}

async function failClosed(ctx, what, input, args, outName, pattern) {
  const bytes = bytesOf(input);
  const r = await ctx.eng.run(args, { input: bytes, inName: 'input.ttf', outName, stale: STALE });
  const c = cleanFailure(r);
  const named = pattern.test((r.stderr || []).slice(-1)[0] || '');
  ctx.rep.check(`${what}: exit 1, one error line, nothing left at the output path`, c.ok && named &&
    r.outDir.length === 0 && r.inAfter && r.inAfter.equals(bytes),
  `${c.why}; message names it ${named}; out/ ${JSON.stringify(r.outDir)}; input untouched ${Boolean(r.inAfter && r.inAfter.equals(bytes))}`);
}

module.exports = {
  id: 'N6', title: 'fail closed', needsEngine: true,
  async run(ctx) {
    const list = refusals();
    for (const [what, input, pattern] of list) {
      await failClosed(ctx, what, input, ['convert', IN, OUT], 'output.otf', pattern);
      const s = await ctx.eng.run(['selftest-sniff', IN], { input: bytesOf(input), inName: 'input.ttf' });
      ctx.rep.check(`${what}: selftest-sniff refuses it the same way`, cleanFailure(s).ok &&
        pattern.test(s.stderr.slice(-1)[0] || ''), cleanFailure(s).why);
    }
    ctx.count('refusals', list.length, 35); // 12 truncations and 23 others (P2 plan, N6; 4 added by the C7 review)
    const missing = await ctx.eng.run(['convert', '/in/does-not-exist.ttf', OUT], { outName: 'output.otf', stale: STALE });
    ctx.rep.check('a missing input: exit 1, nothing left', cleanFailure(missing).ok && missing.outDir.length === 0,
      cleanFailure(missing).why);

    const big = 'generated/limits/cff-65534.otf';
    const sniffBig = await ctx.eng.run(['selftest-sniff', IN], { input: { path: fx(big) }, inName: 'input.otf' });
    ctx.rep.check('cff-65534.otf passes the input check', sniffBig.code === 0 && !sniffBig.threw && sniffBig.json &&
      sniffBig.json.kind === 'sfnt' && sniffBig.json.flavor === 'cff' && sniffBig.json.numGlyphs === 65534,
    describe(sniffBig));
    await failClosed(ctx, 'cff-65534.otf -> ttf (FontForge\'s 65,535 limit)', big, ['convert', IN, OUT], 'output.ttf',
      /FontForge|65535|glyph|write/i);

    // Each bad output reaches the rule it is for (closing review: a header-magic refusal proved nothing about the
    // outline-table rules): a TrueType header without glyf, a CFF header with glyf and no CFF.
    const noGlyf = Buffer.from(readFixture('samples/slick.ttf'));
    noGlyf.write('xxxx', 12 + 16 * readSfnt(noGlyf).tables.findIndex((t) => t.tag === 'glyf'), 'latin1');
    const ottoGlyf = Buffer.from(readFixture('samples/slick.ttf'));
    ottoGlyf.write('OTTO', 0, 'latin1');
    const bad = [
      ['wrong magic', Buffer.from('not a font at all'), 'ttf', /does not start with/],
      ['a .ttf without glyf', noGlyf, 'ttf', /lacks TrueType outlines/],
      ['an .otf with glyf and no CFF', ottoGlyf, 'otf', /lacks CFF outlines/],
      ['an SVG without </font>', Buffer.from('<?xml version="1.0"?><svg><defs><font id="x">'), 'svg', /no complete <font>/],
      ['a truncated directory', readFixture('samples/slick.ttf').subarray(0, 40), 'ttf', /truncated/],
    ];
    for (const [what, bytes, ext, why] of bad) {
      const r = await ctx.eng.run(['selftest-check', IN, ext], { input: bytes, inName: 'candidate.bin' });
      ctx.rep.check(`selftest-check refuses ${what}`, cleanFailure(r).ok && why.test(r.stderr.slice(-1)[0] || ''),
        cleanFailure(r).why + ' | ' + (r.stderr.slice(-1)[0] || ''));
    }
    // An SVG font whose bytes 34-35 happen to read "LP" (EOT's magic there) is still an SVG font.
    const lp = Buffer.from('<?xml version="1.0" standalone="no"?><!--LP--><svg xmlns="http://www.w3.org/2000/svg">' +
      '<defs><font id="x" horiz-adv-x="500"><font-face units-per-em="1000"/><glyph unicode="a" d="M0 0L10 10z"/>' +
      '</font></defs></svg>', 'latin1');
    lp.write('LP', 34, 'latin1');
    const lpr = await ctx.eng.run(['selftest-sniff', IN], { input: lp, inName: 'input.svg' });
    ctx.rep.check('an SVG font with "LP" at bytes 34-35 is read as SVG, not refused as EOT', lpr.code === 0 &&
      lpr.json && lpr.json.kind === 'svg', describe(lpr));
    for (const [ext, rel] of [['ttf', 'samples/slick.ttf'], ['otf', 'samples/slick.otf'], ['svg', 'derived/slick.svg']]) {
      const r = await ctx.eng.run(['selftest-check', IN, ext], { input: readFixture(rel), inName: 'candidate.bin' });
      ctx.rep.check(`selftest-check accepts ${rel} as .${ext}`, r.code === 0 && !r.threw && r.json && r.json.ok === true,
        describe(r));
    }

    const slick = readFixture('samples/slick.ttf');
    const usage = [
      ['an unknown command', ['transmogrify', IN, OUT], 'output.otf'],
      ['an unknown option', ['convert', '--frobnicate', IN, OUT], 'output.otf'],
      ['a missing argument', ['convert', IN], 'output.otf'],
      ['a .woff output', ['convert', IN, OUT], 'output.woff'],
      ['a .pfb output', ['convert', IN, OUT], 'output.pfb'],
      ['an .xyz output', ['convert', IN, OUT], 'output.xyz'],
      ['an upper-case .TTF output', ['convert', IN, OUT], 'output.TTF'],
      ['the input as output under another spelling', ['convert', IN, IN_ALIAS], 'unused.otf'],
    ];
    for (const [what, args, outName] of usage) {
      const r = await ctx.eng.run(args, { input: slick, inName: 'input.ttf', outName, stale: STALE });
      // A usage error touches no file: the stale output is still there, unchanged (read back when OUT is in argv).
      const staleKept = r.outDir.length === 1 && r.outDir[0] === outName && (r.out === null || r.out.equals(STALE));
      ctx.rep.check(`${what}: exit 2, nothing touched`, usageFailure(r).ok && staleKept && r.inAfter && r.inAfter.equals(slick),
        `${usageFailure(r).why}; out/ ${JSON.stringify(r.outDir)}`);
    }

    const vf = readFixture('real/var-ttf/OpenSans-VF.ttf');
    const lossy = await ctx.eng.run(['convert', '--allow-lossy', IN, OUT], { input: vf, inName: 'input.ttf',
      outName: 'output.otf' });
    ctx.rep.check('--allow-lossy converts a variable TrueType font to a static CFF font', success(lossy, 'otf').ok &&
      Boolean(table(lossy.out, 'CFF ')) && !table(lossy.out, 'fvar'), describe(lossy));
    // fontforge-0006 (both builds): a variable font's GDEF is version 1.3 (1.2 and an item variation store), which
    // FontForge read as no GDEF, so the output classified no glyph and HarfBuzz misplaced a second stacked mark. The
    // output keeps the source's glyph classes, counted per class (FontForge renumbers glyphs), and its mark glyph sets.
    const sansVf = readFixture('real/sourcesans-vf/SourceSans3VF-Upright.ttf');
    const sans = await ctx.eng.run(['convert', '--allow-lossy', IN, OUT], { input: sansVf, inName: 'input.ttf',
      outName: 'output.otf' });
    for (const [name, src, r] of [['OpenSans-VF.ttf', vf, lossy], ['SourceSans3VF-Upright.ttf', sansVf, sans]]) {
      const want = gdefFacts(src);
      const got = r.out ? gdefFacts(r.out) : null;
      const classified = Object.values(want.classes).reduce((a, b) => a + b, 0);
      ctx.rep.check(`${name} (GDEF 1.3) -> otf keeps the source's glyph classes ${JSON.stringify(want.classes)}`,
        success(r, 'otf').ok && want.version === '0x00010003' && classified > 0 && Boolean(got) &&
        JSON.stringify(got.classes) === JSON.stringify(want.classes),
        `${describe(r)}; ours ${got ? `${got.version} ${JSON.stringify(got.classes)}` : 'no GDEF'}`);
    }
    const sets = gdefFacts(vf).markSets;
    const gotSets = lossy.out && gdefFacts(lossy.out) ? gdefFacts(lossy.out).markSets : null;
    ctx.rep.check(`OpenSans-VF.ttf (GDEF 1.3) -> otf keeps the source's ${sets} mark glyph sets`, sets === 3 &&
      gotSets === sets, `ours ${gotSets}`);
    // fontforge-0008 (both builds): the source's GPOS device tables are all VariationIndex tables (DeltaFormat 0x8000,
    // the deltas of other instances). FontForge kept a kerning pair's empty device table and set its device bit while
    // writing no table, so the offsets led into unrelated bytes and the OpenType Sanitizer rejected GPOS. A static
    // font made from the default master has no hinting device table here: no device bit, no offset to a non-table.
    const srcDev = gposDevices(sansVf);
    const dev = sans.out ? gposDevices(sans.out) : null;
    const srcOffsets = Object.values(srcDev.formats).reduce((a, b) => a + b, 0);
    ctx.rep.check('SourceSans3VF-Upright.ttf -> otf: every GPOS device bit leads to a device table of format 1-3 ' +
      `(the source's ${srcOffsets} are VariationIndex tables)`, srcOffsets > 0 && srcDev.formats['0x8000'] === srcOffsets &&
      Boolean(dev) && dev.records > 0 && dev.bad === 0 && dev.nullBits === 0,
    dev ? `ours: ${dev.records} value records and anchors, ${dev.bad} offsets to no device table ` +
      `(${dev.examples.join('; ')}), ${dev.nullBits} device bits with a NULL offset` : describe(sans));
    const cff2 = await ctx.eng.run(['convert', '--allow-lossy', IN, OUT], {
      input: readFixture('real/sourcesans-vf/SourceSans3VF-Upright.otf'), inName: 'input.otf', outName: 'output.ttf' });
    ctx.rep.knownLimit('--allow-lossy cannot help a CFF2 font (FontForge 20230101 cannot read CFF2)',
      cleanFailure(cff2).ok, describe(cff2));
  },
};
