/* test-ffconv-browser-worker.js -- classic worker of the ffconv browser harness (P2 plan, P2-17).
 * Compiles ffconv.wasm once and makes a fresh instance per job (ffconv converts once per instance, P2-6). The input's
 * bytes are written into MEMFS (roadmap 4.3), or, for a job marked `workerfs`, the File is mounted with WORKERFS.
 * Every output is hashed with SubtleCrypto. Probes: the heap after a growing conversion, flushStderr, a second
 * callMain on one instance, version. */
/* global FFConv */
importScripts('/ffconv.js');

async function hex(bytes) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function instance(mod, env, io) {
  return FFConv({
    print: (s) => io.out.push(s), printErr: (s) => io.err.push(s),
    preRun: [(m) => Object.assign(m.ENV, env)],
    instantiateWasm: (imports, done) => {
      WebAssembly.instantiate(mod, imports).then((inst) => done(inst, mod));
      return {};
    },
  });
}

function run(M, argv) {
  try {
    return { code: M.callMain(argv), threw: null };
  } catch (x) {
    return { code: null, threw: String(x && x.message ? x.message : x) };
  }
}

self.onmessage = async (e) => {
  const { files, jobs, env } = e.data;
  // What this worker sees: a context's timezoneId or locale does not reach a dedicated worker in every browser
  // (Firefox: neither; Chromium: the time zone only), and the glue's default LANG comes from navigator.language.
  const report = { results: [], probes: {}, worker: { offset: new Date(0).getTimezoneOffset(),
    zone: Intl.DateTimeFormat().resolvedOptions().timeZone, language: navigator.language } };
  try {
    const mod = await WebAssembly.compile(await (await fetch('/ffconv.wasm')).arrayBuffer());
    const byName = {};
    files.forEach((f) => { byName[f.name] = f; });
    for (const job of jobs) {
      const io = { out: [], err: [] };
      const M = await instance(mod, env, io);
      M.FS.mkdir('/out');
      let input;
      if (job.workerfs) {
        input = M.mountFile(byName[job.file], '/in');
      } else {
        M.FS.mkdir('/in');
        input = '/in/' + job.file;
        M.FS.writeFile(input, new Uint8Array(await byName[job.file].arrayBuffer()));
      }
      const target = '/out/output.' + job.target;
      const r = run(M, ['convert', input, target]);
      M.flushStderr();
      const exists = M.FS.analyzePath(target).exists;
      const sha = exists ? await hex(M.FS.readFile(target)) : null;
      const outDir = M.FS.readdir('/out').filter((n) => n !== '.' && n !== '..');
      report.results.push({ id: job.id, code: r.code, threw: r.threw, sha, exists, outDir, stdout: io.out.slice(0, 1),
        stderr: io.err.slice(-1) });
      if (job.probeHeap) {
        report.probes.heapBytes = M.heapBytes();
        report.probes.resizable = M.HEAPU8.buffer.resizable === true;
      }
      if (job.probeSecond) {
        const again = run(M, ['convert', input, '/out/again.' + job.target]);
        M.flushStderr();
        report.probes.second = { code: again.code, threw: again.threw, last: io.err.slice(-1)[0] || '' };
      }
    }
    const io = { out: [], err: [] };
    const S = await instance(mod, env, io);
    const s = run(S, ['selftest-stderr']);
    const before = io.err.slice();
    S.flushStderr();
    report.probes.stderr = { code: s.code, before, after: io.err.slice() };
    const vio = { out: [], err: [] };
    const V = await instance(mod, env, vio);
    const v = run(V, ['version']);
    report.probes.version = { code: v.code, line: vio.out[0] || null };
    // fontconverter-web P3b (plan, P3b-5): selftest-oom aborts at the 1 GiB ceiling; a fresh instance of the same
    // module in the same worker then converts; that instance reports lastAbort() null.
    const O = await instance(mod, env, { out: [], err: [] });
    const o = run(O, ['selftest-oom']);
    const abort = typeof O.lastAbort === 'function' ? O.lastAbort() : 'no lastAbort()';
    const F = await instance(mod, env, { out: [], err: [] });
    F.FS.mkdir('/in');
    F.FS.mkdir('/out');
    F.FS.writeFile('/in/slick.ttf', new Uint8Array(await byName['slick.ttf'].arrayBuffer()));
    const f = run(F, ['convert', '/in/slick.ttf', '/out/o.otf']);
    report.probes.oom = { threw: o.threw, code: o.code, abort, heap: O.heapBytes(),
      after: { code: f.code, sha: f.code === 0 ? await hex(F.FS.readFile('/out/o.otf')) : null },
      clean: typeof F.lastAbort === 'function' ? F.lastAbort() : 'no lastAbort()' };
  } catch (x) {
    report.fatal = String(x && x.stack ? x.stack : x);
  }
  self.postMessage(report);
};
