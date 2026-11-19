'use strict';
// N5: `hbfont transplant` (P3b plan, P3b-9 to P3b-11): the colour tables of a source put back into FontForge's output
// of it by ffconv's glyph map (made here by the committed ffconv, test/lib/ffconv.js). Structural rows: every other
// table of FontForge's font kept byte for byte; the colour tables present; CPAL whole; COLR's base glyphs and layers
// the source's, translated by the map and sorted; sbix data per mapped glyph equal; CBLC's strikes; SVG documents for
// the mapped glyphs, sorted and rewritten. Refusals with their ids. judge_colour (hbfont-oracle.json, N12) compares the
// colour by glyph identity and outline; the browser rows draw it.

const { readFixture } = require('../lib/fixtures');
const { OUT, inp } = require('../lib/engine');
const { cleanFailure, describe, success } = require('../lib/checks');
const { fontforge } = require('../lib/ffconv');
const { cblcFacts, colrFacts, sbixFacts, svgFacts, svgGlyphIds } = require('../lib/colour');
const { bestUnicodeMap, readSfnt, table } = require('../lib/sfnt');
const { withTable } = require('../lib/names');

const COLOUR = ['COLR', 'CPAL', 'SVG ', 'sbix', 'CBDT', 'CBLC'];

// [label, fixture, input name for ffconv, FontForge's target, an instance to make first ([--at, options]) or null]
const ROWS = [
  ['Twemoji (COLRv0) to otf', 'real/twemoji/Twemoji.Mozilla.ttf', 'input.ttf', 'otf', null],
  ['Twemoji-cff to ttf', 'generated/colour/Twemoji-cff.otf', 'input.otf', 'ttf', null],
  ['Twemoji-cid (sparse CID charset) to ttf', 'generated/colour/Twemoji-cid.otf', 'input.otf', 'ttf', null],
  ['slick-sbix to otf', 'generated/special/slick-sbix.ttf', 'input.ttf', 'otf', null],
  ['slick-cbdt to otf', 'generated/colour/slick-cbdt.ttf', 'input.ttf', 'otf', null],
  ['slick-svg-multi to otf', 'generated/colour/slick-svg-multi.ttf', 'input.ttf', 'otf', null],
  ['slick-colr-svg-cpal to otf', 'generated/colour/slick-colr-svg-cpal.ttf', 'input.ttf', 'otf', null],
  ['slick-svg-cpal to otf', 'generated/colour/slick-svg-cpal.ttf', 'input.ttf', 'otf', null],
  ['Bungee Color SVG to otf', 'real/color-svg/BungeeColor-Regular_svg.ttf', 'input.ttf', 'otf', null],
  // The app gives sbix sources no otf (browsers draw sbix over CFF unlike the source; P3b decision of 2026-11-19);
  // kept as the engine's regression.
  ['Bungee Color sbix to otf', 'real/color-sbix/BungeeColor-Regular_sbix_MacOS.ttf', 'input.ttf', 'otf', null],
  ['Nabla at 200/24 to otf', 'real/var-colr/Nabla[EDPT,EHLT].ttf', 'input.ttf', 'otf', ['EDPT=200,EHLT=24', []]],
  ['Twemoji-cff2-vf at 700 to ttf', 'generated/colour/Twemoji-cff2-vf.otf', 'input.otf', 'ttf',
    ['wght=700', ['--downgrade-cff2']]],
];

function tags(buf) {
  return readSfnt(buf).tables.map((t) => t.tag);
}

async function transplant(ctx, src, outline, map, opts = {}) {
  return ctx.eng.run(['transplant', inp('src'), inp('outline'), inp('map'), OUT],
    { inputs: { src, outline, map }, outName: 'out.font', ...opts });
}

