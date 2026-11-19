/* test-hbfont-browser-worker.js -- classic worker of the hbfont browser harness (fontconverter-web P3b plan, 4.1).
 * One request per worker, as the app's disposable workers (P3b-1): it instantiates the posted module (or compiles its
 * own when none came), writes the uploaded files into MEMFS, runs the jobs on fresh instances and hashes each output.
 * kind 'oom': selftest-oom on one instance, then a job on a fresh one. */
/* global HBFont */
importScripts('/hbfont.js');

async function hex(bytes) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

self.onmessage = async (e) => {
  const { files, jobs, kind } = e.data;
  const report = { results: [], module: null };
  try {
    let mod = e.data.module;
    if (mod instanceof WebAssembly.Module) {
      report.module = 'posted';
    } else {
      mod = await WebAssembly.compile(await (await fetch('/hbfont.wasm')).arrayBuffer());
      report.module = 'compiled here';
    }
    const instance = async (io) => HBFont({
      print: (s) => io.out.push(s), printErr: (s) => io.err.push(s),
      instantiateWasm: (imports, done) => {
        WebAssembly.instantiate(mod, imports).then((inst) => done(inst, mod));
        return {};
      },
    });
    if (kind === 'oom') {
      const A = await instance({ out: [], err: [] });
      let threw = null;
      try { A.callMain(['selftest-oom']); } catch (x) { threw = String(x && x.message ? x.message : x); }
      report.oom = { threw, abort: A.lastAbort(), heap: A.heapBytes() };
    }
    const byName = {};
    for (const f of files) byName[f.name] = new Uint8Array(await f.arrayBuffer());
    for (const job of jobs || []) {
      const io = { out: [], err: [] };
      const M = await instance(io);
      M.FS.mkdir('/in');
      M.FS.mkdir('/out');
      const argv = job.argv.map((a) => (a.startsWith('@') ? (M.FS.writeFile('/in/' + a.slice(1), byName[a.slice(1)]),
        '/in/' + a.slice(1)) : a === '#out' ? '/out/o.bin' : a));
      let code = null;
      let threw = null;
      try { code = M.callMain(argv); } catch (x) { threw = String(x && x.message ? x.message : x); }
      const exists = M.FS.analyzePath('/out/o.bin').exists;
      report.results.push({ id: job.id, code, threw, stdout: io.out.slice(0, 1), lastAbort: M.lastAbort(),
        sha: exists ? await hex(M.FS.readFile('/out/o.bin')) : null });
    }
  } catch (x) {
    report.fatal = String(x && x.stack ? x.stack : x);
  }
  self.postMessage(report);
};
