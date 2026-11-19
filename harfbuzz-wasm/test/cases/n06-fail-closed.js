'use strict';
// N6: fail closed (P3b plan, section 4.1): what is not a font, a font that cannot be instanced as asked, a damaged
// table, a decompression bomb in an SVG document: exit 1, the failure line with its id, one error line, no output
// (a stale one removed), the inputs untouched.

const zlib = require('zlib');
const { readFixture } = require('../lib/fixtures');
const { OUT, inp } = require('../lib/engine');
const { cleanFailure, describe } = require('../lib/checks');
const { readSfnt } = require('../lib/sfnt');
const { withTable } = require('../lib/names');

const OPENSANS_VF = 'real/var-ttf/OpenSans-VF.ttf';
const STALE = Buffer.from('stale output');

// The font with table `tag` cut to `length` bytes (the directory says so).
function truncatedTable(font, tag, length) {
  const t = readSfnt(font).tables.find((x) => x.tag === tag);
  return withTable(font, tag, font.subarray(t.offset, t.offset + length));
}

// The font with a second fvar record before its own, holding an axis array past the end of the table (the closing
// review, F1: hbfont read the first record unchecked while HarfBuzz may read the other). Directory sorted by tag.
function secondFvar(font, after = false) {
  const { sfntVersion, tables } = readSfnt(font);
  const bad = Buffer.alloc(16);
  bad.writeUInt16BE(1, 0);
  bad.writeUInt16BE(0xfff0, 4);
  bad.writeUInt16BE(2, 6);
  bad.writeUInt16BE(0xffff, 8);
  bad.writeUInt16BE(0xffff, 10);
  const own = tables.map((t) => ({ tag: t.tag, data: font.subarray(t.offset, t.offset + t.length) }));
  const entries = after ? [...own, { tag: 'fvar', data: bad }] : [{ tag: 'fvar', data: bad }, ...own];
  entries.sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  const n = entries.length;
  const dir = Buffer.alloc(12 + 16 * n);
  dir.writeUInt32BE(sfntVersion, 0);
  dir.writeUInt16BE(n, 4);
  const parts = [dir];
  let at = dir.length;
  entries.forEach((t, i) => {
    dir.write(t.tag, 12 + 16 * i, 4, 'latin1');
    dir.writeUInt32BE(at, 12 + 16 * i + 8);
    dir.writeUInt32BE(t.data.length, 12 + 16 * i + 12);
    const pad = (4 - (t.data.length % 4)) % 4;
    parts.push(Buffer.from(t.data), Buffer.alloc(pad));
    at += t.data.length + pad;
  });
  return Buffer.concat(parts);
}

// slick with an SVG table whose one document is gzip that inflates past the 64 MiB a document may take.
function gzipBomb() {
  const doc = zlib.gzipSync(Buffer.alloc(80 * 1024 * 1024, 0x20), { level: 9 });
  const head = Buffer.alloc(10 + 2 + 12);
  head.writeUInt16BE(0, 0);
  head.writeUInt32BE(10, 2);
  head.writeUInt16BE(1, 10);
  head.writeUInt16BE(3, 12);
  head.writeUInt16BE(3, 14);
  head.writeUInt32BE(14, 16);
  head.writeUInt32BE(doc.length, 20);
  return withTable(readFixture('samples/slick.ttf'), 'SVG ', Buffer.concat([head, doc]));
}

