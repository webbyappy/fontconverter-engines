'use strict';
// N4: an instance names itself (P3b plan, section 3.4, the owner's Q4): nameIDs 1, 2, 3, 4, 6, 16, 17, the legacy
// style link in OS/2 fsSelection and head macStyle, and the CFF FontName, pinned per spec. The strings follow the
// rule applied by hand to each source's names, STAT and fvar (read with fontTools 4.68.0 on 2026-11-18):
//   F = nameID 16, else 1 (trimmed); S = the named instance's subfamily when every coordinate matches one; else STAT
//   (axis values in STAT's axis order: an exact nominal value first, else the first range holding the coordinate,
//   bounds included; elidable values left out; the elided fallback name when all are); else "<axis name> <value>"
//   for each axis off its default ("Regular" when none is), when STAT cannot name every axis.
//   1/2 = the legacy pair (only Bold and Italic style-linked); 4 = "F S" (F when S is Regular); 6 = the instance's own
//   PostScript name, else nameID 25 (ASCII letters and digits, at most 31) or F reduced to them, then "-" + S reduced
//   (a named instance) or "_" + value + tag per axis off its default; 3 = "<fontRevision, 3 decimals>;<achVendID>;<6>".

const { readFixture } = require('../lib/fixtures');
const { OUT, inp } = require('../lib/engine');
const { cleanFailure, describe, success } = require('../lib/checks');
const { nameRecords, nameTable, nameText, utf16be, withTable } = require('../lib/names');
const { readSfnt, table } = require('../lib/sfnt');
const { cffParts, invariantParts } = require('../lib/cff');

const LONG = 'Ëxtrà Lóng Fàmîly Nämé Wïth Àccénts Thät Gões Ön Ând Ön Ünţil Seventy'; // nameID 1 of the fixture, trimmed
const IDS = [1, 2, 3, 4, 6, 16, 17];

function names(f, s, ps, rev, vend, legacy = null) {
  const [l1, l2] = legacy || (s === 'Regular' ? [f, 'Regular'] : [`${f} ${s}`, 'Regular']);
  return { 1: l1, 2: l2, 3: `${rev};${vend};${ps}`, 4: s === 'Regular' ? f : `${f} ${s}`, 6: ps, 16: f, 17: s };
}

// [fixture, --at, options, expected names, fsSelection, macStyle, CFF FontName or null, Mac records expected]
const SPECS = [
  ['real/var-ttf/OpenSans-VF.ttf', 'wght=400,wdth=100', [],
    names('Open Sans', 'Regular', 'OpenSansRoman-Regular', '3.003', 'GOOG'), 0x1c0, 0, null, false],
  ['real/var-ttf/OpenSans-VF.ttf', 'wght=700,wdth=75', [],
    names('Open Sans', 'Condensed Bold', 'OpenSansRoman-CondensedBold', '3.003', 'GOOG',
      ['Open Sans Condensed', 'Bold']), 0x1a0, 1, null, false],
  ['real/var-ttf/OpenSans-VF.ttf', 'wght=450,wdth=87.5', [],
    names('Open Sans', 'Weight 450 Width 87.5', 'OpenSansRoman_450wght_87.5wdth', '3.003', 'GOOG'), 0x1c0, 0, null,
    false],
  ['real/sourcesans-vf/SourceSans3VF-Upright.ttf', 'wght=400', [],
    names('SourceSans3VF', 'Regular', 'SourceSans3VF-Regular', '3.052', 'ADBO'), 0x40, 0, null, false],
  ['real/sourcesans-vf/SourceSans3VF-Upright.ttf', 'wght=200', [],
    names('SourceSans3VF', 'ExtraLight', 'SourceSans3VF-ExtraLight', '3.052', 'ADBO'), 0x40, 0, null, false],
  ['real/sourcesans-vf/SourceSans3VF-Upright.ttf', 'wght=650', [],
    names('SourceSans3VF', 'Semibold', 'SourceSans3Upright_650wght', '3.052', 'ADBO'), 0x40, 0, null, false],
  ['real/sourcesans-vf/SourceSans3VF-Upright.otf', 'wght=400', ['--downgrade-cff2'],
    names('SourceSans3VF', 'Regular', 'SourceSans3VF-Regular', '3.052', 'ADBO'), 0x40, 0, 'SourceSans3VF-Regular',
    false],
  ['real/sourcesans-vf/SourceSans3VF-Upright.otf', 'wght=700', ['--downgrade-cff2'],
    names('SourceSans3VF', 'Bold', 'SourceSans3VF-Bold', '3.052', 'ADBO', ['SourceSans3VF', 'Bold']), 0x20, 1,
    'SourceSans3VF-Bold', false],
  ['real/var-cjk-ttf/NotoSansSC-VF.ttf', 'wght=400', [],
    names('Noto Sans SC', 'Regular', 'NotoSansSC-Regular', '2.004', 'ADBO'), 0x40, 0, null, false],
  ['generated/variable/slick-vf-nostat.ttf', 'wght=500', [],
    names('slick', 'Weight 500', 'slick_500wght', '1.000', 'PfEd'), 0x40, 0, null, true],
  ['generated/variable/slick-vf-nostat.ttf', 'wght=650', [],
    names('slick', 'Weight 650', 'slick_650wght', '1.000', 'PfEd'), 0x40, 0, null, true],
  ['generated/variable/OpenSans-VF-long-name.ttf', 'wght=400,wdth=100', [],
    names(LONG, 'Regular', 'OpenSansRoman-Regular', '3.003', 'GOOG'), 0x1c0, 0, null, false],
  ['generated/variable/OpenSans-VF-long-name.ttf', 'wght=450,wdth=87.5', [],
    names(LONG, 'Weight 450 Width 87.5', 'xtrLngFmlyNmWthccntsThtGesnndnnilSeventy_450wght_87.5wdth', '3.003', 'GOOG'),
    0x1c0, 0, null, false],
  ['real/var-colr/Nabla[EDPT,EHLT].ttf', 'EDPT=100,EHLT=12', [],
    names('Nabla', 'Regular', 'Nabla-Regular', '1.003', 'TYPT'), 0xc0, 0, null, false],
  ['real/var-colr/Nabla[EDPT,EHLT].ttf', 'EDPT=200,EHLT=24', [],
    names('Nabla', 'Deep Max Highlight', 'Nabla_200EDPT_24EHLT', '1.003', 'TYPT'), 0xc0, 0, null, false],
  ['generated/colour/Twemoji-cff2-vf.otf', 'wght=400', ['--downgrade-cff2'],
    names('Twemoji CFF', 'Regular', 'TwemojiCFF', '1.000', '????'), 0x40, 0, 'TwemojiCFF', true],
  ['generated/colour/Twemoji-cff2-vf.otf', 'wght=700', ['--downgrade-cff2'],
    names('Twemoji CFF', 'Weight 700', 'TwemojiCFF_700wght', '1.000', '????'), 0x40, 0, 'TwemojiCFF_700wght', true],
];

