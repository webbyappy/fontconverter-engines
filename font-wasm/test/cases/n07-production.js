'use strict';
// N7: production parity. fontwrap's WOFF2 of OpenSans-Regular.ttf is production's file byte for byte; production's
// WOFF of it decodes to the input's tables.

const { GOLDEN_OPENSANS_WOFF, fontOracle, fx, readFixture, sha256 } = require('../lib/fixtures');
const { IN, OUT } = require('../lib/engine');
const { describe, fontProblems, success } = require('../lib/checks');

const SOURCE = 'samples/OpenSans-Regular.ttf';

module.exports = {
  id: 'N7', title: 'production parity', needsEngine: true,
  async run(ctx) {
    const e = await ctx.eng.run(['woff2-encode', '--quality=11', IN, OUT], { input: { path: fx(SOURCE) },
      outName: 'out.woff2' });
    ctx.rep.check("WOFF2 of OpenSans-Regular.ttf equals production's (derived/OpenSans-Regular.woff2)",
      success(e) && e.out.equals(readFixture('derived/OpenSans-Regular.woff2')), describe(e));

    const twin = fontOracle().twin['arm64/samples/OpenSans-Regular.ttf/woff'];
    const rec = twin && twin.files[twin.requested_file];
    const golden = readFixture(GOLDEN_OPENSANS_WOFF);
    if (!ctx.rep.check("production's WOFF is the twin's (sha256 in font-oracle.json)", Boolean(rec) &&
      sha256(golden) === rec.sha256, rec ? `${sha256(golden)} vs ${rec.sha256}` : 'no twin record')) return;
    const d = await ctx.eng.run(['woff-decode', IN, OUT], { input: golden, inName: 'in.woff', outName: 'out.ttf' });
    const p = success(d) ? fontProblems(readFixture(SOURCE), d.out) : [describe(d)];
    ctx.rep.check("production's WOFF decodes to the input's tables", p.length === 0, p.join('; '));
  },
};
