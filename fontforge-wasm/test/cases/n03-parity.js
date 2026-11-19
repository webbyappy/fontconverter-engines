'use strict';
// N3: parity with production (P2-14): the recorded scorer and parity_diff verdicts against the twin meet the rule,
// the named exceptions are exactly the pinned set, and live rows compare our output with production's file directly.

const { readFixture } = require('../lib/fixtures');
const { os2FirstLast } = require('../lib/sfnt');
const svg = require('../lib/svgfont');
const { convertOp } = require('../lib/convert');
const oracle = require('../lib/oracle');

const ALIASES = 'generated/aliases/';

module.exports = {
  id: 'N3', title: 'parity with production', needsEngine: true,
  async run(ctx) {
    const recorded = oracle.ffconvOracle();
    if (!recorded) ctx.rep.fail('ffconv-oracle.json', 'no ffconv-oracle.json: the recorded rows cannot run');
    let n = 0;
    for (const o of oracle.opTable().filter((x) => x.twin)) {
      if (!ctx.keep(o.fid)) continue;
      n++;
      const refs = oracle.twinRefs(o);
      const ref = refs[refs.reference];
      const r = await convertOp(ctx, o);
      if (!ref || !r.out) {
        ctx.rep.fail(`${o.key} live`, ref ? 'no output' : 'no twin output');
      } else if (o.target === 'svg') {
        const ours = r.out.toString('utf8');
        const theirs = readFixture(ref.rel).toString('utf8');
        const repeated = svg.newRepeats(ours, theirs);
        ctx.rep.check(`${o.key} repeats no glyph element more often than production`, !repeated.length,
          repeated.slice(0, 3).join(' | '));
        if (o.fid.startsWith(ALIASES)) {
          // Nothing production writes is lost (P2-25: a lone selector may become base + selector); what ours adds is
          // judged by the recorded parity classes, which name only additions the source backs.
          const lost = svg.lostFrom(ours, theirs);
          const k = svg.sameMultiset(svg.kerns(ours).map((e) => svg.signature(e)), svg.kerns(theirs).map((e) => svg.signature(e)));
          ctx.rep.check(`${o.key} keeps every glyph element production writes, and its kerning`, !lost.length && k,
            `lost ${lost.length}: ${lost.slice(0, 3).join(' | ')}; kerning equal ${k}`);
        }
      } else {
        const a = os2FirstLast(r.out);
        const b = os2FirstLast(readFixture(ref.rel));
        ctx.rep.check(`${o.key} OS/2 first and last character as production`, JSON.stringify(a) === JSON.stringify(b),
          `ours ${a}, production ${b}`);
      }
      if (!recorded) continue;
      const e = recorded.outputs[o.key];
      const v = e ? oracle.twinViolations(o, e) : ['no oracle entry'];
      ctx.rep.check(`${o.key} meets the parity rule against ${refs.reference}`, v.length === 0, v.join('; '));
    }
    ctx.count('twin-judged entries', n, oracle.PINNED.twinJudged);
    if (recorded) {
      const used = Object.keys(recorded.parity.exceptions || {}).sort();
      ctx.rep.check('the named exceptions are exactly the pinned set',
        JSON.stringify(used) === JSON.stringify(Object.keys(oracle.EXCEPTIONS).sort()), used.join(', '));
      ctx.rep.check('the reference for twins that differ is amd64', recorded.parity.reference_when_twins_differ === 'amd64');
    }
  },
};
