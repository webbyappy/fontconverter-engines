'use strict';
// N3: `hbfont instance` (P3b plan, section 3.1; P3b-10 for CPAL): every spec of the plan's section 2 becomes a static
// font with the source's glyphs and cmap, no variation table and no DSIG, CFF after --downgrade-cff2; coordinates are
// canonicalised to fvar's 16.16 precision; a fresh instance gives the same bytes; CPAL stays whole. Instancing is
// judged against fontTools' instancer by judge_instance in hbfont-oracle.json (N12), not here.

const { readFixture } = require('../lib/fixtures');
const { OUT, inp } = require('../lib/engine');
const { cleanFailure, describe, success } = require('../lib/checks');
const { bestUnicodeMap, readSfnt, table } = require('../lib/sfnt');
const { cffGlyphNames, cffParts, fdDicts, maxOperandRun, withFdArray } = require('../lib/cff');
const { postGlyphNames, postV2, postVersion } = require('../lib/post');
const { cffStandardStrings } = require('../facts/name-tables.json');
const { languageSystemDifferences } = require('../lib/layout');
const { overlapFlags } = require('../lib/glyf');
// ffconv's CFF builder: glyph n's program pushes length - 1 operands of 0, then endchar.
const { buildCff, withTable } = require('../../../fontforge-wasm/test/lib/cffbuild');

const VARIATION_TABLES = ['fvar', 'gvar', 'CFF2', 'cvar', 'HVAR', 'MVAR', 'VVAR', 'avar', 'DSIG'];
const RESULT_FIELDS = ['ok', 'command', 'flavor', 'numGlyphs', 'coordinates', 'downgraded', 'inSize', 'outSize'];

// [fixture, label, --at, extra options, the outline flavour expected]
const SPECS = [
  ['real/var-ttf/OpenSans-VF.ttf', 'regular = default', 'wght=400,wdth=100', [], 'truetype'],
  ['real/var-ttf/OpenSans-VF.ttf', 'Condensed Bold', 'wght=700,wdth=75', [], 'truetype'],
  ['real/var-ttf/OpenSans-VF.ttf', 'custom 450/87.5', 'wght=450,wdth=87.5', [], 'truetype'],
  ['real/sourcesans-vf/SourceSans3VF-Upright.ttf', 'regular (named, not the default)', 'wght=400', [], 'truetype'],
  ['real/sourcesans-vf/SourceSans3VF-Upright.ttf', 'default', 'wght=200', [], 'truetype'],
  ['real/sourcesans-vf/SourceSans3VF-Upright.ttf', 'custom 650', 'wght=650', [], 'truetype'],
  ['real/sourcesans-vf/SourceSans3VF-Upright.otf', 'regular, downgraded', 'wght=400', ['--downgrade-cff2'], 'cff'],
  ['real/sourcesans-vf/SourceSans3VF-Upright.otf', 'Bold, downgraded', 'wght=700', ['--downgrade-cff2'], 'cff'],
  ['real/var-cjk-ttf/NotoSansSC-VF.ttf', 'regular', 'wght=400', [], 'truetype'],
  ['generated/variable/slick-vf-nostat.ttf', 'regular clamped to 500', 'wght=500', [], 'truetype'],
  ['generated/variable/slick-vf-nostat.ttf', 'custom 650', 'wght=650', [], 'truetype'],
  ['generated/variable/OpenSans-VF-long-name.ttf', 'regular', 'wght=400,wdth=100', [], 'truetype'],
  ['real/var-colr/Nabla[EDPT,EHLT].ttf', 'default', 'EDPT=100,EHLT=12', [], 'truetype'],
  ['real/var-colr/Nabla[EDPT,EHLT].ttf', 'not the default', 'EDPT=200,EHLT=24', [], 'truetype'],
  ['generated/colour/Twemoji-cff2-vf.otf', 'regular = default, downgraded', 'wght=400', ['--downgrade-cff2'], 'cff'],
  ['generated/colour/Twemoji-cff2-vf.otf', '700, downgraded', 'wght=700', ['--downgrade-cff2'], 'cff'],
];

