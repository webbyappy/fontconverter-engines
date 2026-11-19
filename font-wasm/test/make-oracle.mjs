#!/usr/bin/env node
// make-oracle.mjs -- writes fontwrap-oracle.json (P1 plan, section 2.3): runs the committed engine over the op table,
// keeps every output on the drive, scores each with the web repo's harness (fontTools, OTS, FreeType, HarfBuzz)
// through its content-keyed score cache, checks every verdict against the gate, and writes the oracle. Run by hand,
// never by a test.
//
//   node font-wasm/test/make-oracle.mjs                                   the authoritative run onto the drive
//   node font-wasm/test/make-oracle.mjs --out-root=<scratch> [--fixture=<substring>]    a trial
//
// Authoritative: refuses uncommitted changes in font-wasm/output, font-wasm/test or the web repo's tests/tools, and
// any --fixture filter. A trial may be dirty (the commit is recorded with " (dirty)") and filtered (the oracle is
// then marked partial; N12 refuses it). The oracle is written when absent, otherwise as fontwrap-oracle.next.json
// with the differences printed (the run is refused at once if that file exists). Refused too: outputs whose bytes
// differ from what is already on the drive, and fixtures whose sha256 differs from font-oracle.json. Nothing is
// overwritten or deleted. A scorer failure or a fatal record stops the run at once; gate violations are all reported
// after scoring, and then no oracle is written.

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { FONT_FIXTURES, fontOracle, fx, sha256 } = require('./lib/fixtures');
const { IN, OUT, WasmEngine } = require('./lib/engine');
const { FONTWRAP_ORACLE, gateViolations, opTable } = require('./lib/oracle');

const MODULE = path.resolve(import.meta.dirname, '..');
const WASM_REPO = path.dirname(MODULE);
const WEB_REPO = process.env.FONTCONVERTER_WEB;
if (!WEB_REPO) throw new Error('Set FONTCONVERTER_WEB to the fontconverter-web checkout');
const FONT_SCORER = process.env.FONT_SCORER || path.join(WEB_REPO, 'tests/tools/score_font.py');
const TOOLS = path.dirname(FONT_SCORER);
const PYTHON = process.env.FONT_PYTHON || path.join(process.env.HOME, '.venvs/fontconverter-tools/bin/python');

const arg = (name) => {
  const a = process.argv.slice(2).find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
};
const outRoot = path.resolve(arg('out-root') || FONT_FIXTURES);
const filter = arg('fixture');
const authoritative = outRoot === path.resolve(FONT_FIXTURES);

function die(msg) {
  console.log(`make-oracle: error: ${msg}`);
  process.exit(1);
}

function git(repo, ...a) {
  return execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();
}

const wasmDirty = git(WASM_REPO, 'status', '--porcelain', '--', 'font-wasm/output', 'font-wasm/test');
const toolsDirty = git(WEB_REPO, 'status', '--porcelain', '--', 'tests/tools');
if (authoritative && (wasmDirty || toolsDirty)) die(`commit first:\n${wasmDirty}\n${toolsDirty}`);
if (authoritative && filter) die('--fixture is for trials only: the authoritative oracle covers the whole op table');

const nextOracle = path.join(outRoot, FONTWRAP_ORACLE).replace(/\.json$/, '.next.json');
if (fs.existsSync(nextOracle)) die(`${nextOracle} exists; review and move it first`);

const eng = new WasmEngine();
if (!eng.available()) die(`no engine at ${eng.gluePath}`);
await eng.init();
const engineSha = { js: sha256(fs.readFileSync(eng.gluePath)), wasm: sha256(fs.readFileSync(eng.wasmPath)) };
const outputsDir = path.join('engines', 'fontwrap', engineSha.wasm.slice(0, 8));
const scoresDir = path.join(outRoot, 'engines', 'fontwrap', '_scores');
const scorerIdentity = execFileSync(PYTHON, ['-I', '-c',
  `import sys; sys.path.insert(0, ${JSON.stringify(TOOLS)}); import score_cache; print(score_cache.scorer_identity())`],
{ encoding: 'utf8' }).trim();

function keep(bytes, rel) {
  const abs = path.join(outRoot, rel);
  if (fs.existsSync(abs)) {
    if (!fs.readFileSync(abs).equals(bytes)) die(`${abs} exists with other bytes; refusing to replace it`);
    return 'unchanged';
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bytes, { flag: 'wx' });
  return 'written';
}

