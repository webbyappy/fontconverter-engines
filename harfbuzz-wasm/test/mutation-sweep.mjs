#!/usr/bin/env node
// mutation-sweep.mjs -- seeded mutants of variable and colour fonts through hbfont's info, instance and transplant on
// the native ASan/UBSan build (fontconverter-web P3b plan, section 4.1). Each mutant changes 1 to 4 random bytes, or
// sets a 32-bit field to a boundary value, inside the tables hbfont's own code reads (fvar, STAT, name, OS/2, head,
// CFF, COLR, CPAL, SVG, sbix, CBLC, CBDT, cmap, hmtx and the directory), with a 10 % chance of a cut file. A finding:
// a sanitizer report, a signal, an exit code other than 0 or 1, a timeout, exit 0 without exactly one JSON line,
// exit 1 without exactly one "hbfont: error:" line (the last on stderr) and the failure line as the only stdout line.
// Transplant mutants damage the colour source; FontForge's output and the map come from the unmutated source (the
// committed ffconv). Findings are saved under os.tmpdir(); nothing is deleted. Final line:
// HBFONT-SWEEP-OK <runs> runs, 0 findings | HBFONT-SWEEP-FINDINGS <runs> runs, <n> findings.
//
//   node harfbuzz-wasm/test/mutation-sweep.mjs <native binary> [--count=<per base>] [--seed=<n>]

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { fontforge } = require('./lib/ffconv');
const { readSfnt } = require('./lib/sfnt');

const FIXTURES = process.env.FONT_FIXTURES;
if (!FIXTURES) throw new Error('Set FONT_FIXTURES to the font fixture corpus');
const TIMEOUT_MS = 120000;
const BOUNDARY = [0, 1, 0x7fffffff, 0x80000000, 0xffffffff, 0xfffffff0, 0x00010000, 0xffff];
const TAGS = ['fvar', 'STAT', 'name', 'OS/2', 'head', 'CFF ', 'CFF2', 'COLR', 'CPAL', 'SVG ', 'sbix', 'CBLC', 'CBDT',
  'cmap', 'hmtx', 'hhea', 'maxp'];
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : dflt;
};
const binary = args.find((a) => !a.startsWith('--'));
const COUNT = Number(opt('count', '600'));
const SEED = Number(opt('seed', '20261119'));
if (!binary || !fs.existsSync(binary)) {
  console.log(`HBFONT-SWEEP-FINDINGS 0 runs: no native binary ${binary || '(none given)'}; build it with harfbuzz-wasm/build-native.sh`);
  process.exit(1);
}

// [label, fixture, op, extra argv]; transplant bases name FontForge's target.
const BASES = [
  ['info OpenSans-VF', 'real/var-ttf/OpenSans-VF.ttf', 'info', []],
  ['instance OpenSans-VF', 'real/var-ttf/OpenSans-VF.ttf', 'instance', ['--at', 'wght=600,wdth=87.5']],
  ['instance SourceSans3VF otf', 'real/sourcesans-vf/SourceSans3VF-Upright.otf', 'instance',
    ['--downgrade-cff2', '--at', 'wght=650']],
  ['instance Nabla', 'real/var-colr/Nabla[EDPT,EHLT].ttf', 'instance', ['--at', 'EDPT=200,EHLT=24']],
  ['transplant Twemoji-cid', 'generated/colour/Twemoji-cid.otf', 'transplant', ['ttf', 'input.otf']],
  ['transplant slick-svg-multi', 'generated/colour/slick-svg-multi.ttf', 'transplant', ['otf', 'input.ttf']],
  ['transplant slick-colr-svg-cpal', 'generated/colour/slick-colr-svg-cpal.ttf', 'transplant', ['otf', 'input.ttf']],
  ['transplant slick-sbix', 'generated/special/slick-sbix.ttf', 'transplant', ['otf', 'input.ttf']],
  ['transplant slick-cbdt', 'generated/colour/slick-cbdt.ttf', 'transplant', ['otf', 'input.ttf']],
];

function rng(key) {
  let s = (SEED ^ [...key].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)) >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

function regions(font) {
  const tables = readSfnt(font).tables.filter((t) => TAGS.includes(t.tag) && t.length > 0);
  return [{ offset: 0, length: Math.min(12 + 16 * readSfnt(font).tables.length, font.length) },
    ...tables.map((t) => ({ offset: t.offset, length: t.length }))];
}

