'use strict';
// N10: one instance serves 140 calls with the first round's bytes and a stable heap; file names with spaces, '#',
// upper case and non-ASCII letters work through argv, MEMFS and NODEFS.

const { fontOracle, fx, readFixture, sha256 } = require('../lib/fixtures');
const { IN, OUT } = require('../lib/engine');
const { extOf } = require('../lib/oracle');
const { cleanFailure, describe, success } = require('../lib/checks');

const ROUNDS = 20;
const NAMES = ['OpenSans-Regular.TTF', 'Open Sans Regular.ttf', '프메2.ttf', 'Μ.otf', 'font #1.ttf'];

async function reuse(ctx) {
  if (ctx.kind !== 'wasm') {
    ctx.rep.notApplicable('140 calls on one instance', 'each native run is its own process');
    return;
  }
  const inst = await ctx.eng.instance();
  const src = readFixture('samples/slick.ttf');
  let first = null;
  let heapAfterFirst = null;
  let problem = null;
  let calls = 0;
  for (let round = 0; round < ROUNDS && !problem; round++) {
    const run = async (args, input, outName) => { calls++; return ctx.eng.run(args, { input, outName, instance: inst }); };
    const w = await run(['woff-encode', IN, OUT], src, 'a.woff');
    const wd = await run(['woff-decode', IN, OUT], w.out, 'a.ttf');
    const w2 = await run(['woff2-encode', '--quality=11', IN, OUT], src, 'a.woff2');
    const w2d = await run(['woff2-decode', IN, OUT], w2.out, 'b.ttf');
    const e = await run(['eot-encode', IN, OUT], src, 'a.eot');
    const ed = await run(['eot-decode', IN, OUT], e.out, 'c.ttf');
    const bad = await run(['woff-decode', IN, OUT], src, 'd.ttf');
    const results = [w, wd, w2, w2d, e, ed];
    if (!results.every((r) => success(r)) || !cleanFailure(bad)) { problem = `round ${round}: a call failed`; break; }
    const hashes = results.map((r) => sha256(r.out)).join(',');
    if (first === null) { first = hashes; heapAfterFirst = inst.M.heapBytes(); }
    else if (hashes !== first) problem = `round ${round}: different bytes`;
  }
  ctx.rep.check(`${ROUNDS * 7} calls on one instance give round 1's bytes`, !problem && calls === ROUNDS * 7, problem);
  ctx.rep.check('the heap after round 20 equals the heap after round 1', inst.M.heapBytes() === heapAfterFirst,
    `${heapAfterFirst} then ${inst.M.heapBytes()}`);
}

async function names(ctx) {
  const fo = fontOracle().fixtures;
  let n = 0;
  for (const name of NAMES) {
    const id = `generated/names/${name}`;
    if (!ctx.keep(id)) continue;
    n++;
    const src = readFixture(id);
    const stem = name.replace(/\.[^.]+$/, '');
    const e = await ctx.eng.run(['woff-encode', IN, OUT], { input: ctx.kind === 'wasm' ? src : { path: fx(id) },
      inName: name, outName: `${stem}.woff` });
    const d = success(e) ? await ctx.eng.run(['woff-decode', IN, OUT], { input: e.out, inName: `${stem}.woff`,
      outName: `${stem}.${extOf(fo[id].flavour)}` }) : e;
    ctx.rep.check(`argv and paths named ${name}`, success(d) && d.out.equals(src), describe(d));
    if (ctx.kind === 'wasm') {
      const { M } = await ctx.eng.instance();
      M.FS.mkdir('/names');
      M.FS.mount(M.NODEFS, { root: fx('generated/names') }, '/names');
      let code = null;
      try { code = M.callMain(['woff-encode', `/names/${name}`, `/out/${stem}.woff`]); } catch (err) { code = String(err); }
      process.exitCode = 0;
      const ok = code === 0 && M.FS.analyzePath(`/out/${stem}.woff`).exists;
      M.FS.unmount('/names');
      ctx.rep.check(`NODEFS input named ${name}`, ok, `exit ${code}`);
    }
  }
  ctx.count('names', n, 5);
}

module.exports = {
  id: 'N10', title: 'reuse and names', needsEngine: true,
  async run(ctx) {
    await reuse(ctx);
    await names(ctx);
  },
};
