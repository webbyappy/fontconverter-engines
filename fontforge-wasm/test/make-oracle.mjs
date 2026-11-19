#!/usr/bin/env node
// make-oracle.mjs -- writes ffconv-oracle.json (P2 plan, section 3.5; after font-wasm/test/make-oracle.mjs): runs the
// committed engine over the op table (lib/oracle.js), keeps every output on the drive, scores each against the bytes
// ffconv was given and against production's twin output (the web repo's scorer through its content-keyed cache),
// compares each with the twin table by table (parity_diff.py), checks every entry against the gate, and writes the
// oracle. Run by hand, never by a test.
//
//   TZ=UTC node fontforge-wasm/test/make-oracle.mjs                       the authoritative run onto the drive
//   TZ=UTC node fontforge-wasm/test/make-oracle.mjs --out-root=<scratch> [--fixture=<substring>] [--plant=<key>]
//   TZ=UTC node fontforge-wasm/test/make-oracle.mjs --rebaseline          replace every baseline (after review; P8)
//
// Authoritative: refuses uncommitted changes in fontforge-wasm/output, fontforge-wasm/test or the web repo's
// tests/tools, and --fixture or --plant. A trial may be dirty (the commit is recorded with " (dirty)"), filtered
// (the oracle is marked partial) and is always marked scratch; N12 refuses both. --plant=<key> adds an unallowed
// parity class to one entry, to see the gate refuse it (no oracle is written). The oracle is written when absent,
// otherwise as ffconv-oracle.next.json with the differences printed (refused at once if that file exists).
// Baselines (P2-15): the first run defines them; later runs carry the existing oracle's forward unchanged unless
// --rebaseline. Refused too: outputs whose bytes differ from what is already on the drive, fixtures whose sha256
// differs from font-oracle.json, fontwrap inputs whose sha256 differs from fontwrap-oracle.json. Nothing is
// overwritten or deleted. A failed conversion, a crashed scorer or a failed parity_diff stops the run at once; a
// score the scorer reports as fatal (it could not load a font) is recorded as an error, which the gate rejects like
// any violation (P2-15). All gate violations are reported after scoring, and then no oracle is written.

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { FONT_FIXTURES, fontOracle, fontwrapOracle, fx, sha256 } = require('./lib/fixtures');
const { ENV, IN, OUT, WasmEngine } = require('./lib/engine');
const { success } = require('./lib/checks');
const { scorerCodepoints } = require('./lib/sfnt');
const svg = require('./lib/svgfont');
const oracle = require('./lib/oracle');

const MODULE = path.resolve(import.meta.dirname, '..');
const WASM_REPO = path.dirname(MODULE);
const WEB_REPO = process.env.FONTCONVERTER_WEB;
if (!WEB_REPO) throw new Error('Set FONTCONVERTER_WEB to the fontconverter-web checkout');
const TOOLS = path.join(WEB_REPO, 'tests/tools');
const PYTHON = process.env.FONT_PYTHON || path.join(process.env.HOME, '.venvs/fontconverter-tools/bin/python');

const arg = (name) => {
  const a = process.argv.slice(2).find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
};
const outRoot = path.resolve(arg('out-root') || FONT_FIXTURES);
const filter = arg('fixture');
const plant = arg('plant');
const rebaseline = process.argv.includes('--rebaseline');
const authoritative = outRoot === path.resolve(FONT_FIXTURES);

function die(msg) {
  console.log(`make-oracle: error: ${msg}`);
  process.exit(1);
}

function git(repo, ...a) {
  return execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();
}

if (process.env.TZ !== 'UTC') die('run with TZ=UTC (SVG metadata prints local time; P2-7)');
const wasmDirty = git(WASM_REPO, 'status', '--porcelain', '--', 'fontforge-wasm/output', 'fontforge-wasm/test');
const toolsDirty = git(WEB_REPO, 'status', '--porcelain', '--', 'tests/tools');
if (authoritative && (wasmDirty || toolsDirty)) die(`commit first:\n${wasmDirty}\n${toolsDirty}`);
if (authoritative && (filter || plant)) die('--fixture and --plant are for trials only');

const target = path.join(outRoot, oracle.FFCONV_ORACLE);
const nextOracle = target.replace(/\.json$/, '.next.json');
if (fs.existsSync(nextOracle)) die(`${nextOracle} exists; review and move it first`);
const previous = fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, 'utf8')) : null;

