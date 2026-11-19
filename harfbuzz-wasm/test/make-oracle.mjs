#!/usr/bin/env node
// make-oracle.mjs -- writes hbfont-oracle.json (fontconverter-web P3b plan, section 2): runs the committed hbfont (and,
// for routes and transplants, the committed ffconv) over the plan's specs, keeps every output on the drive, judges each
// with the web repo's tools, checks the gates, and writes the oracle. Run by hand, never by a test.
//
//   TZ=UTC node harfbuzz-wasm/test/make-oracle.mjs                         the authoritative run onto the drive
//   TZ=UTC node harfbuzz-wasm/test/make-oracle.mjs --out-root=<scratch> [--fixture=<substring>]   a trial
//
// Entries:
//   <fixture>#instance:<spec>            hbfont instance; judge_instance (fontTools' instance as the reference;
//                                        --expect with N4's pinned names where N4 pins them)
//   <fixture>#route:<spec>:<target>      that instance through ffconv with the app's argv; the scorer against the
//                                        instance and against a control (P3b decision of 2026-11-19 with Codex: no
//                                        production twin exists for an instance, and FontForge approximates, rounding
//                                        the cubic control points it makes from quadratics and fitting quadratics to
//                                        cubics, so the instance is not the geometric reference). Control: fontTools'
//                                        instance at the same coordinates through the same ffconv; against it parses,
//                                        outline, metrics and, for sfnt, cmap pass. Against the instance (a TrueType
//                                        one without its overlap bits): parses, metrics and, for sfnt, layout and
//                                        sanitizer pass; no code point missing (for svg only U+FB00 to U+FB06, which
//                                        FontForge's SVG writer gives by their components, and those XML 1.0 cannot
//                                        carry, as in ffconv's oracle), no advance differing, no ink box
//                                        more than 1 px off; its outline and cmap verdicts recorded, not gated. For
//                                        ttf/otf judge_layout passes and nameIDs 1, 2, 4, 6, 16, 17 are the instance's
//                                        after FontForge
//   <fixture>#transplant[:<spec>]:<target>  ffconv --allow-lossy --glyph-map, then hbfont transplant; judge_colour
// Authoritative: refuses uncommitted changes in harfbuzz-wasm/output, harfbuzz-wasm/test, fontforge-wasm/output or the
// web repo's tests/tools, and --fixture. Outputs go to engines/hbfont/<wasm sha8>/ and are never replaced with other
// bytes. Written when absent, otherwise as hbfont-oracle.next.json with the differences printed. Nothing is deleted;
// any gate violation stops it before the oracle is written.

import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { FONT_FIXTURES, fx } = require('./lib/fixtures');
const { OUT, WasmEngine, inp } = require('./lib/engine');
const { GLUE: FFCONV_GLUE, fontforge } = require('./lib/ffconv');
const { nameText } = require('./lib/names');
const { SPECS: NAME_SPECS } = require('./cases/n04-names');

const MODULE = path.resolve(import.meta.dirname, '..');
const WASM_REPO = path.dirname(MODULE);
const WEB_REPO = process.env.FONTCONVERTER_WEB;
if (!WEB_REPO) throw new Error('Set FONTCONVERTER_WEB to the fontconverter-web checkout');
const TOOLS = path.join(WEB_REPO, 'tests/tools');
const PYTHON = process.env.FONT_PYTHON || path.join(process.env.HOME, '.venvs/fontconverter-tools/bin/python');
const ORACLE = 'hbfont-oracle.json';
const NAME_IDS = [1, 2, 4, 6, 16, 17];

const arg = (name) => {
  const a = process.argv.slice(2).find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
};
const outRoot = path.resolve(arg('out-root') || FONT_FIXTURES);
const filter = arg('fixture');
const authoritative = outRoot === path.resolve(FONT_FIXTURES);
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

function die(msg) {
  console.log(`make-oracle: error: ${msg}`);
  process.exit(1);
}
function git(repo, ...a) {
  return execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();
}