function structural(src, outline, out, map) {
  const p = [];
  const m = JSON.parse(map.toString('utf8'));
  const srcTags = tags(src).filter((t) => COLOUR.includes(t));
  for (const t of tags(outline)) {
    if (COLOUR.includes(t) || t === 'head') continue;
    if (!table(out, t) || Buffer.compare(table(out, t), table(outline, t)) !== 0) p.push(`${t} not FontForge's`);
  }
  const missing = srcTags.filter((t) => !table(out, t));
  if (missing.length) p.push(`missing ${missing.join(' ')}`);
  if (srcTags.includes('CPAL') && Buffer.compare(table(out, 'CPAL'), table(src, 'CPAL')) !== 0) p.push('CPAL not whole');
  const gid = (g) => (m.keyedBy === 'gid' ? m.map[g] : null);
  const sc = colrFacts(src);
  if (sc) {
    const oc = colrFacts(out);
    if (!oc.baseSorted || !oc.v1Sorted) p.push('COLR base glyphs not sorted');
    if (oc.base.length !== sc.base.length || oc.layers.length !== sc.layers.length || oc.v1.length !== sc.v1.length) {
      p.push(`COLR counts ${oc.base.length}/${oc.layers.length}/${oc.v1.length} vs ${sc.base.length}/${sc.layers.length}/${sc.v1.length}`);
    } else if (m.keyedBy === 'gid') {
      const want = sc.base.map((b) => ({ gid: gid(b.gid), layers: sc.layers.slice(b.first, b.first + b.count)
        .map((l) => [gid(l.gid), l.palette]) })).sort((a, b) => a.gid - b.gid);
      const got = oc.base.map((b) => ({ gid: b.gid, layers: oc.layers.slice(b.first, b.first + b.count)
        .map((l) => [l.gid, l.palette]) }));
      if (JSON.stringify(got) !== JSON.stringify(want)) p.push('COLR v0 records are not the source\'s translated by the map');
    }
  }
  const ss = sbixFacts(src);
  if (ss) {
    const os = sbixFacts(out);
    if (os.strikes.length !== ss.strikes.length) p.push('sbix strike count');
    ss.strikes.forEach((st, i) => {
      for (const [g, data] of st.data) {
        const o = os.strikes[i] && os.strikes[i].data.get(gid(g));
        if (!o || Buffer.compare(o, data) !== 0) { p.push(`sbix strike ${i} glyph ${g}`); break; }
      }
    });
  }
  const sb = cblcFacts(src);
  if (sb) {
    const ob = cblcFacts(out);
    if (!ob || ob.sizes.length !== sb.sizes.length) p.push('CBLC strike count');
  }
  const sv = svgFacts(src);
  if (sv) {
    const ov = svgFacts(out);
    if (!ov.sorted) p.push('SVG document index not sorted and disjoint');
    const covered = (f) => f.entries.reduce((n, e) => n + e.end - e.start + 1, 0);
    const want = new Set(sv.entries.flatMap((e) => svgGlyphIds(e.doc).filter((g) => g >= e.start && g <= e.end))
      .map((g) => gid(g)));
    const got = new Set(ov.entries.flatMap((e) => svgGlyphIds(e.doc).filter((g) => g >= e.start && g <= e.end)));
    if (JSON.stringify([...want].sort((a, b) => a - b)) !== JSON.stringify([...got].sort((a, b) => a - b))) {
      p.push('SVG glyph elements are not the source\'s translated by the map');
    }
    if (covered(ov) < got.size) p.push('SVG index covers fewer glyphs than its elements');
  }
  return p.slice(0, 6);
}

// A copy of the map with `edit` applied to its parsed object.
function edited(map, edit) {
  const m = JSON.parse(map.toString('utf8'));
  edit(m);
  return Buffer.from(JSON.stringify(m));
}

