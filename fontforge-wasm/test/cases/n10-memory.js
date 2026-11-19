'use strict';
// N10: memory, time and instances: malformed GDEF tables read inside their allocations (fontforge-0007), GPOS device
// tables kept for their own pairs and glyphs (fontforge-0009), a 5 MiB CJK font within 1 GiB of wasm memory, a fresh
// instance in under 10 ms, one conversion per instance (P2-6).

const { fx, readFixture } = require('../lib/fixtures');
const { IN, OUT } = require('../lib/engine');
const { cleanFailure, describe, success, usageFailure } = require('../lib/checks');
const { gposDeviceMap, gposLookupTypes, readSfnt, table } = require('../lib/sfnt');

const LARGE = 'generated/large/NotoSansCJKjp-cid-5mib.otf';
const LAYOUT = 'generated/layout/slick-gpos-devices.ttf'; // fontforge-0009's fixture (web repo 7d28e31)
const MAX_HEAP_BYTES = 1024 * 1024 * 1024; // 1 GiB (roadmap N10)
const MAX_INSTANCE_MS = 10; // ms, median of fresh instances (roadmap N10)
const INSTANCES = 20;

function expect(cond, what) {
  if (!cond) throw new Error(`fixture changed: ${what}`);
}

// fontforge-0007: three malformed GDEF tables, each made in memory from a fixture by changing a few bytes (nothing is
// written to the drive). FontForge 20230101 wrote or read past an allocation on each: a format-1 ClassDef that starts
// past the last glyph (its count wrapped; the reader also serves GSUB and GPOS class definitions), a MarkGlyphSets
// table with no set (a pointer written into malloc(0)), a LigCaretList that counts more glyphs than its coverage
// holds (the coverage array read past its end).
function malformedGdef() {
  const make = (rel, edit) => {
    const b = Buffer.from(readFixture(rel));
    const t = readSfnt(b).tables.find((x) => x.tag === 'GDEF');
    expect(t, `${rel} has a GDEF`);
    edit(b, t.offset, table(b, 'maxp').readUInt16BE(4));
    return b;
  };
  return [
    ['a GlyphClassDef (format 1) that starts past the last glyph', make('samples/slick.ttf', (b, g, glyphs) => {
      const cd = g + b.readUInt16BE(g + 4);
      expect(b.readUInt16BE(g + 4) && b.readUInt16BE(cd) === 2 && b.readUInt16BE(cd + 2) >= 1,
        'slick.ttf: a format-2 GlyphClassDef with a range');
      b.writeUInt16BE(1, cd); // format 1
      b.writeUInt16BE(glyphs + 1, cd + 2); // startGlyphID: past the last glyph id (glyphs - 1) by two
      b.writeUInt16BE(1, cd + 4); // glyphCount
    })],
    ['a MarkGlyphSets table with no set', make('real/inter/Inter-Regular.ttf', (b, g) => {
      const ms = g + b.readUInt16BE(g + 12);
      expect(b.readUInt32BE(g) === 0x00010002 && b.readUInt16BE(g + 12) && b.readUInt16BE(ms) === 1 &&
        b.readUInt16BE(ms + 2) > 0, 'Inter-Regular.ttf: GDEF 1.2 with mark glyph sets');
      b.writeUInt16BE(0, ms + 2); // markGlyphSetCount
    })],
    ['a LigCaretList that counts more glyphs than its coverage', make('samples/slick.ttf', (b, g) => {
      const lc = g + b.readUInt16BE(g + 8);
      const cov = lc + b.readUInt16BE(lc);
      expect(b.readUInt16BE(g + 8) && b.readUInt16BE(lc + 2) === 0 && b.readUInt16BE(cov) === 2 &&
        b.readUInt16BE(cov + 2) === 0, 'slick.ttf: an empty LigCaretList with a format-2 coverage');
      b.writeUInt16BE(1, cov); // the same empty coverage as format 1 (0 glyphs), so its array holds the end mark only
      b.writeUInt16BE(2, lc + 2); // ligGlyphCount
    })],
  ];
}

