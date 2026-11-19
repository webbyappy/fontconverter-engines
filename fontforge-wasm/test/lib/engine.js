'use strict';
// The engine under test, behind one run() (P2 plan, section 4.1; adapted from font-wasm/test/lib/engine.js at
// 840fd65d8):
//   wasm   output/ffconv.{js,wasm} (or $FFCONV_GLUE): compiled once, a fresh instance per run (ffconv converts once
//          per instance, P2-6) unless the case passes its own; input written to MEMFS /in, output read from /out.
//   native $FFCONV_ENGINE=native:<binary>: one process per run in a scratch folder under os.tmpdir(); sanitizer
//          reports are appended to <scratch>/sanitizer.jsonl for C1's attribution. The harness deletes nothing.
// Both run with ENV (P2-7): SOURCE_DATE_EPOCH, USER and LANG as the oracle was made.

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const IN = Symbol('input path');
const OUT = Symbol('output path');
const IN_ALIAS = Symbol('input path, another spelling'); // `<dir>/./<name>`: the same file under another string
// The glyph map's path, next to the output (fontconverter-web P3b plan, P3b-9); the run returns it parsed.
const MAP = Symbol('glyph map path');

function readMap(text) {
  try { return JSON.parse(text); } catch (_) { return { unparsable: text.slice(0, 200) }; }
}

const ENV = { SOURCE_DATE_EPOCH: '1794873600', USER: 'fontforge', LANG: 'C.UTF-8' };
const MODULE_DIR = path.resolve(__dirname, '..', '..');
const DEFAULT_GLUE = path.join(MODULE_DIR, 'output', 'ffconv.js');
const NATIVE_TIMEOUT_MS = 600000; // 10 minutes: a 5 MiB CJK font through FontForge under ASan
const OWN_SOURCES = /src\/(main|sniff|no-subprocess|stable-qsort)\.c/;

