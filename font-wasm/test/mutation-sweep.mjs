#!/usr/bin/env node
// mutation-sweep.mjs -- seeded mutants through the native ASan/UBSan build (P1 plan, section 3.6): a node port of spike
// S2's fuzz_native.py recipe. A memory-error and contract detector, not a correctness oracle (same code).
//
//   node font-wasm/test/mutation-sweep.mjs font-wasm/build/native/fontwrap-asan [--count=1500] [--seed=20261117]
//                                         [--only=<command>]
//
// Per (command, input) pair a generator seeded by "<seed>:<command>:<input>" makes mutants: 1 to 4 bytes changed
// (a bit flipped or a random byte), with 20 % chance a 32-bit field in the first 512 bytes set to a boundary value,
// with 10 % chance the file cut short. A finding: a sanitizer report, a signal or an exit code other than 0, 1 or 2,
// a timeout, exit 2 (the command line is always valid), exit 0 without an output (except info), an output left after
// a failure, a failure without exactly one "fontwrap: error:" line. Assert refusals are counted, not findings.
// Findings are saved in the run's scratch folder under os.tmpdir(). Final line: FONTWRAP-SWEEP-OK <runs> runs,
// 0 findings | FONTWRAP-SWEEP-FINDINGS.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FIXTURES = process.env.FONT_FIXTURES;
if (!FIXTURES) throw new Error('Set FONT_FIXTURES to the font fixture corpus');
const TIMEOUT_MS = 60000; // per run
const BOUNDARY = [0, 1, 0x7fffffff, 0x80000000, 0xffffffff, 0xfffffff0, 0x00010000, 0xffff];
const MAX_SAVED_PER_KIND = 3;

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : dflt;
};
const binary = args.find((a) => !a.startsWith('--'));
const COUNT = Number(opt('count', '1500'));
const SEED = Number(opt('seed', '20261117'));
const ONLY = opt('only', null);

if (!binary || !fs.existsSync(binary)) {
  console.log(`FONTWRAP-SWEEP-FINDINGS 0 runs: the native binary ${binary || '(none given)'} does not exist; build it with font-wasm/build-native.sh`);
  process.exit(1);
}