function tags(buf) {
  return readSfnt(buf).tables.map((t) => t.tag);
}

function sameMap(a, b) {
  return a.size === b.size && [...a].every(([cp, g]) => b.get(cp) === g);
}

async function instance(ctx, font, at, extra = []) {
  return ctx.eng.run(['instance', ...extra, '--at', at, inp('font'), OUT], { inputs: { font }, outName: 'out.font' });
}

module.exports = {
  id: 'N3', title: 'instance', needsEngine: true,
  async run(ctx) {
    const outputs = new Map();
    for (const [id, label, at, extra, flavor] of SPECS.filter((s) => ctx.keep(s[0]))) {
      const src = readFixture(id);
      const r = await instance(ctx, src, at, extra);
      const name = `${id} ${label} (${at})`;
      if (!ctx.rep.check(`${name}: instances, one JSON line with the result fields`, success(r) &&
        JSON.stringify(Object.keys(r.json).sort()) === JSON.stringify([...RESULT_FIELDS].sort()), describe(r))) continue;
      outputs.set(`${id} ${at}`, r.out);
      const left = tags(r.out).filter((t) => VARIATION_TABLES.includes(t));
      ctx.rep.check(`${name}: static, no variation table or DSIG left`, left.length === 0, left.join(' '));
      const outTags = tags(r.out);
      ctx.rep.check(`${name}: ${flavor} outlines`, r.json.flavor === flavor &&
        (flavor === 'cff' ? outTags.includes('CFF ') : outTags.includes('glyf')) &&
        r.json.downgraded === extra.includes('--downgrade-cff2'), `${r.json.flavor}, ${outTags.join(' ')}`);
      if (flavor === 'truetype') {
        // An instance keeps the variable font's overlapping contours; the flags ask every rasterizer for the non-zero
        // fill (OpenType's advice for a static font with overlaps; fontTools' instancer default; P3b decision of
        // 2026-11-19 with Codex's read-only advice). HarfBuzz's SET_OVERLAPS_FLAG.
        const f = overlapFlags(r.out);
        ctx.rep.check(`${name}: every outline glyph flagged (OVERLAP_SIMPLE, OVERLAP_COMPOUND on its first component)`,
          f.unflagged.length === 0 && f.simple + f.composite > 0, `${f.simpleFlagged}/${f.simple} simple, ` +
          `${f.compositeFlagged}/${f.composite} composite; unflagged ${f.unflagged.slice(0, 5).join(' ')}`);
      }
      if (extra.includes('--downgrade-cff2')) {
        // CFF1's argument stack holds 48 operands; CFF2's 513 (HarfBuzz 15.0.0 kept CFF2's longer curve runs:
        // harfbuzz-wasm patch 2).
        const parts = cffParts(table(r.out, 'CFF '));
        const runs = parts.charStrings.map(maxOperandRun);
        const worst = Math.max(...runs);
        const subrs = parts.globalSubrs.length + parts.privates.reduce((x, q) => x + (q ? q.subrs.length : 0), 0);
        ctx.rep.check(`${name}: every charstring within CFF1's 48-operand stack (no subroutines)`,
          worst <= 48 && subrs === 0, `deepest run ${worst} in glyph ${runs.indexOf(worst)}; ${subrs} subroutines`);
        // HarfBuzz writes a CID-keyed CFF (cid00001...); hbfont makes it name-keyed with the source's glyph names, as
        // fontTools' instancer does (P3b decision of 2026-11-19 with Codex: FontForge lost every mark-attachment class of
        // the CID-keyed instance, and editors show the names), and post becomes format 3 (CFF carries the names).
        const got = cffGlyphNames(table(r.out, 'CFF '), cffStandardStrings);
        const want = postGlyphNames(src);
        ctx.rep.check(`${name}: a name-keyed CFF named as the source's post table, post format 3`, got !== null &&
          JSON.stringify(got) === JSON.stringify(want) && postVersion(r.out) === 0x00030000,
        got === null ? 'CID-keyed' : `${got.filter((x, g) => x !== want[g]).length} names differ; post 0x${postVersion(r.out).toString(16)}`);
      }
      // Every language system kept with its features, also one equal to its script's default (harfbuzz-wasm patch 3:
      // HarfBuzz's subsetter prunes those; applications that list a font's language systems would lose them).
      const lang = ['GSUB', 'GPOS'].flatMap((t) => languageSystemDifferences(src, r.out, t));
      ctx.rep.check(`${name}: every GSUB and GPOS language system of the source, with its features`, lang.length === 0,
        `${lang.length}: ${lang.slice(0, 4).join('; ')}`);
      const n = table(src, 'maxp').readUInt16BE(4);
      ctx.rep.check(`${name}: the source's ${n} glyphs and cmap`, table(r.out, 'maxp').readUInt16BE(4) === n &&
        r.json.numGlyphs === n && sameMap(bestUnicodeMap(r.out), bestUnicodeMap(src)));
      if (tags(src).includes('CPAL')) {
        ctx.rep.check(`${name}: CPAL kept whole, every palette entry and index (P3b-10)`,
          Buffer.compare(table(r.out, 'CPAL'), table(src, 'CPAL')) === 0);
      }
      const again = await instance(ctx, src, at, extra);
      ctx.rep.check(`${name}: a fresh instance gives the same bytes`, success(again) && again.out.equals(r.out));
    }
    // Instancing happened: a non-default location differs from the default one.
    const def = outputs.get('real/var-ttf/OpenSans-VF.ttf wght=400,wdth=100');
    const cb = outputs.get('real/var-ttf/OpenSans-VF.ttf wght=700,wdth=75');
    if (def && cb) {
      ctx.rep.check('OpenSans-VF: Condensed Bold has other advances than the default instance',
        Buffer.compare(table(def, 'hmtx'), table(cb, 'hmtx')) !== 0);
    }
    // Coordinates canonicalised to 16.16: a value one millionth away is the same instance.
    if (ctx.keep('real/var-ttf/OpenSans-VF.ttf')) {
      const src = readFixture('real/var-ttf/OpenSans-VF.ttf');
      const near = await instance(ctx, src, 'wght=450.000001,wdth=87.5');
      ctx.rep.check('OpenSans-VF at wght=450.000001: canonicalised to 450, the same bytes as 450', success(near) &&
        near.json.coordinates.wght === 450 && near.json.coordinates.wdth === 87.5 &&
        near.out.equals(outputs.get('real/var-ttf/OpenSans-VF.ttf wght=450,wdth=87.5') || Buffer.alloc(0)),
      describe(near));
    }
    // A static CFF2 font has nothing to instance, and HarfBuzz would not downgrade it (P3b plan, section 1.4).
    const s = await instance(ctx, readFixture('generated/variable/SourceSans3-static.cff2.otf'), 'wght=400',
      ['--downgrade-cff2']);
    ctx.rep.check('a static CFF2 font asked to instance: exit 1, not-variable, no output', cleanFailure(s, 'not-variable'),
      describe(s));
    // hbfont's own check of a downgraded CFF, which fails closed (harfbuzz-wasm patch 2 is the repair; this is the
    // guard): at most 48 operands on the stack, CFF1's limit. selftest-cff-stack runs the check alone on any CFF font.
    const slick = readFixture('samples/slick.otf');
    for (const [operands, ok] of [[48, true], [49, false]]) {
      const font = withTable(slick, 'CFF ', buildCff({ charStrings: [2, operands + 1] }));
      const r = await ctx.eng.run(['selftest-cff-stack', inp('font')], { inputs: { font } });
      ctx.rep.check(`the downgrade's stack check on a charstring of ${operands} operands: ${ok ? 'accepted' :
        'exit 1, output-invalid'}`, ok ? success(r, true) && r.json.deepest === operands : cleanFailure(r, 'output-invalid'),
      describe(r));
    }
    // The name-keying alone (selftest-cff-namekey writes the font name-keyed, or unchanged when it stays CID-keyed):
    // Twemoji-cid (sparse CID charset, post format 3) and that font given in post the glyph names of Twemoji-cff (the
    // name-keyed font it was made from), rewritten by HarfBuzz (5-byte DICT offsets, as the downgrade writes them), then
    // with each reason to stay CID-keyed planted.
    const std = await ctx.eng.run(['selftest-cff-strings']);
    ctx.rep.check('hbfont\'s 391 CFF standard strings are fontTools\' (facts/name-tables.json)', success(std, true) &&
      JSON.stringify(std.json.strings) === JSON.stringify(cffStandardStrings), describe(std));
    const cid = readFixture('generated/colour/Twemoji-cid.otf');
    const names = cffGlyphNames(table(readFixture('generated/colour/Twemoji-cff.otf'), 'CFF '), cffStandardStrings);
    const named = withTable(cid, 'post', postV2(cid, names));
    const hb = await ctx.eng.run(['selftest-hb-rewrite', inp('font'), OUT], { inputs: { font: named }, outName: 'hb.otf' });
    const namekey = (font) => ctx.eng.run(['selftest-cff-namekey', inp('font'), OUT], { inputs: { font }, outName: 'nk.otf' });
    if (ctx.rep.check('Twemoji-cid with post names, rewritten by HarfBuzz: still CID-keyed', success(hb) &&
      cffGlyphNames(table(hb.out, 'CFF '), cffStandardStrings) === null && names.length === table(cid, 'maxp').readUInt16BE(4),
    describe(hb))) {
      const keyed = await namekey(hb.out);
      const before = cffParts(table(hb.out, 'CFF '));
      const after = success(keyed) ? cffParts(table(keyed.out, 'CFF ')) : null;
      ctx.rep.check('name-keyed: the post names in the charset, post format 3, CharStrings and the Private DICT unchanged',
        success(keyed) && keyed.json.keyed === 'name' &&
        JSON.stringify(cffGlyphNames(table(keyed.out, 'CFF '), cffStandardStrings)) === JSON.stringify(names) &&
        postVersion(keyed.out) === 0x00030000 && after.charStrings.every((x, g) => x.equals(before.charStrings[g])) &&
        after.privates.length === 1 && after.privates[0].dict.equals(before.privates[0].dict), describe(keyed));
      const hbCff = table(hb.out, 'CFF ');
      const fd = fdDicts(hbCff)[0];
      const stays = [
        ['Twemoji-cid as it is (post format 3: no glyph names)', cid],
        ['two glyphs with one name', withTable(hb.out, 'post', postV2(hb.out, names.map((x, g) => (g === 2 ? names[1] : x))))],
        ['a name with a space', withTable(hb.out, 'post', postV2(hb.out, names.map((x, g) => (g === 3 ? 'a b' : x))))],
        ['two FDs', withTable(hb.out, 'CFF ', withFdArray(hbCff, [fd, fd]))],
        ['an FD FontMatrix', withTable(hb.out, 'CFF ', withFdArray(hbCff, [Buffer.concat([
          Buffer.from([0x8c, 0x8b, 0x8b, 0x8c, 0x8b, 0x8b, 12, 7]), fd])]))],
      ];
      for (const [what, font] of stays) {
        const k = await namekey(font);
        ctx.rep.check(`stays CID-keyed: ${what} (the font unchanged)`, success(k) && k.json.keyed === 'cid' &&
          typeof k.json.why === 'string' && k.out.equals(font), describe(k));
      }
    }
    const sub = withTable(slick, 'CFF ', buildCff({ charStrings: [2, 3], globalSubrs: [2] }));
    const call = await ctx.eng.run(['selftest-cff-stack', inp('font')], { inputs: { font: sub } });
    ctx.rep.check('the stack check on a CFF with subroutines (HarfBuzz desubroutinizes when instancing): exit 1, '
      + 'output-invalid', cleanFailure(call, 'output-invalid'), describe(call));
  },
};
