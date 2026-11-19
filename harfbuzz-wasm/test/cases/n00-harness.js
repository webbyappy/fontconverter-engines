'use strict';
// N0: the harness checks itself before it judges the engine (P3b plan, section 4.1): its sfnt reader agrees with
// font-oracle.json's fontTools facts on every fixture the cases use, and refuses what is not an sfnt.

const fs = require('fs');
const path = require('path');
const { fontOracle, readFixture } = require('../lib/fixtures');
const { facts } = require('../lib/sfnt');

const INFO_FACTS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'facts', 'info-facts.json'), 'utf8'));

module.exports = {
  id: 'N0', title: 'the harness itself', needsEngine: false,
  async run(ctx) {
    const oracle = fontOracle().fixtures;
    const ids = Object.keys(INFO_FACTS.fixtures).filter(ctx.keep);
    for (const id of ids) {
      const want = oracle[id] && oracle[id].font;
      if (!ctx.rep.check(`${id}: font-oracle.json has its facts`, Boolean(want))) continue;
      const got = facts(readFixture(id));
      const tables = (t) => JSON.stringify(t.map((x) => [x.tag, x.length, x.checksum]));
      ctx.rep.check(`${id}: tables, lengths and checksums equal fontTools'`, tables(got.tables) === tables(want.tables),
        `${tables(got.tables).slice(0, 160)} vs ${tables(want.tables).slice(0, 160)}`);
      ctx.rep.check(`${id}: glyph count and special tables equal fontTools'`, got.numGlyphs === want.numGlyphs &&
        JSON.stringify(got.special) === JSON.stringify(want.special),
      `${got.numGlyphs} ${got.special} vs ${want.numGlyphs} ${want.special}`);
    }
    let threw = null;
    try { facts(Buffer.from('wOFF\0\0\0\0', 'latin1')); } catch (e) { threw = e; }
    ctx.rep.check('the reader refuses eight bytes that are not an sfnt', threw !== null);
  },
};
