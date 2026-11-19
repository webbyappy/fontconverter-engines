'use strict';
// N11: glue and build guards (P2 plan, section 5), checked in node, never with grep (the glue is one long line).

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fx, readFixture } = require('../lib/fixtures');
const { IN, MODULE_DIR, OUT } = require('../lib/engine');
const { describe, success } = require('../lib/checks');
const { table } = require('../lib/sfnt');

const EMSDK = process.env.EMSDK;
if (!EMSDK) throw new Error('Set EMSDK to the emsdk checkout with Emscripten 6.0.2');
const WASM_OPT = path.join(EMSDK, 'upstream', 'bin', 'wasm-opt');
const FORBIDDEN = ['toResizableBuffer', '_malloc(arg.length', 'currentSafariVersion', 'Asyncify', 'child_process'];
const LOCAL_PATHS = ['/Users/', '/private/', '/Volumes/'];
const INITIAL_HEAP = 32 * 1024 * 1024; // bytes (P2-8)
const BUILD_EPOCH = 1672531200; // FontForge's pinned build stamp, 2023-01-01T00:00:00Z (P2-8)
const MAC_EPOCH_OFFSET = 2082844800; // seconds from 1904-01-01 to 1970-01-01 (sfnt LONGDATETIME)
const PINS = { fontforge: '20230101', glib: '2.78.6', pcre2: '10.42', libxml2: '2.13.9', libiconv: '1.17',
  freetype: '2.13.3', zlib: '1.3.2' };
const COMMANDS = ['convert', 'version', 'help'];

async function staticChecks(ctx) {
  const glue = fs.readFileSync(ctx.eng.gluePath, 'latin1');
  const wasm = fs.readFileSync(ctx.eng.wasmPath);
  const found = FORBIDDEN.filter((s) => glue.includes(s));
  ctx.rep.check('the glue has no growable buffer, str.length malloc, Safari gate, Asyncify or child_process',
    found.length === 0, found.join(', '));
  const local = LOCAL_PATHS.filter((p) => glue.includes(p) || wasm.indexOf(p) >= 0);
  ctx.rep.check('no absolute local path in the glue or the wasm', local.length === 0, local.join(', '));
  const ok = childProcess.spawnSync(WASM_OPT, ['--all-features', '--disable-simd', '--disable-relaxed-simd',
    '--disable-threads', '--disable-memory64', ctx.eng.wasmPath, '-o', os.devNull], { encoding: 'utf8' });
  ctx.rep.check('the wasm validates without SIMD, threads or memory64', ok.status === 0, ok.stderr.slice(0, 200));
  const imports = WebAssembly.Module.imports(ctx.eng.compiled).map((i) => i.name);
  // The catch side (__cxa_begin_catch, __cxa_find_matching_catch_*) is the house exception flags, linked into every
  // module; a throw import would mean C++ code that throws, such as FontForge's WOFF2 writer, got in (P2-9).
  ctx.rep.check('no C++ throw is imported (pure C; the WOFF2 writer is out)', !imports.includes('__cxa_throw'),
    imports.filter((n) => /cxa/.test(n)).join(', '));
  const { M } = await ctx.eng.instance();
  ctx.rep.check('FS, WORKERFS, NODEFS and ENV are live objects', ['FS', 'WORKERFS', 'NODEFS', 'ENV']
    .every((k) => typeof M[k] === 'object' && M[k] !== null));
}

async function probes(ctx) {
  // A JavaScript error raised by the runtime during callMain must reach the caller as the same object (P1 results
  // 12.3: FS.write is what fd_write calls, and fd_write rethrows anything but ErrnoError).
  const probe = new TypeError('FS.write probe');
  const inst = await ctx.eng.instance();
  inst.M.FS.write = () => { throw probe; };
  let got = null;
  try { inst.M.callMain(['version']); } catch (e) { got = e; }
  process.exitCode = 0;
  ctx.rep.check('a JavaScript error passes through callMain untouched', got === probe, String(got));
  const s = await ctx.eng.instance();
  let code = null;
  try { code = s.M.callMain(['selftest-stderr']); } catch (e) { code = String(e); }
  process.exitCode = 0;
  const before = s.io.err.some((l) => l.includes('ffconv: selftest: unterminated'));
  s.M.flushStderr();
  const after = s.io.err.some((l) => l.includes('ffconv: selftest: unterminated'));
  ctx.rep.check('flushStderr delivers an unterminated stderr line', code === 0 && !before && after,
    `exit ${code}, before ${before}, after ${after}`);
  const g = await ctx.eng.run(['convert', IN, OUT], { input: { path: fx('real/dejavu/DejaVuSans.ttf') },
    inName: 'a-file-name-longer-than-sixteen-bytes.ttf', outName: 'output.otf' });
  ctx.rep.check('after heap growth HEAPU8.buffer is not resizable', success(g, 'otf').ok && g.heap > INITIAL_HEAP &&
    g.M.HEAPU8.buffer.resizable === false, `${describe(g)}; heap ${g.heap}`);
}

