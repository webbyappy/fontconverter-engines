/* test-font-browser-worker.js -- classic worker of the fontwrap browser harness (P1 plan, section 3.7).
 * Mounts each uploaded File with WORKERFS (mountFile), runs the jobs on one module instance, hashes every output with
 * SubtleCrypto, and after the heap-growing encode probes the resizable-buffer class of failure. */
/* global FontWrap */
importScripts('/fontwrap.js');

async function hex(bytes) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// fontconverter-web P3b (plan, P3b-5): selftest-oom on one instance aborts at the 1 GiB ceiling; a fresh instance in
// the same worker then converts; an instance that never aborted reports lastAbort() null.
async function oomProbe(file, expectArgv) {
  const err = [];
  const A = await FontWrap({ print: () => {}, printErr: (s) => err.push(s), locateFile: (p) => '/' + p });
  let threw = null;
  try { A.callMain(['selftest-oom']); } catch (x) { threw = String(x && x.message ? x.message : x); }
  const abort = typeof A.lastAbort === 'function' ? A.lastAbort() : 'no lastAbort()';
  const heap = A.heapBytes();
  const B = await FontWrap({ print: () => {}, printErr: () => {}, locateFile: (p) => '/' + p });
  B.FS.mkdir('/out');
  const input = B.mountFile(file, '/in');
  let code = null;
  try { code = B.callMain([...expectArgv, input, '/out/o.woff']); } catch (x) { code = String(x); }
  const sha = code === 0 ? await hex(B.FS.readFile('/out/o.woff')) : null;
  const clean = typeof B.lastAbort === 'function' ? B.lastAbort() : 'no lastAbort()';
  return { threw, abort, heap, code, sha, clean };
}

self.onmessage = async (e) => {
  if (e.data.kind === 'oom') {
    try {
      self.postMessage({ oom: await oomProbe(e.data.file, e.data.argv) });
    } catch (x) {
      self.postMessage({ fatal: String(x && x.stack ? x.stack : x) });
    }
    return;
  }
  const { files, jobs } = e.data;
  const report = { results: [], probes: null };
  const out = [];
  const err = [];
  try {
    const M = await FontWrap({ print: (s) => out.push(s), printErr: (s) => err.push(s), locateFile: (p) => '/' + p });
    M.FS.mkdir('/out');
    M.FS.mkdir('/kept');
    const mounted = {};
    files.forEach((f, i) => { mounted[f.name] = M.mountFile(f, '/in' + i); });
    for (const job of jobs) {
      const input = job.fromJob ? '/kept/' + job.fromJob : mounted[job.file];
      const target = '/out/' + job.id + '.' + job.ext;
      out.length = 0;
      err.length = 0;
      let code = null;
      let threw = null;
      try {
        code = M.callMain([...job.argv, input, target]);
      } catch (x) {
        threw = String(x && x.message ? x.message : x);
      }
      M.flushStderr();
      const exists = M.FS.analyzePath(target).exists;
      let sha = null;
      if (exists) {
        const bytes = M.FS.readFile(target);
        sha = await hex(bytes);
        M.FS.writeFile('/kept/' + job.id, bytes);
        M.FS.unlink(target);
      }
      report.results.push({ id: job.id, code, threw, sha, exists, stdout: out.slice(0, 1), stderr: err.slice(0, 2) });
      if (job.probeAfter) {
        // A path longer than 16 bytes makes the glue decode it with TextDecoder: the resizable-buffer failure.
        const longPath = '/kept/a-file-name-longer-than-sixteen-bytes.ttf';
        M.FS.writeFile(longPath, M.FS.readFile(mounted[job.file]));
        out.length = 0;
        let infoCode = null;
        let infoThrew = null;
        try { infoCode = M.callMain(['info', longPath]); } catch (x) { infoThrew = String(x); }
        let container = null;
        try { container = JSON.parse(out[0]).container; } catch (_) { /* reported as null */ }
        let thrown = null;
        err.length = 0;
        try { M.callMain(['selftest-throw']); } catch (x) { thrown = x; }
        M.flushStderr(); // delivers the hook's unterminated stderr line, so it cannot leak into the next job
        report.probes = { heapBytes: M.heapBytes(), resizable: M.HEAPU8.buffer.resizable === true, infoCode, infoThrew,
          container, selftestThrow: thrown ? { message: String(thrown.message), cppType: String(thrown.cppType) } : null,
          flushed: err.slice() };
      }
    }
  } catch (x) {
    report.fatal = String(x && x.stack ? x.stack : x);
  }
  self.postMessage(report);
};