const wasmDirty = git(WASM_REPO, 'status', '--porcelain', '--', 'harfbuzz-wasm/output', 'harfbuzz-wasm/test',
  'fontforge-wasm/output');
const toolsDirty = git(WEB_REPO, 'status', '--porcelain', '--', 'tests/tools');
if (authoritative && (wasmDirty || toolsDirty)) die(`commit first:\n${wasmDirty}\n${toolsDirty}`);
if (authoritative && filter) die('--fixture is for trials only');
const nextOracle = path.join(outRoot, ORACLE).replace(/\.json$/, '.next.json');
if (fs.existsSync(nextOracle)) die(`${nextOracle} exists; review and move it first`);

// The specs: N4's named ones (with their pinned names), OpenSans-VF's ten named instances, and the routes.
const OPENSANS_NAMED = [[300, 100], [400, 100], [600, 100], [700, 100], [800, 100], [300, 75], [400, 75], [600, 75],
  [700, 75], [800, 75]].map(([w, d]) => ['real/var-ttf/OpenSans-VF.ttf', `wght=${w},wdth=${d}`, []]);
const INSTANCES = [...NAME_SPECS.map((s) => [s[0], s[1], s[2], s]), ...OPENSANS_NAMED.map((s) => [...s, null])];
const ROUTES = [ // [fixture, --at, options, targets]
  ['real/var-ttf/OpenSans-VF.ttf', 'wght=400,wdth=100', [], ['otf']],
  ['real/var-ttf/OpenSans-VF.ttf', 'wght=700,wdth=75', [], ['otf', 'svg']],
  ['real/var-ttf/OpenSans-VF.ttf', 'wght=450,wdth=87.5', [], ['otf', 'svg']],
  ['real/sourcesans-vf/SourceSans3VF-Upright.ttf', 'wght=400', [], ['otf']],
  ['real/sourcesans-vf/SourceSans3VF-Upright.ttf', 'wght=650', [], ['otf', 'svg']],
  ['real/sourcesans-vf/SourceSans3VF-Upright.otf', 'wght=400', ['--downgrade-cff2'], ['ttf', 'svg']],
  ['real/sourcesans-vf/SourceSans3VF-Upright.otf', 'wght=700', ['--downgrade-cff2'], ['ttf', 'svg']],
  ['generated/variable/slick-vf-nostat.ttf', 'wght=500', [], ['otf', 'svg']],
  ['generated/variable/slick-vf-nostat.ttf', 'wght=650', [], ['otf', 'svg']],
  ['generated/variable/OpenSans-VF-long-name.ttf', 'wght=400,wdth=100', [], ['otf']],
];
const TRANSPLANTS = [ // [fixture, input name for ffconv, target, instance first ([--at, options]) or null]
  ['real/twemoji/Twemoji.Mozilla.ttf', 'input.ttf', 'otf', null],
  ['generated/colour/Twemoji-cff.otf', 'input.otf', 'ttf', null],
  ['generated/colour/Twemoji-cid.otf', 'input.otf', 'ttf', null],
  ['generated/special/slick-sbix.ttf', 'input.ttf', 'otf', null],
  ['generated/colour/slick-cbdt.ttf', 'input.ttf', 'otf', null],
  ['generated/colour/slick-svg-multi.ttf', 'input.ttf', 'otf', null],
  ['generated/colour/slick-colr-svg-cpal.ttf', 'input.ttf', 'otf', null],
  ['generated/colour/slick-svg-cpal.ttf', 'input.ttf', 'otf', null],
  ['real/color-svg/BungeeColor-Regular_svg.ttf', 'input.ttf', 'otf', null],
  ['real/color-sbix/BungeeColor-Regular_sbix_MacOS.ttf', 'input.ttf', 'otf', null], // engine regression; no app route
  ['real/var-colr/Nabla[EDPT,EHLT].ttf', 'input.ttf', 'otf', ['EDPT=200,EHLT=24', []]],
  ['real/var-colr/Nabla[EDPT,EHLT].ttf', 'input.ttf', 'otf', ['EDPT=100,EHLT=12', []]],
  ['generated/colour/Twemoji-cff2-vf.otf', 'input.otf', 'ttf', ['wght=700', ['--downgrade-cff2']]],
  ['generated/colour/Twemoji-cff2-vf.otf', 'input.otf', 'ttf', ['wght=400', ['--downgrade-cff2']]],
];

