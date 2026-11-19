'use strict';
// N3: WOFF 1.0 round trips give the input back bit for bit (P1 plan, section 4).

const { fontOracle, fx, readFixture } = require('../lib/fixtures');
const { IN, OUT } = require('../lib/engine');
const { extOf, encodeSet } = require('../lib/oracle');
const { checksum, readSfnt, tableBytes } = require('../lib/sfnt');
const { cleanFailure, describe, fontProblems, success, warnings } = require('../lib/checks');

// The one encode-set font whose layout is not canonical (tables out of order, with gaps): its tables survive byte for
// byte, the file does not. Checked for all 27 by the plan's first review.
const NONCANONICAL = ['generated/structure/noncanonical.ttf'];
const STALE = Buffer.from('stale output from an earlier run');

function badChecksums(buf) {
  return readSfnt(buf).tables.filter((t) => t.recorded !== checksum(tableBytes(buf, t), t.tag)).map((t) => t.tag);
}

module.exports = {
  id: 'N3', title: 'WOFF 1.0', needsEngine: true,
  async run(ctx) {
    const fo = fontOracle().fixtures;
    let n = 0;
    for (const id of encodeSet().filter(ctx.keep)) {
      n++;
      const src = readFixture(id);
      const ext = extOf(fo[id].flavour);
      const expectWarn = NONCANONICAL.includes(id) || badChecksums(src).length > 0;
      const e = await ctx.eng.run(['woff-encode', IN, OUT], { input: { path: fx(id) }, inName: `in.${ext}`,
        outName: 'out.woff', stale: STALE });
      if (!ctx.rep.check(`woff-encode ${id}`, success(e) && e.json.command === 'woff-encode' &&
        (warnings(e).length > 0) === expectWarn, `${describe(e)}; warning expected: ${expectWarn}`)) continue;
      const d = await ctx.eng.run(['woff-decode', IN, OUT], { input: e.out, inName: 'in.woff', outName: `out.${ext}` });
      if (!ctx.rep.check(`woff-decode ${id}`, success(d) && d.json.ext === ext, describe(d))) continue;
      // The result lines name the outline flavour by the tables, as info and font-oracle.json do (cff2 included).
      ctx.rep.check(`both result lines say ${fo[id].flavour}: ${id}`, e.json.flavor === fo[id].flavour &&
        d.json.flavor === fo[id].flavour, `${e.json.flavor} / ${d.json.flavor}`);
      if (NONCANONICAL.includes(id)) {
        const p = fontProblems(src, d.out);
        ctx.rep.check(`round trip keeps every table of ${id}`, p.length === 0, p.join('; '));
      } else {
        ctx.rep.check(`round trip is bit-identical: ${id}`, d.out.equals(src), `${d.out.length} vs ${src.length} bytes`);
      }
    }
    ctx.count('encode set', n, 30); // +3 real fonts in P3b

    for (const id of ['generated/structure/noncanonical.ttf', 'generated/structure/bad-checksum.ttf']) {
      if (!ctx.keep(id)) continue;
      const r = await ctx.eng.run(['woff-encode', '--strict', IN, OUT], { input: { path: fx(id) }, outName: 'out.woff',
        stale: STALE });
      ctx.rep.check(`--strict refuses ${id}`, cleanFailure(r), describe(r));
    }
    // A CFF font whose sfnt version says TrueType: the tables decide (P1 results 12.6, review finding 6).
    if (ctx.keep('samples/slick.otf')) {
      const lying = Buffer.from(readFixture('samples/slick.otf'));
      lying.writeUInt32BE(0x00010000, 0);
      const e = await ctx.eng.run(['woff-encode', IN, OUT], { input: lying, inName: 'in.otf', outName: 'out.woff' });
      const d = e.out ? await ctx.eng.run(['woff-decode', IN, OUT], { input: e.out, outName: 'out.bin' }) : e;
      ctx.rep.check('a CFF font labelled TrueType is reported as cff and decodes to an .otf',
        success(e) && e.json.flavor === 'cff' && success(d) && d.json.flavor === 'cff' && d.json.ext === 'otf',
        `${describe(e)} | ${describe(d)}`);
      const r = await ctx.eng.run(['eot-encode', IN, OUT], { input: lying, inName: 'in.otf', outName: 'out.eot',
        stale: STALE });
      ctx.rep.check('eot-encode refuses a CFF font labelled TrueType without --allow-cff', cleanFailure(r, /CFF/),
        describe(r));
    }
    for (const id of ['generated/structure/synthetic.ttc']) {
      if (!ctx.keep(id)) continue;
      const r = await ctx.eng.run(['woff-encode', IN, OUT], { input: { path: fx(id) }, outName: 'out.woff', stale: STALE });
      ctx.rep.check(`a collection is refused: ${id}`, cleanFailure(r, /collection/), describe(r));
    }
  },
};
