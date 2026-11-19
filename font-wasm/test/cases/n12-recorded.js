'use strict';
// N12: every output recorded in fontwrap-oracle.json is reproduced byte for byte by the committed engine, and its
// independent verdicts (the web repo's scorer) meet the gate (P1 plan, section 2.3).

const fs = require('fs');
const path = require('path');
const { fontOracle, fx, sha256 } = require('../lib/fixtures');
const { DEFAULT_GLUE, IN, OUT } = require('../lib/engine');
const { FONTWRAP_ORACLE, engineOracle, gateViolations, opTable } = require('../lib/oracle');
const { describe, success } = require('../lib/checks');

// How many entries each exemption of the gate covers, pinned so that a regenerated font-oracle.json cannot move an
// entry into one unnoticed (review after P1, finding 3): strict na (7 CFF EOTs, 6 MTX, 3 of the bitmap font, 3
// fontTools hmtx misreads), the bitmap font's reduced gate, unscored collections, OTS-rejected sources (14 sanitizer
// fails allowed; their 3 EOT outputs get no exemption), the loca switch, the hmtx misreads, judged against another font.
const EXEMPTIONS = { strictNa: 19, bitmap: 5, unscored: 4, otsRejected: 24, locaSwitch: 1, reason: 3, expectedFrom: 9 };

// What each score must have been judged on: the pair, and the input and output files with their sha256.
function scoredAs(op, entry, eo, fo) {
  const s = entry.score;
  if (op.unscored) return s === null ? [] : ['a collection entry has a score'];
  if (!s) return ['no score'];
  const files = {
    fixture: [op.fixture, fo[op.fixture].sha256],
    output: [entry.file.path, entry.file.sha256],
    input: op.inputFrom && [eo.outputs[op.inputFrom].file.path, eo.outputs[op.inputFrom].file.sha256],
    expected: op.expectedFrom && [op.expectedFrom, fo[op.expectedFrom].sha256],
  };
  const [inPath, inSha] = files[op.scoreIn] || [];
  const [outPath] = files[op.scoreOut] || [];
  const p = [];
  if (s.pair !== op.pair) p.push(`scored as ${s.pair}, not ${op.pair}`);
  if (s.input !== inPath || s.input_sha256 !== inSha) p.push(`scored against ${s.input}, not ${inPath}`);
  if (s.output !== outPath) p.push(`scored ${s.output}, not ${outPath}`);
  if (s.reason !== (op.reason || null)) p.push(`reason ${s.reason}`);
  return p;
}

module.exports = {
  id: 'N12', title: 'recorded outputs', needsEngine: true,
  async run(ctx) {
    const eo = engineOracle();
    if (!ctx.rep.check(`${FONTWRAP_ORACLE} exists`, Boolean(eo),
      `no ${fx(FONTWRAP_ORACLE)}: make-oracle.mjs writes it (plan step C4)`)) return;
    ctx.rep.check('the oracle is complete (not a partial or scratch oracle)', eo.partial !== true && eo.scratch !== true);
    const glue = ctx.kind === 'wasm' ? ctx.eng.gluePath : DEFAULT_GLUE;
    const wasm = glue.replace(/\.js$/, '.wasm');
    ctx.rep.check('the oracle names the engine under test (sha256 of both files)',
      sha256(fs.readFileSync(glue)) === eo.generator.engine.js && sha256(fs.readFileSync(wasm)) === eo.generator.engine.wasm);
    const fo = fontOracle().fixtures;
    const ops = opTable('wasm');
    const recorded = Object.keys(eo.outputs).sort();
    const expected = ops.map((o) => o.key).sort();
    ctx.rep.check('the recorded entries are exactly the op table', JSON.stringify(recorded) === JSON.stringify(expected),
      `${recorded.length} recorded, ${expected.length} expected`);
    let n = 0;
    for (const op of ops.filter((o) => ctx.keep(o.fixture))) {
      const entry = eo.outputs[op.key];
      if (!entry) { ctx.rep.fail(op.key, 'not recorded'); continue; }
      n++;
      const input = op.inputFrom ? fs.readFileSync(path.join(eo.root, eo.outputs[op.inputFrom].file.path))
        : { path: fx(op.fixture) };
      const r = await ctx.eng.run([...op.argv, IN, OUT], { input, inName: 'in.font', outName: `out.${op.outExt}` });
      const same = success(r) && sha256(r.out) === entry.file.sha256 && r.out.length === entry.file.size;
      const fixtureSame = entry.fixture_sha256 === fo[op.fixture].sha256;
      const gate = gateViolations(op, entry.score);
      const scored = scoredAs(op, entry, eo, fo);
      ctx.rep.check(`reproduced and within the gate: ${op.key}`, same && fixtureSame && scored.length === 0 &&
        gate.length === 0, [same ? '' : describe(r), fixtureSame ? '' : 'fixture changed since recording', ...scored,
        ...gate].filter(Boolean).join('; '));
    }
    ctx.count('recorded outputs', n, 201); // P3b: Nabla and Bungee Color's sbix and SVG builds, 4 ops each, and 6 decodes
    for (const [field, want] of Object.entries(EXEMPTIONS)) {
      ctx.count(`entries with ${field}`, ops.filter((o) => Boolean(o[field])).length, want);
    }
    if (ctx.kind === 'native') {
      ctx.rep.notApplicable('generated/eot/Noto-COLRv1.mtx.eot#decode', 'decodes only natively (P1-15); N6 checks it');
    }
  },
};
