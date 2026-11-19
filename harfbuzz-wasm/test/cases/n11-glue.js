'use strict';
// N11: the glue and the build (P3b plan, section 4.1): checked in node, never with grep (the glue is one long line).
// The memory rows (selftest-oom, the ceiling, lastAbort) are N10's.

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, success } = require('../lib/checks');

const EMSDK = process.env.EMSDK;
if (!EMSDK) throw new Error('Set EMSDK to the emsdk checkout with Emscripten 6.0.2');
const WASM_OPT = path.join(EMSDK, 'upstream', 'bin', 'wasm-opt');
const FORBIDDEN = ['toResizableBuffer', '_malloc(arg.length', 'currentSafariVersion', 'Asyncify'];
const VENDOR_SCRIPT = path.resolve(__dirname, '..', '..', 'vendor', 'fetch-vendor.sh');

function wasmOpt(args) {
  return childProcess.spawnSync(WASM_OPT, args, { encoding: 'utf8' });
}

async function staticChecks(ctx) {
  const glue = fs.readFileSync(ctx.eng.gluePath, 'latin1');
  const wasm = fs.readFileSync(ctx.eng.wasmPath);
  const found = FORBIDDEN.filter((s) => glue.includes(s));
  ctx.rep.check('the glue has no growable buffer, str.length malloc, Safari gate or Asyncify', found.length === 0,
    found.join(', '));
  ctx.rep.check('no absolute local path in the glue or the wasm', !glue.includes('/Users/') && wasm.indexOf('/Users/') < 0);
  const ok = wasmOpt(['--all-features', '--disable-simd', '--disable-relaxed-simd', '--disable-threads',
    '--disable-memory64', ctx.eng.wasmPath, '-o', os.devNull]);
  const control = wasmOpt(['--mvp-features', ctx.eng.wasmPath, '-o', os.devNull]);
  ctx.rep.check('the wasm validates without SIMD, threads or memory64 (and fails as plain MVP, the control)',
    ok.status === 0 && control.status !== 0,
    `status ${ok.status} / control ${control.status}: ${ok.stderr.slice(0, 200)}`);
  const { M } = await ctx.eng.instance();
  ctx.rep.check('FS, WORKERFS and NODEFS are live objects', ['FS', 'WORKERFS', 'NODEFS'].every((k) => typeof M[k] === 'object'));
  ctx.rep.check('the factory is HBFont (MODULARIZE, EXPORT_NAME)', /var HBFont\b|function HBFont\b|HBFont\s*=/.test(glue));
}

async function exceptions(ctx) {
  const inst = await ctx.eng.instance();
  let thrown = null;
  try { inst.M.callMain(['selftest-throw']); } catch (e) { thrown = e; }
  process.exitCode = 0;
  ctx.rep.check('a C++ exception surfaces as C++ Exception [type]: message', thrown instanceof Error &&
    thrown.message === 'C++ Exception [std::runtime_error]: hbfont selftest exception' &&
    thrown.cppType === 'std::runtime_error', thrown ? `${thrown.message} / ${thrown.cppType}` : 'nothing thrown');
  const before = inst.io.err.some((l) => l.includes('hbfont: selftest: unterminated'));
  inst.M.flushStderr();
  const after = inst.io.err.some((l) => l.includes('hbfont: selftest: unterminated'));
  ctx.rep.check('flushStderr delivers an unterminated stderr line', !before && after, `before ${before}, after ${after}`);
  const r = await ctx.eng.run(['version'], { instance: inst });
  ctx.rep.check('the instance still runs after the exception', success(r, true), describe(r));
  const probe = new TypeError('FS.write probe');
  const inst2 = await ctx.eng.instance();
  inst2.M.FS.write = () => { throw probe; };
  let got = null;
  try { inst2.M.callMain(['version']); } catch (e) { got = e; }
  process.exitCode = 0;
  ctx.rep.check('a JavaScript error passes through callMain untouched', got === probe, String(got));
}

function vendorPin(ctx) {
  const script = fs.readFileSync(VENDOR_SCRIPT, 'utf8');
  const version = (script.match(/^VERSION=(\S+)$/m) || [])[1];
  const sha = (script.match(/^WANT=([0-9a-f]{64})$/m) || [])[1];
  const info = fs.readFileSync(path.join(path.dirname(ctx.eng.gluePath), 'BUILD-INFO.txt'), 'utf8');
  ctx.rep.check('BUILD-INFO names the vendored release and its sha256', version === '15.0.0' && Boolean(sha) &&
    info.includes(`harfbuzz@${version} (release tarball sha256 ${sha})`), `version ${version}, sha ${sha}`);
  ctx.rep.check('BUILD-INFO links the 1 GiB ceiling with ABORTING_MALLOC', info.includes('-sMAXIMUM_MEMORY=1073741824') &&
    info.includes('-sABORTING_MALLOC=1') && info.includes('-sGROWABLE_ARRAYBUFFERS=0'));
}

module.exports = {
  id: 'N11', title: 'glue and build', needsEngine: true,
  async run(ctx) {
    if (ctx.kind !== 'wasm') {
      ctx.rep.notApplicable('glue rows', 'the glue, the guarded callMain and BUILD-INFO exist only in the wasm build');
      return;
    }
    await staticChecks(ctx);
    await exceptions(ctx);
    vendorPin(ctx);
  },
};