const eng = new WasmEngine();
if (!eng.available()) die(`no engine at ${eng.gluePath}`);
await eng.init();
const engineSha = { js: sha256(fs.readFileSync(eng.gluePath)), wasm: sha256(fs.readFileSync(eng.wasmPath)) };
const outputsDir = path.join('engines', 'ffconv', engineSha.wasm.slice(0, 8));
const scoresDir = path.join(outRoot, 'engines', 'ffconv', '_scores');
// The allowed lists the gate pins must be parity_diff's own (closing review: nothing compared them before).
const vocabulary = JSON.parse(execFileSync(PYTHON, ['-I', path.join(TOOLS, 'parity_diff.py'), '--classes'],
  { encoding: 'utf8' }));
if (JSON.stringify(vocabulary.allowed) !== JSON.stringify(oracle.ALLOWED) ||
  JSON.stringify(vocabulary.allowed_cff_to_truetype) !== JSON.stringify(oracle.ALLOWED_CFF_TO_TRUETYPE)) {
  die(`lib/oracle.js's allowed lists differ from parity_diff.py --classes: ${JSON.stringify(vocabulary)}`);
}
const scorerIdentity = execFileSync(PYTHON, ['-I', '-c',
  `import sys; sys.path.insert(0, ${JSON.stringify(TOOLS)}); import score_cache; print(score_cache.scorer_identity())`],
{ encoding: 'utf8' }).trim();
let parityIdentity = null;

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

const counts = { written: 0, unchanged: 0, scored: 0, reused: 0 };

