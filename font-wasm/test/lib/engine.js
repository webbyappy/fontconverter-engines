'use strict';
// The engine under test, behind one run() (P1 plan, section 3.5):
//   wasm   output/fontwrap.{js,wasm} (or $FONTWRAP_GLUE): compiled once, a fresh instance per case unless the
//          case passes its own; input written to MEMFS /in, output read from MEMFS /out.
//   native $FONTWRAP_ENGINE=native:<binary>: one process per run; input from its host path (or written to a
//          scratch folder under os.tmpdir()), output to a reused path there. The harness deletes nothing.

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const IN = Symbol('input path');
const OUT = Symbol('output path');
// The input path spelled differently (`<dir>/./<name>`): the same file under another string.
const IN_ALIAS = Symbol('input path, another spelling');

function aliasOf(p) {
  return `${path.posix.dirname(p)}/./${path.posix.basename(p)}`;
}
const MODULE_DIR = path.resolve(__dirname, '..', '..');
const DEFAULT_GLUE = path.join(MODULE_DIR, 'output', 'fontwrap.js');
const NATIVE_TIMEOUT_MS = 600000; // 10 minutes: a quality-9 WOFF2 encode of a 20 MB font under ASan

function lines(text) {
  return text.split('\n').filter((l) => l.length > 0);
}

function lastJson(stdout) {
  if (stdout.length !== 1) return null;
  try { return JSON.parse(stdout[0]); } catch (_) { return null; }
}

function inputBytes(input) {
  return Buffer.isBuffer(input) ? input : fs.readFileSync(input.path);
}

class WasmEngine {
  constructor(gluePath) {
    this.kind = 'wasm';
    this.gluePath = path.resolve(gluePath || process.env.FONTWRAP_GLUE || DEFAULT_GLUE);
    this.wasmPath = this.gluePath.replace(/\.js$/, '.wasm');
    this.compiled = null;
  }

  available() {
    return fs.existsSync(this.gluePath) && fs.existsSync(this.wasmPath);
  }

  async init() {
    this.factory = require(this.gluePath);
    this.compiled = await WebAssembly.compile(fs.readFileSync(this.wasmPath));
  }

  // A fresh instance; `overrides` may replace print/printErr (N11's throwing print).
  async instance(overrides = {}) {
    const io = { out: [], err: [] };
    const M = await this.factory({
      print: (s) => io.out.push(s),
      printErr: (s) => io.err.push(s),
      instantiateWasm: (imports, done) => {
        WebAssembly.instantiate(this.compiled, imports).then((inst) => done(inst, this.compiled));
        return {};
      },
      ...overrides,
    });
    M.FS.mkdir('/in');
    M.FS.mkdir('/out');
    return { M, io };
  }

  // args: argv with IN, IN_ALIAS and OUT placeholders. opts: input (Buffer or {path}), inName, outName, stale (Buffer
  // placed at the output path first), instance (reuse one), checkInput (return the input's bytes after the run).
  async run(args, opts = {}) {
    const inst = opts.instance || (await this.instance());
    const { M, io } = inst;
    io.out.length = 0;
    io.err.length = 0;
    const inPath = '/in/' + (opts.inName || 'input.bin');
    const outPath = '/out/' + (opts.outName || 'output.bin');
    if (opts.input != null) M.FS.writeFile(inPath, inputBytes(opts.input));
    if (opts.stale) M.FS.writeFile(outPath, opts.stale);
    const argv = args.map((a) => (a === IN ? inPath : a === IN_ALIAS ? aliasOf(inPath) : a === OUT ? outPath : a));
    let code = null;
    let threw = null;
    try {
      code = M.callMain(argv);
    } catch (e) {
      threw = e;
    }
    process.exitCode = 0;
    if (M.flushStderr) M.flushStderr();
    // Only the path the engine was given counts as its output (info takes none).
    const exists = argv.includes(outPath) && M.FS.analyzePath(outPath).exists;
    const out = exists ? Buffer.from(M.FS.readFile(outPath)) : null;
    if (exists) M.FS.unlink(outPath); // MEMFS only: keeps a reused instance's in-memory file system small
    const stdout = io.out.slice();
    const inAfter = opts.checkInput && M.FS.analyzePath(inPath).exists ? Buffer.from(M.FS.readFile(inPath)) : null;
    return { code, stdout, stderr: io.err.slice(), json: lastJson(stdout), out, outExists: exists, threw,
      heap: M.heapBytes ? M.heapBytes() : null, inPath, outPath, inAfter };
  }
}

class NativeEngine {
  constructor(binary) {
    this.kind = 'native';
    this.binary = path.resolve(binary);
    this.scratch = null;
  }

  available() {
    return fs.existsSync(this.binary);
  }

  async init() {
    this.scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'fontwrap-native-'));
    fs.mkdirSync(path.join(this.scratch, 'in'));
    fs.mkdirSync(path.join(this.scratch, 'out'));
  }

  async run(args, opts = {}) {
    let inPath = path.join(this.scratch, 'in', opts.inName || 'input.bin');
    if (opts.input != null) {
      if (Buffer.isBuffer(opts.input)) fs.writeFileSync(inPath, opts.input);
      else inPath = opts.input.path;
    }
    const outPath = path.join(this.scratch, 'out', opts.outName || 'output.bin');
    if (opts.stale) fs.writeFileSync(outPath, opts.stale);
    const argv = args.map((a) => (a === IN ? inPath : a === IN_ALIAS ? aliasOf(inPath) : a === OUT ? outPath : a));
    const p = childProcess.spawnSync(this.binary, argv, {
      timeout: NATIVE_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, ASAN_OPTIONS: 'detect_leaks=0:allocator_may_return_null=1',
        UBSAN_OPTIONS: 'halt_on_error=1:print_stacktrace=1' },
    });
    const stdout = lines(p.stdout ? p.stdout.toString('utf8') : '');
    const stderr = lines(p.stderr ? p.stderr.toString('utf8') : '');
    // Only the path the engine was given counts as its output: the scratch folder is reused and never cleaned.
    const exists = argv.includes(outPath) && fs.existsSync(outPath);
    const sanitizer = stderr.some((l) => /AddressSanitizer|runtime error:|UndefinedBehaviorSanitizer/.test(l));
    return { code: p.status, signal: p.signal, stdout, stderr, json: lastJson(stdout),
      out: exists ? fs.readFileSync(outPath) : null, outExists: exists,
      threw: p.error || (sanitizer ? new Error('sanitizer report: ' + stderr.join(' | ').slice(0, 400)) : null),
      heap: null, inPath, outPath, inAfter: opts.checkInput && fs.existsSync(inPath) ? fs.readFileSync(inPath) : null };
  }
}

function makeEngine() {
  const spec = process.env.FONTWRAP_ENGINE || 'wasm';
  if (spec === 'wasm') return new WasmEngine();
  if (spec.startsWith('native:')) return new NativeEngine(spec.slice('native:'.length));
  throw new Error(`FONTWRAP_ENGINE must be "wasm" or "native:<binary>", not ${spec}`);
}

module.exports = { DEFAULT_GLUE, IN, IN_ALIAS, MODULE_DIR, NativeEngine, OUT, WasmEngine, makeEngine };