module.exports = {
  id: 'N6', title: 'fail closed', needsEngine: true,
  async run(ctx) {
    const vf = readFixture(OPENSANS_VF);
    const slick = readFixture('samples/slick.ttf');
    const info = [
      ['an empty file', Buffer.alloc(0), 'input-empty'],
      ['64 random bytes', Buffer.from(Array.from({ length: 64 }, (_, i) => (i * 37 + 11) & 0xff)), 'not-a-font'],
      ['a WOFF file', readFixture('generated/fonttools-wrapped/real/var-ttf/OpenSans-VF.ttf.woff'), 'not-a-font'],
      ['a collection', readFixture('generated/structure/synthetic.ttc'), 'collection'],
      ['a directory past the end of the file', vf.subarray(0, 200), 'sfnt-invalid'],
      ['an fvar cut to 20 bytes', truncatedTable(vf, 'fvar', 20), 'sfnt-invalid'],
      ['a name table cut inside its records', truncatedTable(vf, 'name', 30), 'sfnt-invalid'],
      ['two fvar records', secondFvar(vf), 'sfnt-invalid'],
      ['two fvar records, the bad one second', secondFvar(vf, true), 'sfnt-invalid'],
    ];
    for (const [what, font, id] of info) {
      const r = await ctx.eng.run(['info', inp('font')], { inputs: { font } });
      ctx.rep.check(`info on ${what}: exit 1, ${id}`, cleanFailure(r, id), describe(r));
    }
    const instance = [
      ['a static font', slick, 'wght=400', 'not-variable'],
      ['an axis the font lacks', vf, 'wght=400,wdth=100,slnt=0', 'axis-unknown'],
      ['an axis left unpinned', vf, 'wght=400', 'axis-missing'],
      ['wght 900, past its 800', vf, 'wght=900,wdth=100', 'axis-out-of-range'],
      ['wdth 74.99, below its 75', vf, 'wght=400,wdth=74.99', 'axis-out-of-range'],
      ['an fvar cut to 20 bytes', truncatedTable(vf, 'fvar', 20), 'wght=400,wdth=100', 'sfnt-invalid'],
      ['two fvar records, the first past its table', secondFvar(vf), 'wght=400,wdth=100', 'sfnt-invalid'],
      ['two fvar records, the second past its table', secondFvar(vf, true), 'wght=400,wdth=100', 'sfnt-invalid'],
    ];
    for (const [what, font, at, id] of instance) {
      const r = await ctx.eng.run(['instance', '--at', at, inp('font'), OUT], { inputs: { font }, stale: STALE,
        checkInputs: true });
      ctx.rep.check(`instance of ${what}: exit 1, ${id}, no output, the input untouched`, cleanFailure(r, id) &&
        r.inputsAfter.font && r.inputsAfter.font.equals(font), describe(r));
    }
    // Two of the mutation sweep's findings (2026-11-19), planted with their bytes: OS/2 sxHeight 32767 and
    // sCapHeight -1, which the instancer's MVAR delta pushes past 16 bits (HarfBuzz converted the float out of range:
    // undefined behaviour, harfbuzz-wasm patch 1); and the CFF2 tag overwritten, so --downgrade-cff2 finds no CFF2.
    const ss = readFixture('real/sourcesans-vf/SourceSans3VF-Upright.otf');
    const os2 = Buffer.from(ss);
    os2.writeUInt32BE(0x7fffffff, readSfnt(ss).tables.find((x) => x.tag === 'OS/2').offset + 86);
    const o = await ctx.eng.run(['instance', '--downgrade-cff2', '--at', 'wght=650', inp('font'), OUT],
      { inputs: { font: os2 }, stale: STALE });
    ctx.rep.check('instance of SourceSans3VF with sxHeight 32767 (past 16 bits after its MVAR delta): exit 1, ' +
      'instance-failed, no undefined behaviour', cleanFailure(o, 'instance-failed'), describe(o));
    const tag = Buffer.from(ss);
    tag.writeUInt32BE(0x00000001, 12 + 16 * readSfnt(ss).tables.findIndex((x) => x.tag === 'CFF2'));
    const t2 = await ctx.eng.run(['instance', '--downgrade-cff2', '--at', 'wght=650', inp('font'), OUT],
      { inputs: { font: tag }, stale: STALE });
    ctx.rep.check('instance --downgrade-cff2 of a font whose CFF2 tag is overwritten: exit 1, instance-failed (the ' +
      'font, not the command line)', cleanFailure(t2, 'instance-failed'), describe(t2));
    const named = await ctx.eng.run(['instance', '--named', '3', '--at', 'wght=400,wdth=100', inp('font'), OUT],
      { inputs: { font: vf }, stale: STALE });
    ctx.rep.check('instance --named 3 at OpenSans-VF\'s Regular (named instance 1): named-mismatch',
      cleanFailure(named, 'named-mismatch'), describe(named));
    // A damaged COLR: its layer records said to start past the table.
    const twemoji = readFixture('real/twemoji/Twemoji.Mozilla.ttf');
    const t = readSfnt(twemoji).tables.find((x) => x.tag === 'COLR');
    const colr = Buffer.from(twemoji.subarray(t.offset, t.offset + t.length));
    colr.writeUInt32BE(t.length + 1000, 8);
    const damaged = withTable(twemoji, 'COLR', colr);
    const map = Buffer.from(JSON.stringify({ v: 1, keyedBy: 'gid', sourceGlyphs: 13723, outputGlyphs: 13723,
      map: Array.from({ length: 13723 }, (_, g) => g) }));
    const d = await ctx.eng.run(['transplant', inp('src'), inp('outline'), inp('map'), OUT],
      { inputs: { src: damaged, outline: twemoji, map }, stale: STALE });
    ctx.rep.check('transplant from a COLR whose layers lie past the table: exit 1, no output', cleanFailure(d),
      describe(d));
    const bomb = gzipBomb();
    const slickMap = Buffer.from(JSON.stringify({ v: 1, keyedBy: 'gid', sourceGlyphs: 7, outputGlyphs: 7,
      map: [0, 1, 2, 3, 4, 5, 6] }));
    const b = await ctx.eng.run(['transplant', inp('src'), inp('outline'), inp('map'), OUT],
      { inputs: { src: bomb, outline: slick, map: slickMap }, stale: STALE });
    ctx.rep.check(`transplant from an SVG document that inflates to 80 MiB (${bomb.length} bytes gzip): svg-invalid, ` +
      'bounded', cleanFailure(b, 'svg-invalid') && (ctx.kind !== 'wasm' || b.heap < 512 * 1048576),
    `${describe(b)}; heap ${b.heap}`);
    const noColour = await ctx.eng.run(['transplant', inp('src'), inp('outline'), inp('map'), OUT],
      { inputs: { src: slick, outline: slick, map: slickMap }, stale: STALE });
    ctx.rep.check('transplant from a font without colour: no-colour', cleanFailure(noColour, 'no-colour'),
      describe(noColour));
  },
};
