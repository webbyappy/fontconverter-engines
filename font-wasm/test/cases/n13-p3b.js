'use strict';
// N13: fontconverter-web P3b (docs/audits/P3b-VARIABLE-COLOUR-PLAN-2026-11-18.md): the failure line and its ids
// (P3b-7), --max-output-bytes on every decoder (P3b-8), the 1 GiB ceiling and the abort record (P3b-5).

const fs = require('fs');
const { fx, readFixture } = require('../lib/fixtures');
const { IN, OUT } = require('../lib/engine');
const { cleanFailure, describe, success, usageFailure } = require('../lib/checks');

const CEILING_BYTES = 1073741824; // 1 GiB: -sMAXIMUM_MEMORY (P3b-5)
const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MUST_LIST = ['usage', 'output-limit', 'out-of-memory', 'woff-invalid', 'woff2-invalid', 'eot-invalid', 'io'];

async function errorIds(ctx) {
  const r = await ctx.eng.run(['error-ids']);
  const ids = r.json && Array.isArray(r.json.ids) ? r.json.ids : [];
  ctx.rep.check('error-ids prints {"ok":true,"v":1,"ids":[...]} as its one line, ids unique and kebab-case',
    success(r, true) && r.json.v === 1 && ids.length > 0 && new Set(ids).size === ids.length &&
    ids.every((i) => ID_RE.test(i)) && MUST_LIST.every((i) => ids.includes(i)), describe(r));
}

async function failureLines(ctx) {
  const unknown = await ctx.eng.run(['frobnicate-x7', IN], { input: readFixture('samples/slick.ttf') });
  ctx.rep.check('an unknown command fails with command null and error usage, the argument never echoed',
    usageFailure(unknown) && unknown.json.command === null && !unknown.stdout[0].includes('frobnicate'),
    describe(unknown));
  const bad = await ctx.eng.run(['woff-decode', IN, OUT], { input: Buffer.alloc(256, 7) });
  ctx.rep.check('a failed woff-decode names its command and woff-invalid',
    cleanFailure(bad, null, 'woff-invalid') && bad.json.command === 'woff-decode', describe(bad));
  const opt = await ctx.eng.run(['woff-encode', '--max-output-bytes=100', IN, OUT],
    { input: readFixture('samples/slick.ttf') });
  ctx.rep.check('--max-output-bytes is a usage error on an encoder', usageFailure(opt) &&
    opt.json.command === 'woff-encode', describe(opt));
  for (const v of ['0', '-5', 'x', '536870913']) {
    const r = await ctx.eng.run(['woff2-decode', `--max-output-bytes=${v}`, IN, OUT],
      { input: readFixture('samples/slick.ttf') });
    ctx.rep.check(`--max-output-bytes=${v} is a usage error`, usageFailure(r), describe(r));
  }
}

// Each decoder: the limit equal to what it needs succeeds; one byte less is refused with output-limit, no output.
async function bounded(ctx) {
  const slick = readFixture('samples/slick.ttf');
  const woff = await ctx.eng.run(['woff-encode', IN, OUT], { input: slick });
  const woff2 = await ctx.eng.run(['woff2-encode', IN, OUT], { input: slick });
  const inputs = [
    ['woff-decode', woff.out, (buf) => buf.readUInt32BE(16)],                                 // totalSfntSize
    ['woff2-decode', woff2.out, (buf, size) => Math.max(size, buf.readUInt32BE(16))],         // the declared total
    ['eot-decode', readFixture('generated/eot/slick.plain.eot'), (_buf, size) => size],
    ['eot-decode', readFixture('generated/eot/slick.xor.eot'), (_buf, size) => size],
    ['eot-decode', readFixture('generated/eot/slick.mtx.eot'), (_buf, size) => size],
  ];
  for (const [cmd, buf, needed] of inputs) {
    const label = `${cmd} ${buf.length} bytes`;
    const free = await ctx.eng.run([cmd, IN, OUT], { input: buf });
    if (!ctx.rep.check(`${label}: decodes without a limit`, success(free), describe(free))) continue;
    const n = needed(buf, free.out.length);
    const ok = await ctx.eng.run([cmd, `--max-output-bytes=${n}`, IN, OUT], { input: buf });
    ctx.rep.check(`${label}: --max-output-bytes=${n} decodes the same bytes`, success(ok) && ok.out.equals(free.out),
      describe(ok));
    const no = await ctx.eng.run([cmd, `--max-output-bytes=${n - 1}`, IN, OUT], { input: buf, stale: Buffer.from('x') });
    ctx.rep.check(`${label}: --max-output-bytes=${n - 1} is refused as output-limit, nothing written`,
      cleanFailure(no, null, 'output-limit'), describe(no));
  }
}

async function memory(ctx) {
  if (ctx.kind !== 'wasm') {
    const r = await ctx.eng.run(['selftest-oom']);
    ctx.rep.check('selftest-oom refuses natively (no ceiling to reach)', usageFailure(r), describe(r));
    ctx.rep.notApplicable('the glue\'s ceiling', 'native binaries have no wasm memory');
    return;
  }
  const glue = fs.readFileSync(ctx.eng.gluePath, 'latin1');
  ctx.rep.check('the glue caps memory at 1 GiB and aborts when it cannot grow (ABORTING_MALLOC)',
    glue.includes(String(CEILING_BYTES)) && !glue.includes('2147483648') && glue.includes('abortOnCannotGrowMemory'),
    'looked for 1073741824 and abortOnCannotGrowMemory in the glue, and for no 2147483648');
  const inst = await ctx.eng.instance();
  const r = await ctx.eng.run(['selftest-oom'], { instance: inst });
  const heap = inst.M.heapBytes();
  ctx.rep.check('selftest-oom aborts as out of memory at the ceiling: lastAbort() is "oom"',
    r.threw !== null && typeof inst.M.lastAbort === 'function' && inst.M.lastAbort() === 'oom' &&
    heap <= CEILING_BYTES && heap > CEILING_BYTES - 64 * 1048576, `${describe(r)}; heap ${heap}`);
  const next = await ctx.eng.run(['woff2-encode', IN, OUT], { input: readFixture('samples/slick.ttf') });
  ctx.rep.check('a fresh instance after the abort converts', success(next), describe(next));
  const clean = await ctx.eng.instance();
  await ctx.eng.run(['version'], { instance: clean });
  ctx.rep.check('lastAbort() is null on an instance that never aborted',
    typeof clean.M.lastAbort === 'function' && clean.M.lastAbort() === null, String(clean.M.lastAbort && clean.M.lastAbort()));
  void fx;
}

module.exports = {
  id: 'N13', title: 'P3b: failure ids, bounded decodes, the memory ceiling', needsEngine: true,
  async run(ctx) {
    await errorIds(ctx);
    await failureLines(ctx);
    await bounded(ctx);
    await memory(ctx);
  },
};