// [fixture, FontName]: a CID-keyed font with 13 FDs and a name-keyed one, each rewritten by HarfBuzz first.
const CFF_ROWS = [
  ['generated/cid/NotoSansCJKjp-cid-small.otf', 'N'],
  ['generated/cid/NotoSansCJKjp-cid-small.otf', 'NotoSansCJKjp-Regular-With-A-Much-Longer-FontName-Than-Before'],
  ['generated/colour/Twemoji-cff.otf', 'T'],
  ['generated/colour/Twemoji-cff.otf', 'TwemojiCFF-A-Longer-FontName'],
];

// The first name of a CFF table's Name INDEX.
function cffFontName(buf) {
  const c = table(buf, 'CFF ');
  if (!c) return null;
  const at = c[2]; // hdrSize
  const count = c.readUInt16BE(at);
  if (count < 1) return null;
  const offSize = c[at + 2];
  const off = (i) => c.readUIntBE(at + 3 + i * offSize, offSize);
  const data = at + 3 + (count + 1) * offSize - 1;
  return c.toString('latin1', data + off(0), data + off(1));
}

function platformsOf(buf) {
  return [...new Set(nameRecords(buf).filter((r) => IDS.includes(r.id))
    .map((r) => `${r.platform}/${r.encoding}/0x${r.language.toString(16)}`))].sort();
}

async function instance(ctx, font, at, extra) {
  return ctx.eng.run(['instance', ...extra, '--at', at, inp('font'), OUT], { inputs: { font }, outName: 'out.font' });
}

