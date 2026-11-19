'use strict';
// The engine under test, behind one run() (fontconverter-web P3b plan, section 4.1):
//   wasm   output/hbfont.{js,wasm} (or $HBFONT_GLUE): compiled once, a fresh instance per run unless the case passes
//          its own; inputs written to MEMFS /in/<name>, the output read from MEMFS /out.
//   native $HBFONT_ENGINE=native:<binary>: one process per run, in its own new folder under os.tmpdir() (an output
//          left by one run can never look like another's). The harness deletes nothing.
//
// hbfont takes up to three inputs (transplant: the colour source, the outline font, the glyph map), so inputs are
// named: opts.inputs = { name: Buffer | {path} }, and inp(name) in args stands for /in/<name>. OUT stands for the
// output path, opts.outName its file name.

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = Symbol('output path');
const MODULE_DIR = path.resolve(__dirname, '..', '..');
const DEFAULT_GLUE = path.join(MODULE_DIR, 'output', 'hbfont.js');
const NATIVE_TIMEOUT_MS = 600000; // 10 minutes: instancing a 31 MiB CJK font under ASan

class Input {
  constructor(name) {
    this.name = name;
  }
}

// The path of the input named `name`; `alias` spells the same file differently (`<dir>/./<name>`).
function inp(name, alias = false) {
  const i = new Input(name);
  i.alias = alias;
  return i;
}

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

function argvOf(args, inDir, outPath) {
  return args.map((a) => {
    if (a === OUT) return outPath;
    if (a instanceof Input) return a.alias ? `${inDir}/./${a.name}` : `${inDir}/${a.name}`;
    return a;
  });
}

class WasmEngine {
  constructor(gluePath) {
    this.kind = 'wasm';
    this.gluePath = path.resolve(gluePath || process.env.HBFONT_GLUE || DEFAULT_GLUE);
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

  // A fresh instance; `overrides` may replace print/printErr.
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

  // opts: inputs ({name: Buffer | {path}}), outName, stale (Buffer placed at the output path first), instance (reuse
  // one), checkInputs (return each input's bytes after the run).
  async run(args, opts = {}) {
    const inst = opts.instance || (await this.instance());
    const { M, io } = inst;
    io.out.length = 0;
    io.err.length = 0;
    const inputs = opts.inputs || {};
    for (const [name, data] of Object.entries(inputs)) M.FS.writeFile(`/in/${name}`, inputBytes(data));
    const outPath = '/out/' + (opts.outName || 'output.bin');
    if (opts.stale) M.FS.writeFile(outPath, opts.stale);
    const argv = argvOf(args, '/in', outPath);
    let code = null;
    let threw = null;
    try {
      code = M.callMain(argv);
    } catch (e) {
      threw = e;
    }
    process.exitCode = 0;
    if (M.flushStderr) M.flushStderr();
    const exists = argv.includes(outPath) && M.FS.analyzePath(outPath).exists;
    const out = exists ? Buffer.from(M.FS.readFile(outPath)) : null;
    const outDir = M.FS.readdir('/out').filter((n) => n !== '.' && n !== '..');
    const inputsAfter = {};
    if (opts.checkInputs) {
      for (const name of Object.keys(inputs)) {
        inputsAfter[name] = M.FS.analyzePath(`/in/${name}`).exists ? Buffer.from(M.FS.readFile(`/in/${name}`)) : null;
      }
    }
    if (exists) M.FS.unlink(outPath); // keeps a reused instance's in-memory file system small
    const stdout = io.out.slice();
    return { code, stdout, stderr: io.err.slice(), json: lastJson(stdout), out, outExists: exists, outDir, threw,
      heap: M.heapBytes ? M.heapBytes() : null, outPath, inputsAfter, M };
  }
}

class NativeEngine {
  constructor(binary) {
    this.kind = 'native';
    this.binary = path.resolve(binary);
    this.scratch = null;
    this.runs = 0;
  }

  available() {
    return fs.existsSync(this.binary);
  }

  async init() {
    this.scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hbfont-native-'));
  }

  async run(args, opts = {}) {
    const dir = path.join(this.scratch, String(++this.runs));
    fs.mkdirSync(path.join(dir, 'in'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'out'));
    const inputs = opts.inputs || {};
    for (const [name, data] of Object.entries(inputs)) fs.writeFileSync(path.join(dir, 'in', name), inputBytes(data));
    const outPath = path.join(dir, 'out', opts.outName || 'output.bin');
    if (opts.stale) fs.writeFileSync(outPath, opts.stale);
    const argv = argvOf(args, path.join(dir, 'in'), outPath);
    const p = childProcess.spawnSync(this.binary, argv, {
      timeout: NATIVE_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, ASAN_OPTIONS: 'detect_leaks=0:allocator_may_return_null=1',
        UBSAN_OPTIONS: 'halt_on_error=1:print_stacktrace=1' },
    });
    const stdout = lines(p.stdout ? p.stdout.toString('utf8') : '');
    const stderr = lines(p.stderr ? p.stderr.toString('utf8') : '');
    const exists = argv.includes(outPath) && fs.existsSync(outPath);
    const sanitizer = stderr.some((l) => /AddressSanitizer|runtime error:|UndefinedBehaviorSanitizer/.test(l));
    const inputsAfter = {};
    if (opts.checkInputs) {
      for (const name of Object.keys(inputs)) {
        const f = path.join(dir, 'in', name);
        inputsAfter[name] = fs.existsSync(f) ? fs.readFileSync(f) : null;
      }
    }
    return { code: p.status, signal: p.signal, stdout, stderr, json: lastJson(stdout),
      out: exists ? fs.readFileSync(outPath) : null, outExists: exists,
      outDir: fs.readdirSync(path.join(dir, 'out')),
      threw: p.error || (sanitizer ? new Error('sanitizer report: ' + stderr.join(' | ').slice(0, 400)) : null),
      heap: null, outPath, inputsAfter, M: null };
  }
}

function makeEngine() {
  const spec = process.env.HBFONT_ENGINE || 'wasm';
  if (spec === 'wasm') return new WasmEngine();
  if (spec.startsWith('native:')) return new NativeEngine(spec.slice('native:'.length));
  throw new Error(`HBFONT_ENGINE must be "wasm" or "native:<binary>", not ${spec}`);
}

module.exports = { DEFAULT_GLUE, MODULE_DIR, NativeEngine, OUT, WasmEngine, inp, makeEngine };
