#!/usr/bin/env node
// sniff-sweep.mjs -- seeded mutants through the native ASan/UBSan build's input check alone (P2 plan, C1; P1's
// font-wasm/test/mutation-sweep.mjs at 840fd65d8, itself spike S2's fuzz_native.py recipe). A memory-error and
// contract detector for src/sniff.c, the code that reads untrusted bytes before FontForge does.
//
//   node fontforge-wasm/test/sniff-sweep.mjs fontforge-wasm/build/native/ffconv-asan [--count=2000] [--seed=20261117]
//
// Per base font (samples/slick.ttf, samples/slick.otf, samples/OpenSans-Regular.ttf) a generator seeded by
// "<seed>:<font>" makes --count mutants: 1 to 4 bytes changed (a bit flipped or a random byte), with 20 % chance a
// 32-bit field in the first 512 bytes set to a boundary value, with 10 % chance the file cut short. Each runs
// `ffconv selftest-sniff <mutant>`. A finding: a sanitizer report, a signal or an exit code other than 0 or 1, a
// timeout, exit 0 without exactly one JSON line on stdout, exit 1 without exactly one "ffconv: error:" line (the last
// on stderr) and the failure line as the only stdout line (an id `ffconv error-ids` lists; fontconverter-web P3b,
// P3b-7). Findings are saved in the run's scratch folder under os.tmpdir(); nothing is deleted. Final line:
// FFCONV-SWEEP-OK <runs> runs, 0 findings | FFCONV-SWEEP-FINDINGS <runs> runs, <n> findings.

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
const BASES = ['samples/slick.ttf', 'samples/slick.otf', 'samples/OpenSans-Regular.ttf'];

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : dflt;
};
const binary = args.find((a) => !a.startsWith('--'));
const COUNT = Number(opt('count', '2000'));
const SEED = Number(opt('seed', '20261117'));

if (!binary || !fs.existsSync(binary)) {
  console.log(`FFCONV-SWEEP-FINDINGS 0 runs: the native binary ${binary || '(none given)'} does not exist; build it with fontforge-wasm/build-native.sh`);
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

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ffconv-sweep-'));
fs.mkdirSync(path.join(work, 'findings'));
const env = { ...process.env, ASAN_OPTIONS: 'exitcode=99:detect_leaks=0:allocator_may_return_null=1:abort_on_error=0',
  UBSAN_OPTIONS: 'halt_on_error=1:print_stacktrace=1' };

// The failure line every exit 1 prints since fontconverter-web P3b (plan, P3b-7), its id from the binary's own list.
const idRun = spawnSync(binary, ['error-ids'], { env: process.env });
const ERROR_IDS = new Set((() => {
  try { return JSON.parse(idRun.stdout.toString()).ids || []; } catch (_) { return []; }
})());
if (ERROR_IDS.size === 0) {
  console.log(`FFCONV-SWEEP-FAIL ${binary} error-ids printed no list`);
  process.exit(1);
}

function failureLine(out) {
  if (out.length !== 1) return false;
  try {
    const j = JSON.parse(out[0]);
    return j.ok === false && j.v === 1 && 'command' in j && ERROR_IDS.has(j.error);
  } catch (_) {
    return false;
  }
}

function classify(p) {
  const out = (p.stdout || '').toString().split('\n').filter((l) => l.length > 0);
  const err = (p.stderr || '').toString();
  const lines = err.split('\n').filter((l) => l.length > 0);
  const ffconv = lines.filter((l) => l.startsWith('ffconv:'));
  if (p.error && p.error.code === 'ETIMEDOUT') return 'timeout';
  if (/AddressSanitizer/.test(err)) return 'asan';
  if (/runtime error:|UndefinedBehaviorSanitizer/.test(err)) return 'ubsan';
  if (p.status === 0) {
    try {
      JSON.parse(out[0]);
    } catch (_) {
      return 'exit-0-without-one-json-line';
    }
    return out.length === 1 && ffconv.length === 0 ? null : 'exit-0-without-one-json-line';
  }
  if (p.status === 1) {
    return ffconv.length === 1 && ffconv[0].startsWith('ffconv: error: ') && lines[lines.length - 1] === ffconv[0] &&
      failureLine(out) ? null : 'failure-without-one-error-line';
  }
  return `signal-or-odd-exit(${p.status}/${p.signal})`;
}

let runs = 0;
const findings = {};
const saved = {};
for (const font of BASES) {
  const data = fs.readFileSync(path.join(FIXTURES, font));
  const r = rng(`${SEED}:${font}`);
  const inPath = path.join(work, 'mutant.bin');
  let accepted = 0;
  for (let k = 0; k < COUNT; k++) {
    const m = mutate(data, r);
    fs.writeFileSync(inPath, m);
    const p = spawnSync(binary, ['selftest-sniff', inPath], { env, timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
    runs++;
    if (p.status === 0) accepted++;
    const kind = classify(p);
    if (kind) {
      findings[kind] = (findings[kind] || 0) + 1;
      saved[kind] = saved[kind] || 0;
      if (saved[kind] < MAX_SAVED_PER_KIND) {
        saved[kind]++;
        const stem = path.join(work, 'findings', `${kind.replace(/[^a-z0-9-]/gi, '_')}-${saved[kind]}`);
        fs.writeFileSync(`${stem}.bin`, m);
        fs.writeFileSync(`${stem}.stderr.txt`, (p.stderr || '').toString());
      }
    }
  }
  console.log(`${font}: ${COUNT} mutants, ${accepted} accepted by the input check`);
}
const total = Object.values(findings).reduce((a, b) => a + b, 0);
console.log(`findings by kind: ${JSON.stringify(findings)}; scratch: ${work}`);
console.log(total === 0 ? `FFCONV-SWEEP-OK ${runs} runs, 0 findings` : `FFCONV-SWEEP-FINDINGS ${runs} runs, ${total} findings`);
process.exit(total === 0 ? 0 : 1);
