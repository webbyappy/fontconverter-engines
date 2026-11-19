'use strict';
// N12: the recorded oracle names the committed build, is complete, and was made from the fixtures and the fontwrap
// outputs that are on the drive (P2 plan, section 5).

const fs = require('fs');
const path = require('path');
const { fontOracle, fontwrapOracle, sha256 } = require('../lib/fixtures');
const { MODULE_DIR } = require('../lib/engine');
const oracle = require('../lib/oracle');

function exemptions(recorded) {
  const out = { inheritedSanitizer: 0, namedExceptions: 0 };
  for (const e of Object.values(recorded.outputs)) {
    if (e.sanitizer_evidence) out.inheritedSanitizer++;
  }
  out.namedExceptions = Object.keys(recorded.parity.exceptions || {}).length;
  return out;
}

module.exports = {
  id: 'N12', title: 'recorded oracle', needsEngine: false,
  async run(ctx) {
    const recorded = oracle.ffconvOracle();
    if (!recorded) {
      ctx.rep.fail('ffconv-oracle.json', 'no ffconv-oracle.json');
      return;
    }
    const out = path.join(MODULE_DIR, 'output');
    const js = sha256(fs.readFileSync(path.join(out, 'ffconv.js')));
    const wasm = sha256(fs.readFileSync(path.join(out, 'ffconv.wasm')));
    ctx.rep.check('the oracle names the committed build', recorded.generator.engine.js === js &&
      recorded.generator.engine.wasm === wasm, `oracle ${recorded.generator.engine.wasm.slice(0, 8)}, output ${wasm.slice(0, 8)}`);
    ctx.rep.check('the oracle is neither partial nor a scratch run', !recorded.partial && !recorded.scratch);
    const keys = oracle.opTable().map((o) => o.key);
    const got = Object.keys(recorded.outputs).sort();
    ctx.rep.check(`the entries equal the op table (${oracle.PINNED.entries})`, JSON.stringify(got) === JSON.stringify(keys) &&
      keys.length === oracle.PINNED.entries, `${got.length} recorded`);
    const fixtures = fontOracle().fixtures;
    const fw = fontwrapOracle().outputs;
    const bad = oracle.opTable().filter((o) => {
      const e = recorded.outputs[o.key];
      if (!e || e.fixture_sha256 !== fixtures[o.fid].sha256 || e.input.sha256 !== o.input.sha256) return true;
      return o.input.from === 'fontwrap' && fw[`${o.fid}#decode`].file.sha256 !== e.input.sha256;
    }).map((o) => o.key);
    ctx.rep.check('every fixture and fontwrap input is the one on the drive', bad.length === 0, bad.join(', '));
    // How each entry was made (closing review; P1 review #3): its pairs, its output path, the twin reference and the
    // twin files as they are on the drive now (a --rerun would make a recorded twin score stale).
    const wasm8 = recorded.generator.engine.wasm.slice(0, 8);
    const made = oracle.opTable().filter((o) => {
      const e = recorded.outputs[o.key];
      if (!e || e.score_source.pair !== o.sourcePair || e.file.path !== `engines/ffconv/${wasm8}/${o.fid}/${o.target}.${o.target}`) return true;
      if (!o.twin) return e.twin !== null;
      const refs = oracle.twinRefs(o);
      if (!e.twin || e.twin.reference !== refs.reference) return true;
      return ['arm64', 'amd64'].some((a) => refs[a] && (!e.twin[a] || e.twin[a].sha256 !== refs[a].sha256 ||
        (e.twin[a].score && e.twin[a].score.pair !== o.twinPair)));
    }).map((o) => o.key);
    ctx.rep.check('every entry names its pairs, its output and the twin files on the drive now', made.length === 0,
      made.join(', '));
    ctx.rep.check('the recorded policy equals the pinned one', JSON.stringify(recorded.parity.allowed) ===
      JSON.stringify(oracle.ALLOWED) && JSON.stringify(recorded.parity.allowed_cff_to_truetype) ===
      JSON.stringify(oracle.ALLOWED_CFF_TO_TRUETYPE), JSON.stringify(recorded.parity.allowed));
    const ex = exemptions(recorded);
    ctx.rep.check('the exemption counts are pinned and equal', oracle.PINNED_EXEMPTIONS !== null &&
      JSON.stringify(ex) === JSON.stringify(oracle.PINNED_EXEMPTIONS), `${JSON.stringify(ex)}, pinned ${JSON.stringify(oracle.PINNED_EXEMPTIONS)}`);
  },
};