const specKey = (at, opts) => at.replace(/=/g, '').replace(/,/g, '-') + (opts.includes('--downgrade-cff2') ? '-cff' : '');
const keep = (fixture) => !filter || fixture.includes(filter);

const eng = new WasmEngine();
await eng.init();
const engineSha = { js: sha256(fs.readFileSync(eng.gluePath)), wasm: sha256(fs.readFileSync(eng.wasmPath)) };
const ffconvSha = { js: sha256(fs.readFileSync(FFCONV_GLUE)),
  wasm: sha256(fs.readFileSync(FFCONV_GLUE.replace(/\.js$/, '.wasm'))) };
const outputsDir = path.join('engines', 'hbfont', engineSha.wasm.slice(0, 8));
const scoresDir = path.join(outRoot, 'engines', 'hbfont', '_scores');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hbfont-oracle-'));
const counts = { written: 0, unchanged: 0 };

function put(bytes, rel) {
  const abs = path.join(outRoot, rel);
  if (fs.existsSync(abs)) {
    if (!fs.readFileSync(abs).equals(bytes)) die(`${abs} exists with other bytes; refusing to replace it`);
    counts.unchanged++;
  } else {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, bytes, { flag: 'wx' });
    counts.written++;
  }
  return { path: rel, sha256: sha256(bytes), size: bytes.length };
}

function judge(script, args) {
  const p = spawnSync(PYTHON, ['-I', path.join(TOOLS, script), ...args], { encoding: 'utf8', maxBuffer: 256 << 20 });
  const line = (p.stdout || '').trim().split('\n').pop();
  let j = null;
  try { j = JSON.parse(line); } catch (_) { die(`${script} printed no JSON line (exit ${p.status}): ${(p.stderr || '').slice(-400)}`); }
  return { verdict: j.verdict, problem_count: j.problem_count, problems: (j.problems || []).slice(0, 20), facts: j.facts };
}

function score(name, input, output, pair) {
  const p = spawnSync(PYTHON, ['-I', path.join(TOOLS, 'score_cached.py'), scoresDir, name, input, output, '--pair', pair],
    { encoding: 'utf8', maxBuffer: 256 << 20 });
  if (p.status !== 0) die(`scoring ${name} failed: ${(p.stderr || '').slice(-600)}`);
  const { record } = JSON.parse(p.stdout);
  if (record.fatal || !record.adopted) die(`scoring ${name}: a fatal record: ${JSON.stringify(record).slice(0, 300)}`);
  return record;
}

// fontTools' instance of a fixture at `at` (judge_instance's own reference: CFF2 downgraded, no overlap flags).
function fontToolsInstance(fixture, at, file) {
  const pairs = at.split(',').map((p) => p.split('=')).map(([k, v]) => [k, Number(v)]);
  const loc = JSON.stringify(Object.fromEntries(pairs));
  const code = 'import json, sys; sys.path.insert(0, sys.argv[1]); from judge_instance import reference; '
    + 'open(sys.argv[4], "wb").write(reference(open(sys.argv[2], "rb").read(), json.loads(sys.argv[3])))';
  const p = spawnSync(PYTHON, ['-I', '-c', code, TOOLS, fx(fixture), loc, file], { encoding: 'utf8' });
  if (p.status !== 0) die(`fontTools' instance of ${fixture} at ${at} failed: ${(p.stderr || '').slice(-400)}`);
  return fs.readFileSync(file);
}