function score(op, files) {
  const pick = { fixture: fx(op.fixture), output: files.output, input: files.input,
    expected: op.expectedFrom && fx(op.expectedFrom) };
  const input = pick[op.scoreIn];
  const output = pick[op.scoreOut];
  const name = op.key.replace(/[^A-Za-z0-9._-]+/g, '_');
  const argv = ['-I', path.join(TOOLS, 'score_cached.py'), scoresDir, name, input, output, '--pair', op.pair];
  const p = spawnSync(PYTHON, argv, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (p.status !== 0) die(`scoring ${op.key} failed: ${p.stderr.slice(-600)}`);
  const { reused, record } = JSON.parse(p.stdout);
  if (record.fatal || !record.checks || !record.adopted) {
    die(`scoring ${op.key} gave a fatal record: ${JSON.stringify(record).slice(0, 400)}`);
  }
  const strict = record.checks.strict || {};
  const rel = (abs) => path.relative(abs.startsWith(outRoot) ? outRoot : FONT_FIXTURES, abs);
  // input_sha256 and reason say what the output was judged against: the fixture itself, our own earlier output, or
  // (MTX EOT, fontTools' hmtx misread) a source font named by the op table, with the reason.
  return { reused, score: { pair: op.pair, input: rel(input), input_sha256: sha256(fs.readFileSync(input)),
    output: rel(output), reason: op.reason || null, verdicts: record.adopted.verdicts,
    strict_problems: strict.problems || [], strict_revised: strict.verdict_revised || null } };
}

const fo = fontOracle().fixtures;
const ops = opTable('wasm').filter((o) => !filter || o.fixture.includes(filter));
for (const id of new Set(ops.map((o) => o.fixture))) {
  const got = sha256(fs.readFileSync(fx(id)));
  if (got !== fo[id].sha256) die(`${id} has sha256 ${got}, font-oracle.json says ${fo[id].sha256}`);
}
const outputs = {};
const written = { written: 0, unchanged: 0, scored: 0, reused: 0 };
for (const op of ops) {
  const prior = op.inputFrom && outputs[op.inputFrom];
  if (op.inputFrom && !prior) die(`${op.key} needs ${op.inputFrom}, which is not in this run`);
  const input = prior ? fs.readFileSync(path.join(outRoot, prior.file.path)) : { path: fx(op.fixture) };
  const r = await eng.run([...op.argv, IN, OUT], { input, inName: 'in.font', outName: `out.${op.outExt}` });
  if (r.code !== 0 || !r.out || !r.json) die(`${op.key}: exit ${r.code}, ${r.stderr.join(' | ')}`);
  const rel = path.join(outputsDir, `${op.fixture}#${op.op}.${op.outExt}`.replace('#', '/'));
  written[keep(r.out, rel)]++;
  const entry = { argv: op.argv, result: r.json, file: { path: rel, sha256: sha256(r.out), size: r.out.length },
    fixture_sha256: fo[op.fixture].sha256, score: null };
  if (!op.unscored) {
    const files = { output: path.join(outRoot, rel), input: prior && path.join(outRoot, prior.file.path) };
    const s = score(op, files);
    entry.score = s.score;
    written[s.reused ? 'reused' : 'scored']++;
  }
  outputs[op.key] = entry;
  console.log(`${op.key}: ${entry.file.size} bytes${entry.score ? `, strict ${entry.score.verdicts.strict}` : ''}`);
}

const violations = ops.flatMap((op) => gateViolations(op, outputs[op.key].score).map((v) => `${op.key}: ${v}`));
if (violations.length) {
  console.log(violations.join('\n'));
  die(`${violations.length} gate violation(s); no oracle written`);
}

const commit = git(WASM_REPO, 'rev-parse', 'HEAD') + (wasmDirty ? ' (dirty)' : '');
const toolsCommit = git(WEB_REPO, 'rev-parse', 'HEAD') + (toolsDirty ? ' (dirty)' : '');
const oracle = { schema: 1, engine: 'fontwrap', definitions: 'P3b-2026-11-18-R8',
  generator: { script: 'font-wasm/test/make-oracle.mjs', commit, engine: engineSha,
    scorer: { tools_commit: toolsCommit, scorer_identity: scorerIdentity }, node: process.version.slice(1) },
  outputs: Object.fromEntries(Object.keys(outputs).sort().map((k) => [k, outputs[k]])) };
if (filter) oracle.partial = true;
if (!authoritative) oracle.scratch = true;

const provenance = path.join(outRoot, outputsDir, 'PROVENANCE.md');
if (!fs.existsSync(provenance)) {
  fs.writeFileSync(provenance, `# ${outputsDir}/: outputs of one fontwrap build\n\n` +
    'Written by `font-wasm/test/make-oracle.mjs` ' +
    `at wasm repo commit \`${commit}\` from \`font-wasm/output/fontwrap.js\` (sha256 \`${engineSha.js}\`) and ` +
    `\`fontwrap.wasm\` (sha256 \`${engineSha.wasm}\`). Each file is \`<fixture path>/<op>.<ext>\`; ` +
    '`fontwrap-oracle.json` at the fixture root lists them with their sha256 and scores. Never edited or deleted.\n');
}
const target = path.join(outRoot, FONTWRAP_ORACLE);
let dest = target;
if (fs.existsSync(target)) {
  dest = nextOracle;
  const old = JSON.parse(fs.readFileSync(target, 'utf8')).outputs;
  const added = Object.keys(oracle.outputs).filter((k) => !old[k]);
  const removed = Object.keys(old).filter((k) => !oracle.outputs[k]);
  const changed = Object.keys(oracle.outputs)
    .filter((k) => old[k] && JSON.stringify(old[k]) !== JSON.stringify(oracle.outputs[k]));
  console.log(`outputs: ${added.length} added, ${removed.length} removed, ${changed.length} changed`);
  for (const k of changed.slice(0, 30)) console.log(`  changed ${k}`);
}
fs.writeFileSync(dest, JSON.stringify(oracle, null, 1) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ oracle: dest, entries: Object.keys(outputs).length, ...written, partial: Boolean(filter),
  scratch: !authoritative }));