// One score record, cached by content (score_cached.py), and the facts the gate reads from it.
function score(name, input, output, pair) {
  const argv = ['-I', path.join(TOOLS, 'score_cached.py'), scoresDir, name.replace(/[^A-Za-z0-9._/-]+/g, '_'), input,
    output, '--pair', pair];
  const p = spawnSync(PYTHON, argv, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  if (p.status !== 0) die(`scoring ${name} failed: ${p.stderr.slice(-600)}`);
  const { reused, record } = JSON.parse(p.stdout);
  counts[reused ? 'reused' : 'scored']++;
  if (record.fatal || !record.checks || !record.adopted) {
    return { pair, error: String(record.fatal || 'no checks in the record'),
      verdicts: (record.adopted && record.adopted.verdicts) || {} };
  }
  const c = record.checks;
  const outline = c.outline || {};
  const cm = c.cmap || {};
  const cp = (x) => (typeof x === 'number' ? x : parseInt(String(x).replace(/^U\+/, ''), 16));
  const unmapped = outline.unmapped || {};
  const san = c.sanitizer || {};
  return { pair, verdicts: record.adopted.verdicts,
    outline_failing_revised: outline.glyphs_failing_revised ?? outline.glyphs_failing ?? 0,
    unmapped_verdict: unmapped.verdict || null, unmapped_failing_revised: unmapped.failing_revised ?? 0,
    ink_box_over_1px: outline.info_ink_box_over_1px ?? 0,
    pair_matrix_mismatches: ((c.layout || {}).pair_matrix_extension || {}).mismatches ?? 0,
    cmap: { n_missing: cm.n_missing ?? null, missing: (cm.missing_codepoints || []).map(cp),
      n_advance_mismatch: cm.n_advance_mismatch ?? null, mapped_pct: cm.mapped_pct ?? null,
      all_three_pct: cm.all_three_pct ?? null },
    sanitizer: { input_accepted: san.input_accepted ?? null, input_messages: san.input_messages || [],
      messages: san.messages || [], structure_problems: san.structure_problems || [] } };
}

// parity_diff with the source font: differences the source backs are named for it (P2-25).
function parity(ref, out, source) {
  const p = spawnSync(PYTHON, ['-I', path.join(TOOLS, 'parity_diff.py'), ref, out, '--source', source],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (p.status !== 0) die(`parity_diff ${ref} failed: ${(p.stdout + p.stderr).slice(-600)}`);
  const r = JSON.parse(p.stdout);
  parityIdentity = parityIdentity || r.identity;
  if (r.identity !== parityIdentity) die('parity_diff changed identity during the run');
  return { kind: r.kind, differences: r.differences };
}

// Why a sanitizer `fail` is production's and not ours (P2 plan 3.5): OTS rejects the source with the same messages,
// or the twin's output fails the same check against the same source with the same problems; for an SVG, the
// structure check's two kinds of problem as complete code-point sets of ours and production's (P2-25).
function sanitizerEvidence(o, e, ours) {
  const s = e.score_source.sanitizer;
  if (o.target !== 'svg' && s.input_accepted === false) {
    return { kind: 'source-ots', source_accepted: false, source_messages: s.input_messages, output_messages: s.messages };
  }
  const refs = o.twin ? oracle.twinRefs(o) : null;
  const ref = refs && refs[refs.reference];
  if (o.target === 'svg') {
    if (!ref) return null;
    const cps = scorerCodepoints(fs.readFileSync(fx(o.input.rel)));
    return { kind: 'twin-structure', reference: refs.reference, scorer_problems: s.structure_problems,
      ours: svg.coverage(fs.readFileSync(path.join(outRoot, ours), 'utf8'), cps),
      twin: svg.coverage(fs.readFileSync(fx(ref.rel), 'utf8'), cps) };
  }
  if (!ref) return null;
  const t = score(`twin-source/${o.key}`, fx(o.input.rel), fx(ref.rel), o.sourcePair);
  const problems = (x) => x.sanitizer.messages;
  return { kind: 'twin', reference: refs.reference, twin_verdict: t.verdicts.sanitizer, twin_problems: problems(t),
    output_problems: problems(e.score_source), output: ours };
}

const fo = fontOracle().fixtures;
const fw = fontwrapOracle().outputs;
const ops = oracle.opTable().filter((o) => !filter || o.fid.includes(filter));
for (const o of ops) {
  const got = sha256(fs.readFileSync(fx(o.fid)));
  if (got !== fo[o.fid].sha256) die(`${o.fid} has sha256 ${got}, font-oracle.json says ${fo[o.fid].sha256}`);
  if (o.input.from === 'fontwrap') {
    const isha = sha256(fs.readFileSync(fx(o.input.rel)));
    if (isha !== fw[`${o.fid}#decode`].file.sha256) die(`${o.input.rel} differs from fontwrap-oracle.json`);
  }
}

const outputs = {};
for (const o of ops) {
  const r = await eng.run(['convert', IN, OUT], { input: { path: fx(o.input.rel) }, inName: o.inName,
    outName: o.outName });
  const ok = success(r, o.target);
  if (!ok.ok) die(`${o.key}: ${ok.why}`);
  const rel = path.join(outputsDir, o.fid, `${o.target}.${o.target}`);
  counts[keep(r.out, rel)]++;
  const ours = path.join(outRoot, rel);
  const e = { argv: ['convert', `<in>/${o.inName}`, `<out>/${o.outName}`],
    input: { from: o.input.from, path: o.input.rel, sha256: o.input.sha256 }, fixture_sha256: fo[o.fid].sha256,
    result: r.json, file: { path: rel, sha256: sha256(r.out), size: r.out.length },
    score_source: score(`source/${o.key}`, fx(o.input.rel), ours, o.sourcePair), twin: null };
  if (o.twin) {
    const refs = oracle.twinRefs(o);
    e.twin = { reference: refs.reference };
    for (const arch of ['arm64', 'amd64']) {
      const t = refs[arch];
      if (!t) continue;
      e.twin[arch] = { sha256: t.sha256, score: score(`vs-${arch}/${o.key}`, fx(t.rel), ours, o.twinPair),
        parity: parity(fx(t.rel), ours, fx(o.input.rel)) };
      if (o.target === 'svg') {  // the code points production's SVG maps alone that ours does not (complete)
        const theirs = fs.readFileSync(fx(t.rel), 'utf8');
        const single = svg.glyphs(theirs).map((g) => [...(g.attrs.unicode || '')]).filter((u) => u.length === 1);
        e.twin[arch].lacking = svg.coverage(fs.readFileSync(ours, 'utf8'),
          new Set(single.map((u) => u[0].codePointAt(0)))).missing;
      }
    }
    if (refs.arm64 && refs.amd64 && refs.arm64.sha256 !== refs.amd64.sha256) {
      e.twin.twin_vs_twin = score(`twins/${o.key}`, fx(refs.arm64.rel), fx(refs.amd64.rel), o.twinPair);
    }
    if (o.key === plant && e.twin[refs.reference]) {
      e.twin[refs.reference].parity.differences.push({ class: 'planted', where: 'trial', detail: '--plant' });
    }
  }
  if (e.score_source.verdicts.sanitizer === 'fail') e.sanitizer_evidence = sanitizerEvidence(o, e, rel);
  const carried = !rebaseline && previous && previous.outputs[o.key] && previous.outputs[o.key].baseline;
  e.baseline = carried || { ...e.score_source, sanitizer: undefined };
  outputs[o.key] = e;
  const v = e.score_source.verdicts;
  console.log(`${o.key}: ${e.file.size} bytes, source ${['parses', 'sanitizer', 'cmap', 'outline', 'metrics', 'layout']
    .map((k) => `${k} ${v[k]}`).join(', ')}${e.twin ? `, twin ${e.twin.reference}` : ''}`);
}

const violations = ops.flatMap((o) => oracle.gateViolations(o, outputs[o.key]).map((v) => `${o.key}: ${v}`));
if (violations.length) {
  console.log(violations.join('\n'));
  die(`${violations.length} gate violation(s); no oracle written`);
}

const commit = git(WASM_REPO, 'rev-parse', 'HEAD') + (wasmDirty ? ' (dirty)' : '');
const toolsCommit = git(WEB_REPO, 'rev-parse', 'HEAD') + (toolsDirty ? ' (dirty)' : '');
const result = { schema: 1, engine: 'ffconv', definitions: 'P3b-2026-11-18-R8',
  generator: { script: 'fontforge-wasm/test/make-oracle.mjs', commit, engine: engineSha,
    scorer: { tools_commit: toolsCommit, scorer_identity: scorerIdentity }, parity_diff_identity: parityIdentity,
    node: process.version.slice(1), env: { ...ENV, TZ: 'UTC' },
    fontwrap_oracle_sha256: sha256(fs.readFileSync(path.join(FONT_FIXTURES, 'fontwrap-oracle.json'))) },
  parity: { reference_when_twins_differ: 'amd64', allowed: oracle.ALLOWED,
    allowed_cff_to_truetype: oracle.ALLOWED_CFF_TO_TRUETYPE, exceptions: oracle.EXCEPTIONS },
  outputs: Object.fromEntries(Object.keys(outputs).sort().map((k) => [k, outputs[k]])) };
if (filter) result.partial = true;
if (!authoritative) result.scratch = true;
if (rebaseline) result.rebaselined = true;

const provenance = path.join(outRoot, outputsDir, 'PROVENANCE.md');
if (!fs.existsSync(provenance)) {
  fs.mkdirSync(path.dirname(provenance), { recursive: true });
  fs.writeFileSync(provenance, `# ${outputsDir}/: outputs of one ffconv build\n\n` +
    'Written by `fontforge-wasm/test/make-oracle.mjs` ' +
    `at wasm repo commit \`${commit}\` from \`fontforge-wasm/output/ffconv.js\` (sha256 \`${engineSha.js}\`) and ` +
    `\`ffconv.wasm\` (sha256 \`${engineSha.wasm}\`), with ENV ${JSON.stringify(ENV)} and TZ=UTC. Each file is ` +
    '`<fixture path>/<target>.<target>`; `ffconv-oracle.json` at the fixture root lists them with their sha256, ' +
    'scores and parity differences. Never edited or deleted.\n', { flag: 'wx' });
}
let dest = target;
if (previous) {
  dest = nextOracle;
  const old = previous.outputs;
  const added = Object.keys(result.outputs).filter((k) => !old[k]);
  const removed = Object.keys(old).filter((k) => !result.outputs[k]);
  const changed = Object.keys(result.outputs)
    .filter((k) => old[k] && JSON.stringify(old[k]) !== JSON.stringify(result.outputs[k]));
  console.log(`outputs: ${added.length} added, ${removed.length} removed, ${changed.length} changed`);
  for (const k of changed.slice(0, 30)) console.log(`  changed ${k}`);
}
// RegExps (an exception's scorer-unavailable patterns) are recorded as their source text.
fs.writeFileSync(dest, JSON.stringify(result, (k, v) => (v instanceof RegExp ? v.source : v), 1) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ oracle: dest, entries: Object.keys(outputs).length, ...counts, partial: Boolean(filter),
  scratch: !authoritative }));
