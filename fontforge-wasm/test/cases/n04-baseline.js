'use strict';
// N4: every entry's score against its source is no worse than its baseline (P2-15); improvements are P8's, through
// make-oracle.mjs --rebaseline after review.

const oracle = require('../lib/oracle');

module.exports = {
  id: 'N4', title: 'baseline against the source', needsEngine: false,
  async run(ctx) {
    const recorded = oracle.ffconvOracle();
    if (!recorded) {
      ctx.rep.fail('ffconv-oracle.json', 'no ffconv-oracle.json');
      return;
    }
    let n = 0;
    for (const o of oracle.opTable()) {
      if (!ctx.keep(o.fid)) continue;
      n++;
      const e = recorded.outputs[o.key];
      const v = e && e.score_source ? oracle.baselineViolations(e, o) : ['no entry or no score'];
      ctx.rep.check(`${o.key} no worse than its baseline`, v.length === 0, v.join('; '));
    }
    ctx.count('entries with a baseline', n, oracle.PINNED.entries);
  },
};
