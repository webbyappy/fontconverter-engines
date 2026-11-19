'use strict';
// N2: `hbfont info` (P3b plan, section 3.1 and P3b-13): flavour, glyph count, axes, named instances, STAT and colour
// tables of every fixture equal fontTools' reading (facts/info-facts.json, made by hand with facts/read_info_facts.py).

const fs = require('fs');
const path = require('path');
const { readFixture } = require('../lib/fixtures');
const { inp } = require('../lib/engine');
const { describe, success } = require('../lib/checks');

const FACTS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'facts', 'info-facts.json'), 'utf8'));
const FIXTURE_COUNT = 16;
const FIELDS = ['ok', 'command', 'flavor', 'numGlyphs', 'variable', 'colour'];

// Every difference between two JSON values, as "path: got vs want" lines.
function differences(got, want, at = '') {
  if (want === null || typeof want !== 'object') {
    return got === want ? [] : [`${at || '.'}: ${JSON.stringify(got)} vs ${JSON.stringify(want)}`];
  }
  if (got === null || typeof got !== 'object' || Array.isArray(got) !== Array.isArray(want)) {
    return [`${at || '.'}: ${JSON.stringify(got)} vs ${JSON.stringify(want)}`.slice(0, 200)];
  }
  const keys = new Set([...Object.keys(got), ...Object.keys(want)]);
  return [...keys].flatMap((k) => differences(got[k], want[k], `${at}.${k}`));
}

module.exports = {
  id: 'N2', title: 'info', needsEngine: true,
  async run(ctx) {
    const ids = Object.keys(FACTS.fixtures).filter(ctx.keep);
    ctx.count('fixtures read by fontTools', Object.keys(FACTS.fixtures).length, FIXTURE_COUNT);
    for (const id of ids) {
      const want = FACTS.fixtures[id];
      const r = await ctx.eng.run(['info', inp('font')], { inputs: { font: readFixture(id) } });
      if (!ctx.rep.check(`${id}: info prints one JSON line and writes nothing`, success(r, true) &&
        JSON.stringify(Object.keys(r.json).sort()) === JSON.stringify([...FIELDS].sort()), describe(r))) continue;
      const diffs = differences({ flavor: r.json.flavor, numGlyphs: r.json.numGlyphs, variable: r.json.variable,
        colour: r.json.colour }, want);
      ctx.rep.check(`${id}: equals ${FACTS.reader}'s reading`, diffs.length === 0, diffs.slice(0, 6).join('; '));
    }
  },
};