function mutate(font, r) {
  const b = Buffer.from(font);
  const reg = regions(font);
  const at = () => {
    const g = reg[Math.floor(r() * reg.length)];
    return g.offset + Math.floor(r() * g.length);
  };
  if (r() < 0.5) {
    const n = 1 + Math.floor(r() * 4);
    for (let i = 0; i < n; i++) b[at()] = Math.floor(r() * 256);
  } else {
    const p = Math.min(at(), b.length - 4);
    b.writeUInt32BE(BOUNDARY[Math.floor(r() * BOUNDARY.length)] >>> 0, p);
  }
  return r() < 0.1 ? b.subarray(0, Math.floor(r() * b.length)) : b;
}

function classify(p) {
  const out = (p.stdout || '').toString().split('\n').filter((l) => l.length > 0);
  const lines = (p.stderr || '').toString().split('\n').filter((l) => l.length > 0);
  const err = lines.join('\n');
  if (/AddressSanitizer|LeakSanitizer/.test(err)) return 'asan';
  if (/runtime error:|UndefinedBehaviorSanitizer/.test(err)) return 'ubsan';
  if (p.error) return 'timeout-or-spawn';
  if (p.signal) return `signal-${p.signal}`;
  if (p.status === 0) {
    try { JSON.parse(out[0]); } catch (_) { return 'exit-0-without-one-json-line'; }
    return out.length === 1 ? null : 'exit-0-without-one-json-line';
  }
  if (p.status === 1) {
    const mine = lines.filter((l) => l.startsWith('hbfont: error: '));
    let line = null;
    try { line = out.length === 1 ? JSON.parse(out[0]) : null; } catch (_) { line = null; }
    return mine.length === 1 && lines[lines.length - 1] === mine[0] && line && line.ok === false && line.v === 1 &&
      typeof line.error === 'string' ? null : 'failure-without-its-lines';
  }
  return `exit-${p.status}`;
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hbfont-sweep-'));
const env = { ...process.env, ASAN_OPTIONS: 'exitcode=99:detect_leaks=0:allocator_may_return_null=1:abort_on_error=0',
  UBSAN_OPTIONS: 'halt_on_error=1:print_stacktrace=1' };
let runs = 0;
const findings = {};
for (const [label, fixture, op, extra] of BASES) {
  const src = fs.readFileSync(path.join(FIXTURES, fixture));
  let outline = null;
  let map = null;
  if (op === 'transplant') {
    const ff = await fontforge(src, extra[1], extra[0]);
    outline = path.join(work, `${runs}-outline`);
    map = path.join(work, `${runs}-map.json`);
    fs.writeFileSync(outline, ff.font);
    fs.writeFileSync(map, ff.map);
  }
  const r = rng(label);
  for (let i = 0; i < COUNT; i++) {
    const mutant = path.join(work, 'mutant.bin');
    fs.writeFileSync(mutant, mutate(src, r));
    const out = path.join(work, 'out.bin');
    const argv = op === 'info' ? ['info', mutant]
      : op === 'instance' ? ['instance', ...extra, mutant, out] : ['transplant', mutant, outline, map, out];
    const p = spawnSync(binary, argv, { env, timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
    runs++;
    const kind = classify(p);
    if (kind) {
      findings[kind] = (findings[kind] || 0) + 1;
      if (findings[kind] <= 3) {
        const keep = path.join(work, `finding-${kind}-${findings[kind]}.bin`);
        fs.copyFileSync(mutant, keep);
        console.log(`FINDING ${kind} ${label} #${i}: ${keep}\n  ${(p.stderr || '').toString().split('\n').slice(-6).join('\n  ')}`);
      }
    }
  }
  console.log(`${label}: ${COUNT} runs`);
}
const total = Object.values(findings).reduce((a, b) => a + b, 0);
console.log(`findings by kind: ${JSON.stringify(findings)}; scratch: ${work}`);
console.log(total === 0 ? `HBFONT-SWEEP-OK ${runs} runs, 0 findings` : `HBFONT-SWEEP-FINDINGS ${runs} runs, ${total} findings`);
process.exitCode = total === 0 ? 0 : 1;
