'use strict';
// N9: variable, colour and large CJK fonts keep their special tables through WOFF, WOFF2 and EOT; collections are
// refused by the one-font formats (their WOFF2 round trip, face by face, is N4's).

const { fontOracle, fx, readFixture } = require('../lib/fixtures');
const { IN, OUT } = require('../lib/engine');
const { collections, extOf, woff2Quality } = require('../lib/oracle');
const { cleanFailure, describe, success, tablesByTag } = require('../lib/checks');

const SPECIAL_FONTS = ['real/var-ttf/OpenSans-VF.ttf', 'real/sourcesans-vf/SourceSans3VF-Upright.otf',
  'real/color-colr/Noto-COLRv1.ttf', 'real/color-cbdt/NotoColorEmoji.ttf', 'real/notocjk/NotoSansCJKjp-Regular.otf',
  'real/var-cjk-ttf/NotoSansSC-VF.ttf'];
// bytes: a budget, half of -sMAXIMUM_MEMORY; the largest round trip measured 2026-11-17 is far below it (results 12.6)
const MAX_HEAP = 1024 * 1024 * 1024;

async function roundTrip(ctx, id, enc, dec, extra, outExt) {
  const e = await ctx.eng.run([enc, ...extra, IN, OUT], { input: { path: fx(id) }, outName: `out.${outExt}` });
  if (!success(e)) return { problem: `${enc}: ${describe(e)}` };
  const d = await ctx.eng.run([dec, IN, OUT], { input: e.out, inName: `in.${outExt}`, outName: 'out.font' });
  if (!success(d)) return { problem: `${dec}: ${describe(d)}` };
  return { out: d.out, heap: Math.max(e.heap || 0, d.heap || 0) };
}

module.exports = {
  id: 'N9', title: 'special fonts', needsEngine: true,
  async run(ctx) {
    const fo = fontOracle().fixtures;
    let n = 0;
    for (const id of SPECIAL_FONTS.filter(ctx.keep)) {
      n++;
      const f = fo[id];
      const src = tablesByTag(readFixture(id));
      const tags = f.font.special.length ? f.font.special : ['CFF ']; // the CJK OTF stands for size
      const trips = [['WOFF', 'woff-encode', 'woff-decode', [], 'woff'],
        ['WOFF2', 'woff2-encode', 'woff2-decode', [`--quality=${woff2Quality(f.size)}`], 'woff2']];
      if (extOf(f.flavour) === 'ttf') trips.push(['EOT', 'eot-encode', 'eot-decode', [], 'eot']);
      for (const [fmt, enc, dec, extra, outExt] of trips) {
        const r = await roundTrip(ctx, id, enc, dec, extra, outExt);
        const got = r.out ? tablesByTag(r.out) : null;
        const lost = got ? tags.filter((t) => !got.has(t) || !got.get(t).equals(src.get(t))) : tags;
        ctx.rep.check(`${tags.join(' ')} byte-identical after ${fmt}: ${id}`, !r.problem && lost.length === 0 &&
          (r.heap === null || r.heap <= MAX_HEAP), r.problem || `changed: ${lost.join(' ') || 'none'}; heap ${r.heap}`);
      }
    }
    ctx.count('special fonts', n, 6);
    for (const id of collections().filter(ctx.keep)) {
      for (const enc of ['woff-encode', 'eot-encode']) {
        const r = await ctx.eng.run([enc, IN, OUT], { input: { path: fx(id) }, outName: 'out.bin', stale: Buffer.from('x') });
        ctx.rep.check(`${enc} refuses the collection ${id}`, cleanFailure(r, /collection/), describe(r));
      }
    }
  },
};