function aliasOf(p) {
  return `${path.posix.dirname(p)}/./${path.posix.basename(p)}`;
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

class WasmEngine {
  constructor(gluePath) {
    this.kind = 'wasm';
    this.gluePath = path.resolve(gluePath || process.env.FFCONV_GLUE || DEFAULT_GLUE);
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

  async instance(overrides = {}, env = ENV) {
    const io = { out: [], err: [] };
    const M = await this.factory({
      print: (s) => io.out.push(s),
      printErr: (s) => io.err.push(s),
      preRun: [(m) => Object.assign(m.ENV, env)],
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
  // placed at the output path first), instance (reuse one), env (another ENV).
  async run(args, opts = {}) {
    const inst = opts.instance || (await this.instance({}, opts.env || ENV));
    const { M, io } = inst;
    io.out.length = 0;
    io.err.length = 0;
    const inPath = '/in/' + (opts.inName || 'input.bin');
    const outPath = '/out/' + (opts.outName || 'output.bin');
    if (opts.input != null) M.FS.writeFile(inPath, inputBytes(opts.input));
    if (opts.stale) M.FS.writeFile(outPath, opts.stale);
    const mapPath = '/out/glyph-map.json';
    const argv = args.map((a) => (a === IN ? inPath : a === IN_ALIAS ? aliasOf(inPath) : a === OUT ? outPath
      : a === MAP ? mapPath : a));
    let code = null;
    let threw = null;
    const t0 = performance.now();
    try {
      code = M.callMain(argv);
    } catch (e) {
      threw = e;
    }
    const ms = performance.now() - t0;
    process.exitCode = 0;
    if (M.flushStderr) M.flushStderr();
    const exists = argv.includes(outPath) && M.FS.analyzePath(outPath).exists;
    const out = exists ? Buffer.from(M.FS.readFile(outPath)) : null;
    const outDir = M.FS.readdir('/out').filter((n) => n !== '.' && n !== '..');
    const glyphMap = M.FS.analyzePath(mapPath).exists ? readMap(new TextDecoder().decode(M.FS.readFile(mapPath))) : null;
    const inAfter = M.FS.analyzePath(inPath).exists ? Buffer.from(M.FS.readFile(inPath)) : null;
    return { code, stdout: io.out.slice(), stderr: io.err.slice(), json: lastJson(io.out), out, outExists: exists,
      outDir, threw, ms, heap: M.HEAPU8 ? M.HEAPU8.length : null, inPath, outPath, inAfter, M, glyphMap };
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
    this.scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ffconv-native-'));
    this.reports = path.join(this.scratch, 'sanitizer.jsonl');
  }

  async run(args, opts = {}) {
    // A new folder per run: an output or private folder left by one run can never look like another run's.
    const dir = path.join(this.scratch, String(++this.runs));
    fs.mkdirSync(path.join(dir, 'in'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'out'));
    let inPath = path.join(dir, 'in', opts.inName || 'input.bin');
    if (opts.input != null) {
      if (Buffer.isBuffer(opts.input)) fs.writeFileSync(inPath, opts.input);
      else inPath = opts.input.path;
    }
    const outPath = path.join(dir, 'out', opts.outName || 'output.bin');
    if (opts.stale) fs.writeFileSync(outPath, opts.stale);
    const mapPath = path.join(dir, 'out', 'glyph-map.json');
    const argv = args.map((a) => (a === IN ? inPath : a === IN_ALIAS ? aliasOf(inPath) : a === OUT ? outPath
      : a === MAP ? mapPath : a));
    const t0 = performance.now();
    const p = childProcess.spawnSync(this.binary, argv, {
      timeout: NATIVE_TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, ...(opts.env || ENV), TZ: 'UTC',
        ASAN_OPTIONS: 'detect_leaks=0:allocator_may_return_null=1:halt_on_error=0',
        UBSAN_OPTIONS: 'halt_on_error=0:print_stacktrace=1' },
    });
    const ms = performance.now() - t0;
    const stdout = lines(p.stdout ? p.stdout.toString('utf8') : '');
    const stderr = lines(p.stderr ? p.stderr.toString('utf8') : '');
    const report = stderr.filter((l) => /AddressSanitizer|runtime error:|UndefinedBehaviorSanitizer|^\s+#\d+ /.test(l));
    if (report.length) {
      fs.appendFileSync(this.reports, JSON.stringify({ argv: argv.map(String), stderr: report.slice(0, 200) }) + '\n');
    }
    // A report with an own source frame fails the run (P2-16: a reason to look; C1 attributes every report).
    const own = report.some((l) => OWN_SOURCES.test(l));
    const exists = argv.includes(outPath) && fs.existsSync(outPath);
    const stripped = stderr.filter((l) => !report.includes(l));
    return { code: p.status, signal: p.signal, stdout, stderr: stripped, json: lastJson(stdout),
      out: exists ? fs.readFileSync(outPath) : null, outExists: exists, outDir: fs.readdirSync(path.join(dir, 'out')),
      threw: p.error || (own ? new Error('sanitizer report with an own frame: ' + report.join(' | ').slice(0, 400))
        : null), ms, heap: null, inPath, outPath,
      inAfter: fs.existsSync(inPath) ? fs.readFileSync(inPath) : null, sanitizerLines: report.length, sanitizer: report,
      glyphMap: fs.existsSync(mapPath) ? readMap(fs.readFileSync(mapPath, 'utf8')) : null };
  }
}

function makeEngine() {
  const spec = process.env.FFCONV_ENGINE || 'wasm';
  if (spec === 'wasm') return new WasmEngine();
  if (spec.startsWith('native:')) return new NativeEngine(spec.slice('native:'.length));
  throw new Error(`FFCONV_ENGINE must be "wasm" or "native:<binary>", not ${spec}`);
}

module.exports = { DEFAULT_GLUE, ENV, IN, IN_ALIAS, MAP, MODULE_DIR, NativeEngine, OUT, WasmEngine, makeEngine };