module.exports = {
  id: 'N5', title: 'transplant', needsEngine: true,
  async run(ctx) {
    const made = new Map();
    for (const [label, id, inName, to, inst] of ROWS.filter((r) => ctx.keep(r[1]))) {
      let src = readFixture(id);
      if (inst) {
        const i = await ctx.eng.run(['instance', ...inst[1], '--at', inst[0], inp('font'), OUT],
          { inputs: { font: src }, outName: 'inst.font' });
        if (!ctx.rep.check(`${label}: the instance is made`, success(i), describe(i))) continue;
        src = i.out;
      }
      const ff = await fontforge(src, inName, to);
      made.set(id, { src, ...ff });
      const r = await transplant(ctx, src, ff.font, ff.map);
      if (!ctx.rep.check(`${label}: transplants`, success(r), describe(r))) continue;
      const problems = structural(src, ff.font, r.out, ff.map);
      ctx.rep.check(`${label}: colour tables back, translated by the map; FontForge's other tables kept`,
        problems.length === 0, problems.join('; '));
      const again = await transplant(ctx, src, ff.font, ff.map);
      ctx.rep.check(`${label}: a fresh instance gives the same bytes`, success(again) && again.out.equals(r.out));
    }
    // Refusals: a map that does not fit, a colour glyph FontForge lost, a reference the SVG rewrite cannot follow.
    const tw = made.get('real/twemoji/Twemoji.Mozilla.ttf');
    if (tw) {
      const sc = colrFacts(tw.src);
      const layer = sc.layers[0].gid;
      const cases = [
        ['a map one entry short', (m) => { m.map.pop(); m.sourceGlyphs -= 1; }, 'glyph-map-invalid'],
        ['a map sending two glyphs to one', (m) => { m.map[2] = m.map[1]; }, 'glyph-map-invalid'],
        ['a map past the outline font', (m) => { m.map[1] = m.outputGlyphs; }, 'glyph-map-invalid'],
        ['a map not keeping .notdef at 0', (m) => { [m.map[0], m.map[1]] = [m.map[1], m.map[0]]; }, 'glyph-map-invalid'],
        ['a map off by one from glyph 1 on', (m) => { for (let g = m.map.length - 1; g > 1; g--) m.map[g] = m.map[g - 1]; m.map[1] = -1; }, 'glyph-map-mismatch'],
        [`a COLR layer glyph (${layer}) unmapped`, (m) => { m.map[layer] = -1; }, 'colour-glyph-unmapped'],
      ];
      // The closing review (F1): a base glyph FontForge left out loses its colour silently unless refused; an
      // unencoded one (a ZWJ sequence's) passes the cmap check.
      const encoded = new Set(bestUnicodeMap(tw.src).values());
      const base = sc.base.find((b) => !encoded.has(b.gid)).gid;
      cases.push([`an unencoded COLR base glyph (${base}) unmapped`, (m) => { m.map[base] = -1; }, 'colour-glyph-unmapped']);
      for (const [what, edit, want] of cases) {
        const r = await transplant(ctx, tw.src, tw.font, edited(tw.map, edit), { stale: Buffer.from('stale') });
        ctx.rep.check(`Twemoji with ${what}: exit 1, ${want}, no output`, cleanFailure(r, want), describe(r));
      }
    }
    // The closing review (F1): a bitmap glyph left out of the map is refused as a colour glyph, before the cmap check.
    const cbdt = made.get('generated/colour/slick-cbdt.ttf');
    if (cbdt) {
      const g = cblcFacts(cbdt.src).sizes[0].start;
      const r = await transplant(ctx, cbdt.src, cbdt.font, edited(cbdt.map, (m) => { m.map[g] = -1; }), { stale: Buffer.from('stale') });
      ctx.rep.check(`slick-cbdt with its CBDT glyph ${g} unmapped: exit 1, colour-glyph-unmapped`, cleanFailure(r,
        'colour-glyph-unmapped'), describe(r));
    }
    const sbix = made.get('generated/special/slick-sbix.ttf');
    if (sbix) {
      const g = [...sbixFacts(sbix.src).strikes[0].data.keys()].find((x) => x > 0);
      const r = await transplant(ctx, sbix.src, sbix.font, edited(sbix.map, (m) => { m.map[g] = -1; }), { stale: Buffer.from('stale') });
      ctx.rep.check(`slick-sbix with its sbix glyph ${g} unmapped: exit 1, colour-glyph-unmapped`, cleanFailure(r,
        'colour-glyph-unmapped'), describe(r));
    }
    // An internal DTD subset can declare an entity that carries a glyph reference past the rewrite: refused.
    if (ctx.keep('samples/slick.ttf')) {
      const doc = Buffer.from('<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY g "glyph3">]>' +
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">' +
        '<g id="glyph3"><path d="M0 0h100v100z"/></g><use xlink:href="#&g;"/></svg>');
      const head = Buffer.alloc(10 + 2 + 12);
      head.writeUInt32BE(10, 2);
      head.writeUInt16BE(1, 10);
      head.writeUInt16BE(3, 12);
      head.writeUInt16BE(3, 14);
      head.writeUInt32BE(14, 16);
      head.writeUInt32BE(doc.length, 20);
      const src = withTable(readFixture('samples/slick.ttf'), 'SVG ', Buffer.concat([head, doc]));
      const ff = await fontforge(src, 'input.ttf', 'otf');
      const r = await transplant(ctx, src, ff.font, ff.map, { stale: Buffer.from('stale') });
      ctx.rep.check('an SVG document with an internal DTD subset (an entity holding glyph3): exit 1, ' +
        'svg-unsupported-reference', cleanFailure(r, 'svg-unsupported-reference'), describe(r));
    }
    // A CID map read through a CFF whose Name INDEX offset is 0xFFFFFFF8: past the table, though on wasm32 the sum
    // wraps; refused as that offset, not further on.
    const cid = made.get('generated/colour/Twemoji-cid.otf');
    if (cid) {
      const cff = Buffer.from([1, 0, 4, 4, 0, 1, 4, 0, 0, 0, 1, 0xff, 0xff, 0xff, 0xf8, 0x41, 0, 0, 0, 0]);
      const r = await transplant(ctx, withTable(cid.src, 'CFF ', cff), cid.font, cid.map, { stale: Buffer.from('stale') });
      ctx.rep.check('a CID map through a CFF Name INDEX offset of 0xFFFFFFF8: exit 1, cff-invalid, the offset refused',
        cleanFailure(r, 'cff-invalid') && r.stderr.some((l) => /offset points past the table/.test(l)), describe(r));
    }
    // Noto-COLRv1 to otf: FontForge writes a 114,947-byte charstring, which ffconv's result check refuses (P3b
    // decision of 2026-11-19), so there is nothing to transplant into.
    if (ctx.keep('real/color-colr/Noto-COLRv1.ttf')) {
      let refused = null;
      try { await fontforge(readFixture('real/color-colr/Noto-COLRv1.ttf'), 'input.ttf', 'otf'); } catch (e) { refused = e; }
      ctx.rep.check('Noto-COLRv1 to otf: ffconv refuses FontForge\'s output (a charstring over 65,535 bytes)',
        refused !== null && /exit 1/.test(refused.message) && /65,535/.test(refused.message), String(refused));
    }
    if (ctx.keep('generated/colour/slick-svg-style.ttf')) {
      const src = readFixture('generated/colour/slick-svg-style.ttf');
      const ff = await fontforge(src, 'input.ttf', 'otf');
      const r = await transplant(ctx, src, ff.font, ff.map);
      ctx.rep.check('slick-svg-style (a <style> selector #glyphN): exit 1, svg-unsupported-reference', cleanFailure(r,
        'svg-unsupported-reference'), describe(r));
    }
  },
};