function rng(key) {
  let a = createHash('sha256').update(key).digest().readUInt32BE(0);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mutate(data, r) {
  const b = Buffer.from(data);
  const changes = 1 + Math.floor(r() * 4);
  for (let i = 0; i < changes; i++) {
    const at = Math.floor(r() * b.length);
    if (r() < 0.5) b[at] ^= 1 << Math.floor(r() * 8);
    else b[at] = Math.floor(r() * 256);
  }
  if (r() < 0.2 && b.length >= 8) {
    const at = Math.floor(r() * (Math.min(512, b.length) - 3));
    const v = BOUNDARY[Math.floor(r() * BOUNDARY.length)];
    if (r() < 0.5) b.writeUInt32LE(v >>> 0, at);
    else b.writeUInt32BE(v >>> 0, at);
  }
  if (r() < 0.1 && b.length > 1) return b.subarray(0, 1 + Math.floor(r() * (b.length - 1)));
  return b;
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fontwrap-sweep-'));
fs.mkdirSync(path.join(work, 'findings'));
const outPath = path.join(work, 'out.bin');
const env = { ...process.env, ASAN_OPTIONS: 'exitcode=99:detect_leaks=0:allocator_may_return_null=1:abort_on_error=0',
  UBSAN_OPTIONS: 'halt_on_error=1:print_stacktrace=1' };

function run(argv) {
  const p = spawnSync(binary, argv, { env, timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
  return { status: p.status, signal: p.signal, timedOut: p.error && p.error.code === 'ETIMEDOUT',
    stdout: (p.stdout || '').toString(), stderr: (p.stderr || '').toString() };
}

// Base files are made by the binary itself (as S2's were).
function base(cmdArgs, input, name) {
  const inPath = path.join(work, `base-in-${name}`);
  fs.writeFileSync(inPath, input);
  const dest = path.join(work, `base-${name}`);
  const r = run([...cmdArgs, inPath, dest]);
  if (r.status !== 0) throw new Error(`could not make the base ${name}: ${r.stderr}`);
  return fs.readFileSync(dest);
}

const pairs = [];
for (const [font, scale, cff] of [['samples/slick.ttf', 1, false], ['samples/slick.otf', 1, true],
  ['samples/OpenSans-Regular.ttf', 4, false]]) {
  const raw = fs.readFileSync(path.join(FIXTURES, font));
  const stem = path.basename(font);
  pairs.push(['woff-decode', [], base(['woff-encode'], raw, `${stem}.woff`), `${stem}.woff`, Math.floor(COUNT / scale)]);
  pairs.push(['woff2-decode', [], base(['woff2-encode'], raw, `${stem}.woff2`), `${stem}.woff2`, Math.floor(COUNT / scale)]);
  pairs.push(['eot-decode', [], base(['eot-encode', ...(cff ? ['--allow-cff'] : [])], raw, `${stem}.eot`), `${stem}.eot`,
    Math.floor(COUNT / scale)]);
  for (const cmd of ['woff-encode', 'woff2-encode', 'eot-encode', 'info']) {
    pairs.push([cmd, cmd === 'eot-encode' && cff ? ['--allow-cff'] : [], raw, stem, Math.floor(COUNT / (scale * 2))]);
  }
}
for (const [stem, share] of [['slick', 1], ['fontConverter', 2], ['OpenSans-Regular', 2], ['OpenSans-VF', 2]]) {
  const id = `generated/eot/${stem}.mtx.eot`;
  pairs.push(['eot-decode', [], fs.readFileSync(path.join(FIXTURES, id)), `mtx:${stem}`, Math.floor(COUNT / share)]);
}

let runs = 0;
let asserts = 0;
const findings = {};
const saved = {};
for (const [cmd, extra, data, key, count] of pairs) {
  if (ONLY && cmd !== ONLY) continue;
  const r = rng(`${SEED}:${cmd}:${key}`);
  const inPath = path.join(work, 'mutant.bin');
  let accepted = 0;
  for (let k = 0; k < count; k++) {
    const m = mutate(data, r);
    fs.writeFileSync(inPath, m);
    const argv = cmd === 'info' ? ['info', inPath] : [cmd, ...extra, inPath, outPath];
    const p = run(argv);
    runs++;
    const outExists = cmd !== 'info' && fs.existsSync(outPath);
    const errLines = p.stderr.split('\n').filter((l) => /^fontwrap: (error|usage error): /.test(l));
    let kind = null;
    if (p.timedOut) kind = 'timeout';
    else if (/AddressSanitizer/.test(p.stderr)) kind = 'asan';
    else if (/runtime error:|UndefinedBehaviorSanitizer/.test(p.stderr)) kind = 'ubsan';
    else if (p.status === 2) kind = 'usage-error-on-a-valid-command-line'; // argv never changes, only the bytes
    else if (p.status === 0 && cmd !== 'info' && !outExists) kind = 'exit-0-without-output';
    else if ((p.status === 1 || p.status === 2) && outExists) kind = 'output-left-after-failure';
    else if ((p.status === 1 || p.status === 2) && errLines.length !== 1) kind = 'failure-without-one-error-line';
    else if (p.status !== 0 && p.status !== 1 && p.status !== 2) kind = `signal-or-odd-exit(${p.status}/${p.signal})`;
    if (p.status === 1 && /consistency check failed/.test(p.stderr)) asserts++;
    if (p.status === 0) accepted++;
    if (kind) {
      findings[kind] = (findings[kind] || 0) + 1;
      saved[kind] = saved[kind] || 0;
      if (saved[kind] < MAX_SAVED_PER_KIND) {
        saved[kind]++;
        const stem = path.join(work, 'findings', `${kind.replace(/[^a-z0-9-]/gi, '_')}-${saved[kind]}`);
        fs.writeFileSync(`${stem}.bin`, m);
        fs.writeFileSync(`${stem}.stderr.txt`, `${argv.join(' ')}\n${p.stderr}`);
      }
    }
  }
  console.log(`${cmd} <- ${key}: ${count} mutants, ${accepted} accepted`);
}
const total = Object.values(findings).reduce((a, b) => a + b, 0);
console.log(`assert refusals (counted, not findings): ${asserts}`);
if (total === 0) {
  console.log(`FONTWRAP-SWEEP-OK ${runs} runs, 0 findings`);
} else {
  console.log(`findings: ${JSON.stringify(findings)} (saved in ${path.join(work, 'findings')})`);
  console.log(`FONTWRAP-SWEEP-FINDINGS ${runs} runs, ${total} findings`);
  process.exitCode = 1;
}
