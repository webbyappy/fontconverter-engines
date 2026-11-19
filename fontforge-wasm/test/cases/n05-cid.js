'use strict';
// N5: a CID-keyed font is flattened (every Font DICT, not the first sub-font), and a non-CID font is not.

const { fx, readFixture } = require('../lib/fixtures');
const { IN, OUT } = require('../lib/engine');
const { describe, success } = require('../lib/checks');
const svg = require('../lib/svgfont');
const { bestUnicodeMap } = require('../lib/sfnt');
const oracle = require('../lib/oracle');

const CID = 'generated/cid/NotoSansCJKjp-cid-small.otf';

module.exports = {
  id: 'N5', title: 'CID', needsEngine: true,
  async run(ctx) {
    const toSvg = await ctx.eng.run(['convert', IN, OUT], { input: { path: fx(CID) }, inName: 'input.otf',
      outName: 'output.svg' });
    const ref = oracle.twinRefs({ fid: CID, target: 'svg' });
    const theirs = readFixture(ref[ref.reference].rel).toString('utf8');
    const ours = toSvg.out ? toSvg.out.toString('utf8') : '';
    const lost = svg.lostFrom(ours, theirs);
    const added = svg.addedTo(ours, theirs);
    const unjustified = added.filter((e) => !svg.aliasJustified(e, svg.glyphs(theirs), bestUnicodeMap(readFixture(CID))));
    ctx.rep.check('CID font -> svg flattens every Font DICT: every element production writes, and besides only ' +
      'aliases the source maps to the same glyph', success(toSvg, 'svg').ok && toSvg.json.cidFlattened === true &&
      svg.glyphs(theirs).length > 52 && !lost.length && !unjustified.length,
    `${describe(toSvg)}; lost ${lost.length}, added ${added.length}, unjustified ${unjustified.length}: ` +
      unjustified.slice(0, 3).map((e) => svg.signature(e, false)).join(' | '));
    const toTtf = await ctx.eng.run(['convert', IN, OUT], { input: { path: fx(CID) }, inName: 'input.otf',
      outName: 'output.ttf' });
    ctx.rep.check('CID font -> ttf converts', success(toTtf, 'ttf').ok && toTtf.json.cidFlattened === true,
      describe(toTtf));
    const plain = await ctx.eng.run(['convert', IN, OUT], { input: { path: fx('samples/slick.ttf') }, inName: 'input.ttf',
      outName: 'output.otf' });
    ctx.rep.check('a non-CID font is not flattened and says nothing about CIDFlatten', success(plain, 'otf').ok &&
      plain.json.cidFlattened === false && !plain.stderr.some((l) => /CIDFlatten/i.test(l)), describe(plain));
  },
};
