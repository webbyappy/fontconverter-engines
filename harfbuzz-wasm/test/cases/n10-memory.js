'use strict';
// N10: memory (P3b plan, P3b-5 and P3b-6): the 1 GiB ceiling aborts with lastAbort() "oom" and a fresh instance then
// works; the peaks of info, instance and transplant on the band-top fixtures, each within 1 GiB with 25 % room
// (768 MiB), info's at most three times its input (P3b-13: a metadata-only step).

const fs = require('fs');
const { readFixture } = require('../lib/fixtures');
const { OUT, inp } = require('../lib/engine');
const { describe, success } = require('../lib/checks');
const { fontforge } = require('../lib/ffconv');

const CEILING_BYTES = 1073741824;
const ROOM_BYTES = 768 * 1048576; // 1 GiB with 25 % room (P3b-6)
const BAND_TOP = 'generated/large/NotoSansSC-VF-31mib.ttf';
// The largest colour source with a transplant, 17.3 MiB of sbix images (Noto-COLRv1, 4.76 MiB, has none since ffconv
// refuses FontForge's over-long charstring; the app gives sbix no otf, so this bounds hbfont's transplant, not a route).
const COLOUR_TOP = 'real/color-sbix/BungeeColor-Regular_sbix_MacOS.ttf';
const MIB = (b) => `${(b / 1048576).toFixed(0)} MiB`;

module.exports = {
  id: 'N10', title: 'memory', needsEngine: true,
  async run(ctx) {
    if (ctx.kind !== 'wasm') {
      const r = await ctx.eng.run(['selftest-oom']);
      ctx.rep.check('selftest-oom refuses natively (no ceiling to reach)', r.code === 2, describe(r));
      ctx.rep.notApplicable('the ceiling and the peaks', 'native binaries have no wasm memory');
      return;
    }
    const glue = fs.readFileSync(ctx.eng.gluePath, 'latin1');
    ctx.rep.check('the glue caps memory at 1 GiB and aborts when it cannot grow (ABORTING_MALLOC)',
      glue.includes(String(CEILING_BYTES)) && !glue.includes('2147483648') && glue.includes('abortOnCannotGrowMemory'));
    const oom = await ctx.eng.run(['selftest-oom']);
    ctx.rep.check('selftest-oom aborts at the ceiling: lastAbort() is "oom"', oom.threw !== null &&
      oom.M.lastAbort() === 'oom' && oom.heap <= CEILING_BYTES && oom.heap > CEILING_BYTES - 64 * 1048576,
    `${describe(oom)}; heap ${oom.heap}`);
    const vf = readFixture('real/var-ttf/OpenSans-VF.ttf');
    const next = await ctx.eng.run(['instance', '--at', 'wght=700,wdth=75', inp('font'), OUT], { inputs: { font: vf } });
    ctx.rep.check('a fresh instance after the abort instances OpenSans-VF', success(next) && next.M.lastAbort() === null,
      describe(next));

    const big = readFixture(BAND_TOP);
    const info = await ctx.eng.run(['info', inp('font')], { inputs: { font: big } });
    ctx.rep.check(`info on ${BAND_TOP} (${MIB(big.length)}): peak ${MIB(info.heap)}, at most 3 times the input`,
      success(info, true) && info.heap <= 3 * big.length && info.heap <= ROOM_BYTES, describe(info));
    const inst = await ctx.eng.run(['instance', '--at', 'wght=400', inp('font'), OUT], { inputs: { font: big } });
    ctx.rep.check(`instance of ${BAND_TOP} at wght 400: peak ${MIB(inst.heap)}, within 768 MiB`,
      success(inst) && inst.heap <= ROOM_BYTES, describe(inst));
    const colour = readFixture(COLOUR_TOP);
    const ff = await fontforge(colour, 'input.ttf', 'otf');
    const tr = await ctx.eng.run(['transplant', inp('src'), inp('outline'), inp('map'), OUT],
      { inputs: { src: colour, outline: ff.font, map: ff.map } });
    ctx.rep.check(`transplant of ${COLOUR_TOP} into FontForge's otf: peak ${MIB(tr.heap)}, within 768 MiB`,
      success(tr) && tr.heap <= ROOM_BYTES, describe(tr));
  },
};
