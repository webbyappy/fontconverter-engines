'use strict';
// N2: every op-table entry converts under the contract, as recorded, and its source verdicts meet the gate.

const { fontOracle, sha256 } = require('../lib/fixtures');
const { success } = require('../lib/checks');
const { convertOp } = require('../lib/convert');
const oracle = require('../lib/oracle');

// Native and wasm agree byte for byte (P2-16; both builds sort ties as glibc does since the stable qsort).

module.exports = {
  id: 'N2', title: 'the site\'s pairs', needsEngine: true,
  async run(ctx) {
    const fixtures = fontOracle().fixtures;
    const recorded = oracle.ffconvOracle();
    if (!recorded) ctx.rep.fail('ffconv-oracle.json', 'no ffconv-oracle.json: sha256 and verdict rows cannot run');
    let n = 0;
    for (const o of oracle.opTable()) {
      if (!ctx.keep(o.fid)) continue;
      n++;
      const r = await convertOp(ctx, o);
      const s = success(r, o.target);
      const f = fixtures[o.fid];
      const want = f.kind === 'svg' ? { kind: 'svg', flavor: null, numGlyphs: null }
        : { kind: 'sfnt', flavor: f.flavour, numGlyphs: f.font.numGlyphs };
      const got = r.json && r.json.input;
      ctx.rep.check(`${o.key} converts`, s.ok && JSON.stringify(got) === JSON.stringify(want) &&
        r.outDir.length === 1 && r.outDir[0] === o.outName,
      `${s.why} input ${JSON.stringify(got)} want ${JSON.stringify(want)} out/ ${JSON.stringify(r.outDir)}`);
      if (!recorded) continue;
      const e = recorded.outputs[o.key];
      if (!e) { ctx.rep.fail(`${o.key} recorded`, 'no oracle entry'); continue; }
      const same = r.out && sha256(r.out) === e.file.sha256;
      ctx.rep.check(`${o.key} gives the recorded bytes`, Boolean(same), r.out ? `sha256 ${sha256(r.out)}` : 'no output');
      const v = oracle.sourceViolations(e, o);
      ctx.rep.check(`${o.key} source verdicts meet the gate`, v.length === 0, v.join('; '));
    }
    ctx.count('op-table entries converted', n, oracle.PINNED.entries);
  },
};
