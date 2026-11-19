'use strict';
// N8: a font with only Mac names and a Mac Roman cmap converts with the code points its (1,0) subtable means, plus
// exactly the pinned extra mappings, per target (P2-25 H, the owner's decision of 2026-11-18).

const { fx, readFixture } = require('../lib/fixtures');
const { IN, OUT } = require('../lib/engine');
const { describe, success } = require('../lib/checks');
const { bestUnicodeMap, unicodeCodepoints } = require('../lib/sfnt');
const svg = require('../lib/svgfont');

const MAC = 'generated/structure/mac-names-and-cmap.ttf';
// The extra mappings beyond the Mac Roman reading, with the glyph each one maps to, pinned after review (B10):
// - otf and svg: U+00A4 -> currency. FontForge adds the code point the glyph's name stands for; the input maps the
//   glyph at Mac 0xDB, which Mac Roman reads as U+20AC (kept too).
// - svg only: .notdef carries the Mac codes the input's format-0 table leaves on glyph 0, translated through iconv's
//   MACINTOSH table (FontForge's alternates come from it): GNU libiconv here, glibc in production, so production
//   writes U+0394 and U+E01E where ffconv writes U+2126 and U+2206 (B10's twin run). They select .notdef only.
const EXTRAS = {
  otf: [[0xa4, 174]],
  svg: ['.notdef U+000A', '.notdef U+03A9', '.notdef U+03C0', '.notdef U+2044', '.notdef U+2126', '.notdef U+2202',
    '.notdef U+2206', '.notdef U+220F', '.notdef U+2211', '.notdef U+221A', '.notdef U+221E', '.notdef U+222B',
    '.notdef U+2248', '.notdef U+2260', '.notdef U+2264', '.notdef U+2265', '.notdef U+25CA', '.notdef U+FB01',
    '.notdef U+FB02', 'currency U+00A4'],
};

// XML 1.0 cannot carry these characters, so no SVG font can map them: FontForge writes their glyphs without a
// unicode attribute (TAB, LF and CR are allowed and kept).
const XML_FORBIDDEN = (c) => c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d;

function hex(set) {
  return [...set].sort((a, b) => a - b).map((c) => 'U+' + c.toString(16).toUpperCase().padStart(4, '0'));
}

module.exports = {
  id: 'N8', title: 'legacy encodings', needsEngine: true,
  async run(ctx) {
    const want = unicodeCodepoints(readFixture(MAC));
    ctx.rep.check('the Mac Roman reading of the input is not empty', want.size > 50, `${want.size} code points`);
    for (const target of ['otf', 'svg']) {
      const r = await ctx.eng.run(['convert', IN, OUT], { input: { path: fx(MAC) }, inName: 'input.ttf',
        outName: `output.${target}` });
      if (!success(r, target).ok) { ctx.rep.fail(`-> ${target}`, describe(r)); continue; }
      const els = target === 'svg' ? svg.glyphs(r.out.toString('utf8')).filter((g) => g.attrs.unicode &&
        [...g.attrs.unicode].length === 1) : [];
      const map = target === 'otf' ? bestUnicodeMap(r.out) : null;
      const got = target === 'otf' ? new Set(map.keys()) : new Set(els.map((g) => g.attrs.unicode.codePointAt(0)));
      const missing = [...want].filter((c) => !got.has(c) && !(target === 'svg' && XML_FORBIDDEN(c)));
      const extra = target === 'otf'
        ? [...map].filter(([c]) => !want.has(c)).sort((a, b) => a[0] - b[0])
        : els.filter((g) => !want.has(g.attrs.unicode.codePointAt(0)))
          .map((g) => `${g.attrs['glyph-name']} ${hex([g.attrs.unicode.codePointAt(0)])[0]}`).sort();
      ctx.rep.check(`-> ${target}: the input's code points, plus exactly the pinned extra mappings`,
        missing.length === 0 && JSON.stringify(extra) === JSON.stringify(EXTRAS[target]),
      `missing ${hex(new Set(missing)).join(' ')}; extras ${JSON.stringify(extra)}`);
    }
  },
};