const tmp = (name, bytes) => { const f = path.join(scratch, name); fs.writeFileSync(f, bytes); return f; };

// A TrueType instance as a route's scorer reads it: only its overlap bits cleared, by judge_instance's own
// without_overlap_bits. FreeType supersamples flagged glyphs, so the flagged instance's rasters differ from FontForge's
// unflagged output by anti-aliasing alone; the flags themselves are judged by judge_instance (P3b, 2026-11-19).
function withoutOverlapBits(file) {
  const out = file.replace(/(\.[a-z]+)$/, '-noflags$1');
  const code = 'import sys; sys.path.insert(0, sys.argv[1]); from judge_instance import without_overlap_bits; '
    + 'open(sys.argv[3], "wb").write(without_overlap_bits(open(sys.argv[2], "rb").read()))';
  const p = spawnSync(PYTHON, ['-I', '-c', code, TOOLS, file, out], { encoding: 'utf8' });
  if (p.status !== 0) die(`clearing the overlap bits of ${file} failed: ${(p.stderr || '').slice(-400)}`);
  return out;
}
const outputs = {};
const violations = [];

async function instance(fixture, at, opts) {
  const r = await eng.run(['instance', ...opts, '--at', at, inp('f'), OUT], { inputs: { f: fs.readFileSync(fx(fixture)) } });
  if (r.code !== 0) die(`instance of ${fixture} at ${at}: exit ${r.code} ${r.stderr.slice(-1)}`);
  return r;
}

for (const [fixture, at, opts, named] of INSTANCES.filter((s) => keep(s[0]))) {
  const key = `${fixture}#instance:${specKey(at, opts)}`;
  if (outputs[key]) continue;
  const r = await instance(fixture, at, opts);
  const ext = r.json.flavor === 'cff' ? 'otf' : 'ttf';
  const file = put(r.out, path.join(outputsDir, fixture, `instance-${specKey(at, opts)}.${ext}`));
  const args = [fx(fixture), path.join(outRoot, file.path), '--at', at];
  if (named) {
    const [, , , names, fsSel, mac] = named;
    const want = { names: Object.fromEntries(Object.entries(names).map(([k, v]) => [String(k), v])), fsSelection: fsSel, macStyle: mac };
    args.push('--expect', tmp(`${specKey(at, opts)}-expect.json`, JSON.stringify(want)));
  }
  const j = judge('judge_instance.py', args);
  if (j.verdict !== 'pass') violations.push(`${key}: judge_instance ${j.verdict}: ${j.problems.slice(0, 3).join('; ')}`);
  outputs[key] = { argv: ['instance', ...opts, '--at', at], result: r.json, file, judge_instance: j };
  console.log(`${key}: ${file.size} bytes, judge_instance ${j.verdict}`);
}