module.exports = {
  id: 'N10', title: 'memory, time, instances', needsEngine: true,
  async run(ctx) {
    const bad = malformedGdef();
    for (const [what, bytes] of bad) {
      const m = await ctx.eng.run(['convert', IN, OUT], { input: bytes, inName: 'input.ttf', outName: 'output.otf' });
      const reports = (m.sanitizer || []).filter((l) => /AddressSanitizer|parsettfatt\.c.*runtime error/.test(l));
      // Native: no AddressSanitizer report, and no UBSan report from parsettfatt.c (valid fonts carry C1's known
      // mem.c shift reports, which are not this case's).
      ctx.rep.check(`${what}: converts or fails closed${ctx.kind === 'wasm' ? '' :
        ', with no AddressSanitizer report and no UBSan report in parsettfatt.c'}`,
        (success(m, 'otf').ok || cleanFailure(m).ok) && !reports.length,
        `${describe(m)}${reports.length ? ' | ' + reports.slice(0, 2).join(' | ') : ''}`);
    }
    ctx.count('malformed GDEF tables', bad.length, 3);

    // fontforge-0009 (both builds): GPOS hinting device tables survive ttf -> otf, each for its own pair or glyph,
    // read and written at OpenType's bases (a PairPosFormat1's device offsets count from its PairSet; FontForge counted
    // from the subtable), and single positioning writes each glyph's own tables (FontForge wrote the first glyph's for
    // every glyph, through a NULL pointer when the first glyph had none).
    const layout = readFixture(LAYOUT);
    const srcDevices = gposDeviceMap(layout);
    const lay = await ctx.eng.run(['convert', IN, OUT], { input: layout, inName: 'input.ttf', outName: 'output.otf' });
    const ourDevices = lay.out ? gposDeviceMap(lay.out) : new Map();
    const diff = [...new Set([...srcDevices.keys(), ...ourDevices.keys()])].sort()
      .filter((k) => JSON.stringify(srcDevices.get(k)) !== JSON.stringify(ourDevices.get(k)))
      .map((k) => `${k}: source ${JSON.stringify(srcDevices.get(k) || null)}, ours ${JSON.stringify(ourDevices.get(k) || null)}`);
    const layReports = (lay.sanitizer || []).filter((l) => /AddressSanitizer|(tottfgpos|parsettfatt)\.c.*runtime error/.test(l));
    ctx.rep.check(`${LAYOUT} -> otf keeps its ${srcDevices.size} GPOS device tables, each for its own pair or glyph` +
      (ctx.kind === 'wasm' ? '' : ', with no AddressSanitizer report'), srcDevices.size === 12 &&
      success(lay, 'otf').ok && diff.length === 0 && !layReports.length,
    `${describe(lay)}; ${diff.length} differ: ${diff.slice(0, 3).join(' | ')}` +
      (layReports.length ? ` | ${layReports.slice(0, 3).join(' | ')}` : ''));

    const r = await ctx.eng.run(['convert', IN, OUT], { input: { path: fx(LARGE) }, inName: 'input.otf',
      outName: 'output.ttf' });
    const heapOk = ctx.kind !== 'wasm' || r.heap <= MAX_HEAP_BYTES;
    // fontforge-0004 (both builds): the flattened CID font keeps its anchor classes, so its TTF keeps the source's
    // mark-positioning lookups (GPOS types 4-6), which FontForge used to drop.
    const marks = (buf) => gposLookupTypes(buf).filter((t) => t >= 4 && t <= 6).length;
    const want = marks(readFixture(LARGE));
    ctx.rep.check(`the 5 MiB CID font's TTF keeps the source's ${want} mark-positioning lookups`, Boolean(r.out) &&
      want > 0 && marks(r.out) === want, r.out ? `ours ${marks(r.out)}` : 'no output');
    ctx.rep.check(`a 5 MiB CJK font -> ttf (${Math.round(r.ms)} ms, heap ${r.heap ? Math.round(r.heap / 1048576) + ' MiB' : 'n/a'})`,
      success(r, 'ttf').ok && heapOk, describe(r));
    if (ctx.kind !== 'wasm') {
      // fontforge-0004: CIDFlatten moves the CID master's anchor classes too; before, the flattened glyphs' anchor
      // points kept pointers to classes freed with the master, and writing the TTF wrote into freed memory.
      const asan = (r.sanitizer || []).filter((l) => /AddressSanitizer/.test(l));
      ctx.rep.check('the 5 MiB CID font converts with no AddressSanitizer report', success(r, 'ttf').ok && !asan.length,
        asan.slice(0, 2).join(' | '));
      ctx.rep.notApplicable('instances', 'a native run is one process');
      return;
    }
    const times = [];
    for (let i = 0; i < INSTANCES; i++) {
      const t0 = performance.now();
      await ctx.eng.instance();
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const median = times[INSTANCES / 2];
    ctx.rep.check(`fresh-instance cost median under ${MAX_INSTANCE_MS} ms (${median.toFixed(2)} ms)`, median < MAX_INSTANCE_MS);
    const inst = await ctx.eng.instance();
    const first = await ctx.eng.run(['convert', IN, OUT], { input: readFixture('samples/slick.ttf'), inName: 'a.ttf',
      outName: 'a.otf', instance: inst });
    const second = await ctx.eng.run(['convert', IN, OUT], { input: readFixture('samples/slick.ttf'), inName: 'b.ttf',
      outName: 'b.otf', instance: inst });
    ctx.rep.check('a second callMain on one instance exits 2', success(first, 'otf').ok && usageFailure(second).ok &&
      !second.outExists &&
      /one conversion per instance/.test(second.stderr.slice(-1)[0] || ''), `${describe(first)} / ${describe(second)}`);
  },
};
