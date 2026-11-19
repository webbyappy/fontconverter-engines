'use strict';
// N4: WOFF 2.0 round trips keep every table byte for byte except glyf/loca (decoded glyphs equal), head (checksum
// and flags bit 11; indexToLocFormat kept: R5 rejected) and DSIG (removed). Collections face by face.
// Two owner-approved refinements (P1 results 12.3, after consulting Codex):
//   - google/woff2 may switch one bound font's loca from short to long; allowed only as locaSwitchProblems() says;
//   - a font with a table off a 4-byte boundary is refused for WOFF2 with a message naming it (google/woff2 cannot
//     read it); other commands still accept it.

const { fontOracle, fx, readFixture } = require('../lib/fixtures');
const { IN, OUT } = require('../lib/engine');
const { collections, encodeSet, extOf, hasUnalignedTable, locaSwitchAllowed, woff2Quality } = require('../lib/oracle');
const { adjustmentOk, cleanFailure, describe, faceBases, fontProblems, locaSwitchProblems, success, tablesByTag,
  warnings, withUnalignedTable } = require('../lib/checks');

const UNALIGNED = /table '.{4}' (of face \d+ )?starts at byte \d+, not on a 4-byte boundary/;

async function unalignedSingleFont(ctx) {
  const { font, tag, offset } = withUnalignedTable(readFixture('samples/slick.ttf'));
  const r = await ctx.eng.run(['woff2-encode', IN, OUT], { input: font, outName: 'out.woff2', stale: Buffer.from('x') });
  const named = r.stderr.some((l) => l.includes(`'${tag}'`) && l.includes(`byte ${offset}`));
  ctx.rep.check('woff2-encode refuses a font with an unaligned table, naming it', cleanFailure(r, UNALIGNED) && named,
    describe(r));
  const w = await ctx.eng.run(['woff-encode', IN, OUT], { input: font, outName: 'out.woff' });
  ctx.rep.check('woff-encode still accepts it (with the non-canonical warning)', success(w) && warnings(w).length > 0,
    describe(w));
}

module.exports = {
  id: 'N4', title: 'WOFF 2.0', needsEngine: true,
  async run(ctx) {
    const fo = fontOracle().fixtures;
    let n = 0;
    for (const id of [...encodeSet(), ...collections()].filter(ctx.keep)) {
      n++;
      const f = fo[id];
      const src = readFixture(id);
      const ext = f.kind === 'collection' ? 'ttc' : extOf(f.flavour);
      const q = woff2Quality(f.size);
      const e = await ctx.eng.run(['woff2-encode', `--quality=${q}`, IN, OUT], { input: { path: fx(id) },
        inName: `in.${ext}`, outName: 'out.woff2' });
      if (hasUnalignedTable(id)) {
        ctx.rep.check(`woff2-encode refuses ${id} (a table off a 4-byte boundary)`, cleanFailure(e, UNALIGNED) &&
          (f.kind !== 'collection' || e.stderr.some((l) => /of face \d+/.test(l))), describe(e));
        continue;
      }
      if (!ctx.rep.check(`woff2-encode q${q} ${id}`, success(e), describe(e))) continue;
      const d = await ctx.eng.run(['woff2-decode', IN, OUT], { input: e.out, inName: 'in.woff2', outName: `out.${ext}` });
      if (!ctx.rep.check(`woff2-decode ${id}`, success(d) && d.json.ext === ext, describe(d))) continue;
      const switched = locaSwitchAllowed(id);
      const p = fontProblems(src, d.out, { rebuilt: true, bit11: true, dropped: ['DSIG'], locFormat: switched });
      if (switched) p.push(...locaSwitchProblems(src, d.out));
      for (const base of faceBases(d.out)) if (tablesByTag(d.out, base).has('DSIG')) p.push('DSIG kept');
      if (f.kind !== 'collection' && !adjustmentOk(d.out)) p.push('head.checkSumAdjustment wrong for the new file');
      ctx.rep.check(`round trip keeps the font${switched ? ' (loca short -> long, as allowed)' : ''}: ${id}`,
        p.length === 0, p.slice(0, 4).join('; '));
    }
    ctx.count('encode set and collections', n, 33); // +3 real fonts in P3b
    if (!ctx.filtered) await unalignedSingleFont(ctx);
  },
};
