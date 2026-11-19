'use strict';
// N6: EOT. fontwrap's EOT is the file lib/sfnt.js predicts (sfntly's header, proven by N0; the input as payload);
// plain and XOR files are decoded by fontwrap's own code, MTX files by libeot (P1 plan, P1-4, P1-15).

const { fontOracle, fx, readFixture } = require('../lib/fixtures');
const { IN, OUT } = require('../lib/engine');
const { encodeSet, eotFixtures, extOf } = require('../lib/oracle');
const { eotPayload, predictEot, readEotHeader } = require('../lib/sfnt');
const { adjustmentOk, cleanFailure, describe, fontProblems, success, tablesByTag } = require('../lib/checks');

const STALE = Buffer.from('stale');
const COLR_MTX = 'generated/eot/Noto-COLRv1.mtx.eot';
const HDMX_MTX = 'generated/eot/with-hdmx.mtx.eot';
// The only signal of the drop: libeot's own stderr line (unprefixed; exit 0). Pinned so a change is "limit changed".
const LIBEOT_HDMX_LINE = 'Ignoring hdmx/VDMX table -- will be fixed in a future release.';
const DERIVED_SOURCE = { 'derived/OpenSans-Regular.eot': 'samples/OpenSans-Regular.ttf', 'derived/slick.eot': 'samples/slick.ttf' };

async function encodeEot(ctx, id, extra = []) {
  return ctx.eng.run(['eot-encode', ...extra, IN, OUT], { input: { path: fx(id) }, inName: 'in.font', outName: 'out.eot',
    stale: STALE });
}

async function decodeEot(ctx, input) {
  return ctx.eng.run(['eot-decode', IN, OUT], { input, inName: 'in.eot', outName: 'out.ttf', stale: STALE });
}

async function ownEots(ctx, fo) {
  let n = 0;
  for (const id of encodeSet().filter((i) => extOf(fo[i].flavour) === 'ttf' && ctx.keep(i))) {
    n++;
    const src = readFixture(id);
    const e = await encodeEot(ctx, id);
    if (!ctx.rep.check(`eot-encode ${id}`, success(e), describe(e))) continue;
    const want = predictEot(src);
    let at = 0;
    while (at < want.length && want[at] === e.out[at]) at++;
    ctx.rep.check(`the EOT is the predicted file: ${id}`, e.out.equals(want), `first difference at byte ${at}`);
    const d = await decodeEot(ctx, e.out);
    ctx.rep.check(`eot-decode returns the input bit for bit: ${id}`, success(d) && d.json.decoder === 'fontwrap' &&
      d.json.compression === 'none' && d.out.equals(src), describe(d));
  }
  ctx.count('TrueType fonts of the encode set', n, 23); // +3 real fonts in P3b
}

async function plainAndXor(ctx, fo) {
  let n = 0;
  for (const id of [...eotFixtures('none'), ...eotFixtures('xor')].filter(ctx.keep)) {
    n++;
    const fixture = readFixture(id);
    const compression = fo[id].eot.compression;
    const d = await decodeEot(ctx, { path: fx(id) });
    ctx.rep.check(`eot-decode ${id} gives the payload sliced independently`, success(d) &&
      d.json.decoder === 'fontwrap' && d.json.compression === compression && d.out.equals(eotPayload(fixture)), describe(d));
    const srcId = fo[id].source || DERIVED_SOURCE[id];
    if (compression === 'none' && srcId) {
      const e = await encodeEot(ctx, srcId);
      const off = readEotHeader(fixture).fontDataOffset;
      const same = Boolean(e.out) && e.out.length === fixture.length && e.out.subarray(0, off).equals(fixture.subarray(0, off));
      const whose = id.startsWith('derived/') ? "production's" : "sfntly's";
      ctx.rep.check(`our header equals ${whose}: ${id}`, same, describe(e));
      if (id.startsWith('derived/')) {
        const p = fontProblems(readFixture(srcId), d.out || Buffer.alloc(0));
        ctx.rep.check(`production's EOT decodes to the input's tables: ${id}`, p.length === 0, p.join('; '));
      }
    }
  }
  ctx.count('plain and XOR EOT fixtures', n, 13);
}

async function mtx(ctx, fo) {
  let n = 0;
  for (const id of eotFixtures('mtx').filter(ctx.keep)) {
    n++;
    if (id === COLR_MTX && ctx.kind === 'wasm') {
      // libeot reserves 2,789 MiB for this font; under the 1 GiB ceiling with ABORTING_MALLOC the instance aborts
      // as out of memory (fontconverter-web P3b plan, P3b-5 and P3b-6: an accepted breach), no output.
      const inst = await ctx.eng.instance();
      const d = await ctx.eng.run(['eot-decode', IN, OUT], { input: { path: fx(id) }, inName: 'in.eot',
        outName: 'out.ttf', instance: inst });
      ctx.rep.check(`${id} aborts as out of memory under the 1 GiB ceiling (libeot reserves 2,789 MiB)`,
        d.threw !== null && typeof inst.M.lastAbort === 'function' && inst.M.lastAbort() === 'oom' && !d.outExists,
        describe(d));
      continue;
    }
    const d = await decodeEot(ctx, { path: fx(id) });
    if (!ctx.rep.check(`eot-decode ${id}`, success(d) && d.json.decoder === 'libeot' && d.json.compression === 'mtx',
      describe(d))) continue;
    const src = readFixture(fo[id].expected_font_from);
    const dropped = id === HDMX_MTX ? ['hdmx'] : []; // with-hdmx.ttf has no VDMX
    const p = fontProblems(src, d.out, { rebuilt: true, locFormat: true, normalizePushes: true, dropped });
    if (!adjustmentOk(d.out)) p.push('head.checkSumAdjustment wrong for the decoded file');
    if (id === HDMX_MTX) {
      ctx.rep.knownLimit(`${id} loses hdmx (libeot parseCTF), all else equal`,
        p.length === 0 && !tablesByTag(d.out).has('hdmx') && d.stderr.includes(LIBEOT_HDMX_LINE),
        `${p.join('; ')}; stderr ${JSON.stringify(d.stderr)}`);
    } else {
      ctx.rep.check(`MTX decodes to the source font: ${id}`, p.length === 0, p.slice(0, 4).join('; '));
    }
  }
  ctx.count('MTX fixtures', n, 7);
}

async function cff(ctx, fo) {
  let n = 0;
  for (const id of encodeSet().filter((i) => extOf(fo[i].flavour) === 'otf' && ctx.keep(i))) {
    n++;
    const r = await encodeEot(ctx, id);
    ctx.rep.check(`CFF refused without --allow-cff: ${id}`, cleanFailure(r, /CFF/), describe(r));
    const e = await encodeEot(ctx, id, ['--allow-cff']);
    if (!ctx.rep.check(`eot-encode --allow-cff ${id}`, success(e), describe(e))) continue;
    const d = await decodeEot(ctx, e.out);
    ctx.rep.check(`--allow-cff round trip is bit-identical: ${id}`, success(d) && d.json.ext === 'otf' &&
      d.out.equals(readFixture(id)), describe(d));
  }
  ctx.count('CFF fonts of the encode set', n, 7);
}

module.exports = {
  id: 'N6', title: 'EOT', needsEngine: true,
  async run(ctx) {
    const fo = fontOracle().fixtures;
    await ownEots(ctx, fo);
    await plainAndXor(ctx, fo);
    await mtx(ctx, fo);
    await cff(ctx, fo);
  },
};