module.exports = {
  SPECS, // read by make-oracle.mjs (judge_instance --expect): the pinned names live in one place
  id: 'N4', title: 'names', needsEngine: true,
  async run(ctx) {
    for (const [id, at, extra, want, fs, mac, cff, macRecords] of SPECS.filter((s) => ctx.keep(s[0]))) {
      const r = await instance(ctx, readFixture(id), at, extra);
      const label = `${id} at ${at}`;
      if (!ctx.rep.check(`${label}: instances`, success(r), describe(r))) continue;
      const got = Object.fromEntries(IDS.map((n) => [n, nameText(r.out, n)]));
      const diffs = IDS.filter((n) => got[n] !== want[n]).map((n) => `${n}: ${JSON.stringify(got[n])} vs ${JSON.stringify(want[n])}`);
      ctx.rep.check(`${label}: Windows English names 1, 2, 3, 4, 6, 16, 17`, diffs.length === 0, diffs.join('; '));
      const os2 = table(r.out, 'OS/2');
      const head = table(r.out, 'head');
      ctx.rep.check(`${label}: fsSelection 0x${fs.toString(16)}, macStyle ${mac}`, os2.readUInt16BE(62) === fs &&
        head.readUInt16BE(44) === mac, `fsSelection 0x${os2.readUInt16BE(62).toString(16)}, macStyle ${head.readUInt16BE(44)}`);
      if (cff) ctx.rep.check(`${label}: CFF FontName ${cff}`, cffFontName(r.out) === cff, String(cffFontName(r.out)));
      const wantPlatforms = ['3/1/0x409', ...(macRecords ? ['1/0/0x0'] : [])].sort();
      ctx.rep.check(`${label}: names 1-4, 6, 16, 17 only on ${wantPlatforms.join(', ')}`,
        JSON.stringify(platformsOf(r.out)) === JSON.stringify(wantPlatforms), platformsOf(r.out).join(', '));
      if (macRecords) {
        const macDiffs = IDS.filter((n) => n !== 3 && nameText(r.out, n, 1, 0, 0) !== want[n]);
        ctx.rep.check(`${label}: Mac Roman names equal the Windows ones`, macDiffs.length === 0, macDiffs.join(' '));
      }
    }
    // The CFF FontName alone (selftest-cff-name, the code `instance` runs on a downgraded font), on CFF HarfBuzz wrote
    // (selftest-hb-rewrite: everything kept): a shorter and a longer name, on a name-keyed font and on a CID-keyed one
    // with 13 FDs; every byte range the name must not touch equal, every other table unchanged. A CFF another tool
    // wrote (offsets not as 5-byte integers) is refused, never re-encoded.
    for (const [id, name] of CFF_ROWS.filter((x) => ctx.keep(x[0]))) {
      const hb = await ctx.eng.run(['selftest-hb-rewrite', inp('font'), OUT], { inputs: { font: readFixture(id) },
        outName: 'hb.otf' });
      if (!ctx.rep.check(`${id}: HarfBuzz rewrites it`, success(hb), describe(hb))) continue;
      const src = hb.out;
      const r = await ctx.eng.run(['selftest-cff-name', inp('font'), name, OUT], { inputs: { font: src },
        outName: 'out.otf' });
      if (!ctx.rep.check(`${id} (HarfBuzz's CFF): the FontName becomes ${name.length} characters`, success(r) &&
        cffParts(table(r.out, 'CFF ')).fontName === name, describe(r))) continue;
      const a = invariantParts(cffParts(table(src, 'CFF ')));
      const b = invariantParts(cffParts(table(r.out, 'CFF ')));
      const differ = a.filter(([label, bytes], i) => !b[i] || b[i][0] !== label || Buffer.compare(b[i][1], bytes) !== 0);
      const fds = cffParts(table(src, 'CFF ')).privates.length;
      ctx.rep.check(`${id}: ${a.length} charstrings, subroutines, ${fds} Private DICTs, charset, FDSelect byte for byte`,
        a.length === b.length && differ.length === 0, differ.slice(0, 3).map((d) => d[0]).join(', '));
      const others = readSfnt(src).tables.map((t) => t.tag).filter((t) => t !== 'CFF ' && t !== 'head' &&
        Buffer.compare(table(src, t), table(r.out, t) || Buffer.alloc(0)) !== 0);
      ctx.rep.check(`${id}: every other table but head unchanged`, others.length === 0, others.join(' '));
    }
    for (const id of [...new Set(CFF_ROWS.map((x) => x[0]))].filter(ctx.keep)) {
      const r = await ctx.eng.run(['selftest-cff-name', inp('font'), 'X', OUT], { inputs: { font: readFixture(id) },
        outName: 'out.otf', stale: Buffer.from('stale') });
      ctx.rep.check(`${id} as fontTools wrote it: cff-layout-unsupported, no output`,
        cleanFailure(r, 'cff-layout-unsupported'), describe(r));
    }
    // A localized family (planted in memory: OpenSans-VF with a German nameID 1) is rebuilt from its own family, with
    // S where the font has no German subfamily.
    if (ctx.keep('real/var-ttf/OpenSans-VF.ttf')) {
      const src = readFixture('real/var-ttf/OpenSans-VF.ttf');
      const recs = nameRecords(src).map((x) => ({ platform: x.platform, encoding: x.encoding, language: x.language,
        id: x.id, bytes: x.bytes }));
      recs.push({ platform: 3, encoding: 1, language: 0x407, id: 1, bytes: utf16be('Offene Sans') });
      const planted = withTable(src, 'name', nameTable(recs));
      const r = await instance(ctx, planted, 'wght=700,wdth=75', []);
      const de = Object.fromEntries([1, 2, 4, 16, 17].map((n) => [n, nameText(r.out, n, 3, 1, 0x407)]));
      const wantDe = { 1: 'Offene Sans Condensed', 2: 'Bold', 4: 'Offene Sans Condensed Bold', 16: 'Offene Sans',
        17: 'Condensed Bold' };
      ctx.rep.check('a German family: 1, 2, 4, 16, 17 rebuilt in German beside the English ones', success(r) &&
        JSON.stringify(de) === JSON.stringify(wantDe) && nameText(r.out, 1) === 'Open Sans Condensed',
      `${describe(r)}; ${JSON.stringify(de)}`);
    }
  },
};