for (const [fixture, at, opts, targets] of ROUTES.filter((s) => keep(s[0]))) {
  const r = await instance(fixture, at, opts);
  const inExt = r.json.flavor === 'cff' ? 'otf' : 'ttf';
  const instPath = tmp(`route-in.${inExt}`, r.out);
  const scoredIn = inExt === 'ttf' ? withoutOverlapBits(instPath) : instPath;
  for (const to of targets) {
    const key = `${fixture}#route:${specKey(at, opts)}:${to}`;
    const ff = await fontforge(r.out, `input.${inExt}`, to, { route: true }); // the app's argv: no colour here
    const file = put(ff.font, path.join(outputsDir, fixture, `route-${specKey(at, opts)}.${to}`));
    const out = path.join(outRoot, file.path);
    const scoreName = key.replace(/[^A-Za-z0-9._-]+/g, '_');
    const svg = to === 'svg';
    // Against the instance: coverage, advances, layout, sanitizer; the outline verdicts recorded, not gated.
    const rec = score(scoreName, scoredIn, out, `${inExt}-${to}`);
    const verdicts = rec.adopted.verdicts;
    const cm = rec.checks.cmap || {};
    const ink = (rec.checks.outline || {}).info_ink_box_over_1px;
    const entry = { argv: ['convert', `input.${inExt}`, `output.${to}`], instance_sha256: sha256(r.out), file, verdicts,
      scored_against: inExt === 'ttf' ? 'the instance without its overlap bits' : 'the instance',
      coverage: { missing: cm.missing_codepoints || [], advance_mismatch: cm.n_advance_mismatch, ink_box_over_1px: ink } };
    const gated = ['parses', 'metrics'].concat(svg ? [] : ['layout', 'sanitizer']);
    const bad = Object.entries(verdicts).filter(([k, v]) => v === 'error' || (v === 'fail' && gated.includes(k)));
    if (bad.length) violations.push(`${key}: scorer ${bad.map(([k, v]) => `${k} ${v}`).join(', ')}`);
    const missing = (cm.missing_codepoints || []).map((u) => parseInt(String(u).replace('U+', ''), 16));
    // svg: FontForge's SVG writer gives U+FB00 to U+FB06 by their components, and an SVG font cannot hold a code point
    // XML 1.0 cannot carry (C0 controls but tab, LF, CR; U+FFFE, U+FFFF): ffconv's oracle shows both on static fonts.
    const xmlCannot = (u) => (u < 0x20 && u !== 0x9 && u !== 0xa && u !== 0xd) || u === 0xfffe || u === 0xffff;
    const lost = missing.filter((u) => !(svg && ((u >= 0xfb00 && u <= 0xfb06) || xmlCannot(u))));
    if (lost.length || cm.n_advance_mismatch !== 0 || ink !== 0) {
      violations.push(`${key}: code points missing ` + lost.map((u) => 'U+' + u.toString(16)).join(' ') +
        `; ${cm.n_advance_mismatch} advances differ; ${ink} ink boxes over 1 px`);
    }
    // Against the control: geometry and, for sfnt, the cmap.
    const ctlIn = fontToolsInstance(fixture, at, path.join(scratch, `control-in.${inExt}`));
    const ctl = await fontforge(ctlIn, `input.${inExt}`, to, { route: true });
    const ctlFile = tmp(`control.${to}`, ctl.font);
    const vsControl = score(`${scoreName}_control`, ctlFile, out, `${to}-${to}`).adopted.verdicts;
    entry.control = { what: "fontTools' instance through the same ffconv", sha256: sha256(ctl.font), verdicts: vsControl };
    const off = ['parses', 'outline', 'metrics'].concat(svg ? [] : ['cmap']).filter((k) => vsControl[k] !== 'pass');
    if (off.length) violations.push(`${key}: against the control ` + off.map((k) => k + ' ' + vsControl[k]).join(', '));
    if (to !== 'svg') {
      entry.judge_layout = judge('judge_layout.py', [instPath, out]);
      if (entry.judge_layout.verdict !== 'pass') {
        violations.push(`${key}: judge_layout ${entry.judge_layout.verdict}: ${entry.judge_layout.problems.slice(0, 3).join('; ')}`);
      }
      const lost = NAME_IDS.filter((n) => nameText(ff.font, n) !== nameText(r.out, n));
      entry.names_after_fontforge = lost.length ? Object.fromEntries(lost.map((n) => [n, [nameText(r.out, n), nameText(ff.font, n)]])) : 'equal';
      if (lost.length) violations.push(`${key}: FontForge changed nameIDs ${lost.join(', ')}`);
    }
    outputs[key] = entry;
    console.log(`${key}: ${file.size} bytes, scorer ${Object.entries(verdicts).map(([k, v]) => `${k} ${v}`).join(' ')}` +
      `${entry.judge_layout ? `, judge_layout ${entry.judge_layout.verdict}` : ''}`);
  }
}