// The build's own record: output/BUILD-INFO.txt for wasm; for the native build, whose GLib (and its PCRE2) is
// Homebrew's and whose patches are FontForge's only, the BUILD-INFO.native.txt next to the binary under test (a
// native build with another patch set is made in a fresh BUILD_DIR, so build/native/ may hold an older one).
function buildInfo(ctx) {
  const p = ctx.kind === 'native' ? path.join(path.dirname(ctx.eng.binary), 'BUILD-INFO.native.txt')
    : path.join(MODULE_DIR, 'output', 'BUILD-INFO.txt');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

function pinsOf(kind, info) {
  if (kind !== 'native') return PINS;
  const own = (k) => ((info.match(new RegExp(`\\b${k}@([\\d.]+)`)) || [])[1]);
  return { ...PINS, glib: own('glib'), pcre2: own('pcre2') };
}

async function bothBackends(ctx) {
  const v = await ctx.eng.run(['version']);
  const info = buildInfo(ctx);
  const pins = pinsOf(ctx.kind, info);
  ctx.rep.check('version prints one JSON line with the pins and patches, as BUILD-INFO.txt', v.code === 0 && v.json &&
    Object.entries(pins).every(([k, val]) => val && v.json[k] === val && info.includes(`${k}@${val}`)) &&
    Array.isArray(v.json.patches) && v.json.patches.every((p) => info.includes(p)), describe(v));
  // P2-25 (owner's decision of 2026-11-18): qsort breaks ties as glibc 2.31's merge sort does, in both builds, so
  // native, wasm and production order equal-keyed records alike; a comparator that answers only 0 or 1 still sorts.
  const q = await ctx.eng.run(['selftest-sort']);
  ctx.rep.check('qsort keeps equal keys in their order and sorts with a 0/1 comparator (glibc merge sort)',
    q.code === 0 && q.json && JSON.stringify(q.json.ties) === JSON.stringify([1, 3, 6, 0, 2, 5, 4]) &&
    JSON.stringify(q.json.boolean) === JSON.stringify([1, 2, 3, 5, 8, 9]), describe(q));
  const h = await ctx.eng.run(['help']);
  ctx.rep.check('help exits 0 and names every command', !h.threw && h.code === 0 &&
    COMMANDS.every((c) => h.stdout.join('\n').includes(c)), describe(h));
  const r = await ctx.eng.run(['convert', IN, OUT], { input: readFixture('samples/slick.ttf'), inName: 'input.ttf',
    outName: 'output.otf' });
  const fftm = r.out && table(r.out, 'FFTM');
  const stamp = fftm && fftm.length >= 12 ? Number(fftm.readBigUInt64BE(4)) - MAC_EPOCH_OFFSET : null;
  ctx.rep.check('FFTM carries the pinned FontForge build date (2023-01-01)', success(r, 'otf').ok &&
    stamp === BUILD_EPOCH, `${describe(r)}; FFTM build stamp ${stamp}`);
}

module.exports = {
  id: 'N11', title: 'glue and build guards', needsEngine: true,
  async run(ctx) {
    if (ctx.kind === 'wasm') {
      await staticChecks(ctx);
      await probes(ctx);
    } else {
      ctx.rep.notApplicable('glue rows', 'the glue, the guarded callMain and the heap exist only in the wasm build');
    }
    await bothBackends(ctx);
    if (ctx.kind === 'native') {
      // fontforge-0005: every row of tottfgpos.c's script table ends in 0; before, the Arabic row filled every slot
      // and ScriptFromUnicode read past it (Vera's legacy kern table is turned into GPOS through that lookup).
      const v = await ctx.eng.run(['convert', IN, OUT], { input: { path: fx('real/vera/Vera.ttf') }, inName: 'input.ttf',
        outName: 'output.otf' });
      const bounds = (v.sanitizer || []).filter((l) => /tottfgpos\.c.*out of bounds/.test(l));
      ctx.rep.check('script detection reads inside its table (no UBSan bounds report)', success(v, 'otf').ok &&
        !bounds.length, bounds.slice(0, 2).join(' | '));
    }
  },
};
