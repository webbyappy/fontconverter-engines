'use strict';
// N11: the glue and the hooks (P1 plan, section 4): checked in node, never with grep (the glue is one long line).

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fx, readFixture } = require('../lib/fixtures');
const { IN, OUT } = require('../lib/engine');
const { describe, success } = require('../lib/checks');

const EMSDK = process.env.EMSDK;
if (!EMSDK) throw new Error('Set EMSDK to the emsdk checkout with Emscripten 6.0.2');
const WASM_OPT = path.join(EMSDK, 'upstream', 'bin', 'wasm-opt');
const FORBIDDEN = ['toResizableBuffer', '_malloc(arg.length', 'currentSafariVersion', 'Asyncify'];
const INITIAL_HEAP = 64 * 1024 * 1024; // bytes
const PINS = { brotli: '1.2.1', woff2: '7b67e12', libeot: '0.0.3', zlib: '1.3.2' };
const COMMANDS = ['info', 'woff-encode', 'woff-decode', 'woff2-encode', 'woff2-decode', 'eot-encode', 'eot-decode',
  'version'];

function wasmOpt(args) {
  return childProcess.spawnSync(WASM_OPT, args, { encoding: 'utf8' });
}

async function staticChecks(ctx) {
  const glue = fs.readFileSync(ctx.eng.gluePath, 'latin1');
  const wasm = fs.readFileSync(ctx.eng.wasmPath);
  const found = FORBIDDEN.filter((s) => glue.includes(s));
  ctx.rep.check('the glue has no growable buffer, str.length malloc, Safari gate or Asyncify', found.length === 0, found.join(', '));
  ctx.rep.check('no absolute local path in the glue or the wasm', !glue.includes('/Users/') && wasm.indexOf('/Users/') < 0);
  const ok = wasmOpt(['--all-features', '--disable-simd', '--disable-relaxed-simd', '--disable-threads',
    '--disable-memory64', ctx.eng.wasmPath, '-o', os.devNull]);
  const control = wasmOpt(['--mvp-features', ctx.eng.wasmPath, '-o', os.devNull]);
  ctx.rep.check('the wasm validates without SIMD, threads or memory64 (and fails as plain MVP, the control)',
    ok.status === 0 && control.status !== 0, `status ${ok.status} / control ${control.status}: ${ok.stderr.slice(0, 200)}`);
  const { M } = await ctx.eng.instance();
  ctx.rep.check('FS, WORKERFS and NODEFS are live objects', ['FS', 'WORKERFS', 'NODEFS'].every((k) => typeof M[k] === 'object'));
}

async function exceptions(ctx) {
  const inst = await ctx.eng.instance();
  let thrown = null;
  try { inst.M.callMain(['selftest-throw']); } catch (e) { thrown = e; }
  process.exitCode = 0;
  ctx.rep.check('a C++ exception surfaces as C++ Exception [type]: message', thrown instanceof Error &&
    thrown.message === 'C++ Exception [std::runtime_error]: fontwrap selftest exception' &&
    thrown.cppType === 'std::runtime_error', thrown ? `${thrown.message} / ${thrown.cppType}` : 'nothing thrown');
  const before = inst.io.err.some((l) => l.includes('fontwrap: selftest: unterminated'));
  inst.M.flushStderr();
  const after = inst.io.err.some((l) => l.includes('fontwrap: selftest: unterminated'));
  ctx.rep.check('flushStderr delivers an unterminated stderr line', !before && after, `before ${before}, after ${after}`);
  const r = await ctx.eng.run(['woff-encode', IN, OUT], { input: readFixture('samples/slick.ttf'), instance: inst });
  ctx.rep.check('the instance converts correctly after the exception', success(r), describe(r));

  // A JavaScript error raised by the runtime during callMain must reach the caller as the same object. (A throwing
  // print callback is no probe: Emscripten's TTY turns any put_char exception into EIO, so printf just fails. Seen
  // in the glue, P1 results 12.3.) FS.write is what fd_write calls, and fd_write rethrows anything but ErrnoError.
  const probe = new TypeError('FS.write probe');
  const inst2 = await ctx.eng.instance();
  inst2.M.FS.write = () => { throw probe; };
  let got = null;
  try { inst2.M.callMain(['version']); } catch (e) { got = e; }
  process.exitCode = 0;
  ctx.rep.check('a JavaScript error passes through callMain untouched', got === probe, String(got));
}

async function hooksBothBackends(ctx) {
  const inst = ctx.kind === 'wasm' ? await ctx.eng.instance() : null;
  const a = await ctx.eng.run(['selftest-assert'], { instance: inst });
  ctx.rep.check('an assert becomes exit 1 with a corrupt-input message naming selftest_assert.c', !a.threw &&
    a.code === 1 && a.stderr.some((l) => /^fontwrap: error: corrupt input: a consistency check failed .*selftest_assert\.c/.test(l)),
  describe(a));
  if (inst) {
    const r = await ctx.eng.run(['woff-encode', IN, OUT], { input: readFixture('samples/slick.ttf'), instance: inst });
    ctx.rep.check('the instance converts correctly after the assert', success(r), describe(r));
  }
  const v = await ctx.eng.run(['version']);
  ctx.rep.check('version prints one JSON line with the pins', success(v, true) && v.json.command === 'version' &&
    Object.entries(PINS).every(([k, val]) => v.json[k] === val), describe(v));
  const h = await ctx.eng.run(['help']);
  ctx.rep.check('help exits 0 and names every command', !h.threw && h.code === 0 &&
    COMMANDS.every((c) => h.stdout.join('\n').includes(c)), describe(h));
}

async function heapGrowth(ctx) {
  const inst = await ctx.eng.instance();
  const r = await ctx.eng.run(['woff2-encode', '--quality=11', IN, OUT], { input: { path: fx('real/var-ttf/OpenSans-VF.ttf') },
    outName: 'out.woff2', instance: inst });
  const grown = success(r) && inst.M.heapBytes() > INITIAL_HEAP;
  ctx.rep.check('after heap growth HEAPU8.buffer is not resizable', grown && inst.M.HEAPU8.buffer.resizable === false,
    `${describe(r)}; heap ${inst.M.heapBytes()}; resizable ${inst.M.HEAPU8.buffer.resizable}`);
  const i = await ctx.eng.run(['info', IN], { input: readFixture('samples/slick.ttf'),
    inName: 'a-file-name-longer-than-sixteen-bytes.ttf', instance: inst });
  ctx.rep.check('after growth a long path opens and info JSON parses', success(i, true) && i.json.container === 'sfnt', describe(i));
}

module.exports = {
  id: 'N11', title: 'glue guards', needsEngine: true,
  async run(ctx) {
    if (ctx.kind === 'wasm') {
      await staticChecks(ctx);
      await exceptions(ctx);
    } else {
      ctx.rep.notApplicable('glue rows', 'the glue, the guarded callMain and the heap exist only in the wasm build');
    }
    await hooksBothBackends(ctx);
    if (ctx.kind === 'wasm') await heapGrowth(ctx);
  },
};