for (const [fixture, inName, to, inst] of TRANSPLANTS.filter((s) => keep(s[0]))) {
  const key = `${fixture}#transplant${inst ? `:${specKey(inst[0], inst[1])}` : ''}:${to}`;
  const src = inst ? (await instance(fixture, inst[0], inst[1])).out : fs.readFileSync(fx(fixture));
  const ff = await fontforge(src, inName, to);
  const r = await eng.run(['transplant', inp('s'), inp('o'), inp('m'), OUT], { inputs: { s: src, o: ff.font, m: ff.map } });
  if (r.code !== 0) die(`${key}: exit ${r.code} ${r.stderr.slice(-1)}`);
  const stem = path.join(outputsDir, fixture, `transplant${inst ? `-${specKey(inst[0], inst[1])}` : ''}`);
  const entry = { src_sha256: sha256(src), fontforge: put(ff.font, `${stem}.fontforge.${to}`),
    map: put(ff.map, `${stem}.map.json`), file: put(r.out, `${stem}.${to}`), result: r.json };
  entry.judge_colour = judge('judge_colour.py', [tmp('t-src', src), path.join(outRoot, entry.file.path), '--map',
    path.join(outRoot, entry.map.path)]);
  if (entry.judge_colour.verdict !== 'pass') {
    violations.push(`${key}: judge_colour ${entry.judge_colour.verdict}: ${entry.judge_colour.problems.slice(0, 3).join('; ')}`);
  }
  outputs[key] = entry;
  console.log(`${key}: ${entry.file.size} bytes, judge_colour ${entry.judge_colour.verdict}`);
}

if (violations.length) {
  console.log(violations.join('\n'));
  die(`${violations.length} gate violation(s); no oracle written`);
}
const commit = git(WASM_REPO, 'rev-parse', 'HEAD') + (wasmDirty ? ' (dirty)' : '');
const toolsCommit = git(WEB_REPO, 'rev-parse', 'HEAD') + (toolsDirty ? ' (dirty)' : '');
const oracle = { schema: 1, engine: 'hbfont', definitions: 'P3b-2026-11-18-R8',
  generator: { script: 'harfbuzz-wasm/test/make-oracle.mjs', commit, engine: engineSha, ffconv: ffconvSha,
    tools_commit: toolsCommit, node: process.version.slice(1) },
  outputs: Object.fromEntries(Object.keys(outputs).sort().map((k) => [k, outputs[k]])) };
if (filter) oracle.partial = true;
if (!authoritative) oracle.scratch = true;
const provenance = path.join(outRoot, outputsDir, 'PROVENANCE.md');
if (!fs.existsSync(provenance)) {
  fs.mkdirSync(path.dirname(provenance), { recursive: true });
  fs.writeFileSync(provenance, `# ${outputsDir}/: outputs of one hbfont build\n\nWritten by ` +
    `\`harfbuzz-wasm/test/make-oracle.mjs\` at wasm repo commit \`${commit}\` from \`harfbuzz-wasm/output/hbfont.js\` ` +
    `(sha256 \`${engineSha.js}\`) and \`hbfont.wasm\` (sha256 \`${engineSha.wasm}\`), with ffconv \`${ffconvSha.wasm}\` ` +
    'for routes and transplants. `hbfont-oracle.json` at the fixture root lists them. Never edited or deleted.\n', { flag: 'wx' });
}
const target = path.join(outRoot, ORACLE);
let dest = target;
if (fs.existsSync(target)) {
  dest = nextOracle;
  const old = JSON.parse(fs.readFileSync(target, 'utf8')).outputs;
  const changed = Object.keys(oracle.outputs).filter((k) => !old[k] || JSON.stringify(old[k]) !== JSON.stringify(oracle.outputs[k]));
  console.log(`outputs: ${changed.length} added or changed, ${Object.keys(old).filter((k) => !oracle.outputs[k]).length} removed`);
}
fs.writeFileSync(dest, JSON.stringify(oracle, null, 1) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ oracle: dest, entries: Object.keys(outputs).length, ...counts, partial: Boolean(filter),
  scratch: !authoritative }));
