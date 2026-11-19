#!/usr/bin/env node
'use strict';
// test-font-browser.cjs -- fontwrap in a real browser (P1 plan, section 3.7 and P1-17). One browser per invocation;
// never alongside a build, the sweep or the oracle generator.
//
//   node font-wasm/test/test-font-browser.cjs chromium|firefox|webkit|chrome
//
// Playwright comes from ezyzip-app (1.61.1). Hermetic: every non-local host goes to a dead proxy. A node http server
// on an ephemeral port serves the page, the classic worker and the engine (application/wasm; no COOP/COEP, as
// production). The driver uploads fixtures through a real <input type="file">; the worker mounts each File with
// WORKERFS, runs the jobs and hashes the outputs; the driver compares them with fontwrap-oracle.json. FONTWRAP_GLUE
// selects another glue (the planted growable-buffer break). Final line: FONTWRAP-BROWSER-OK|FAIL <browser> <n>/<m>.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { fontOracle, fx } = require('./lib/fixtures');
const { DEFAULT_GLUE } = require('./lib/engine');
const { engineOracle, woff2Quality } = require('./lib/oracle');

const PW = process.env.PLAYWRIGHT_DIR; // a node_modules/playwright folder (Playwright 1.61 or later)
if (!PW) throw new Error('Set PLAYWRIGHT_DIR to a node_modules/playwright folder');
const BROWSERS = ['chromium', 'firefox', 'webkit', 'chrome'];
const INITIAL_HEAP = 64 * 1024 * 1024; // bytes
const CEILING_BYTES = 1073741824; // 1 GiB, linked with ABORTING_MALLOC=1 (fontconverter-web P3b plan, P3b-5)
const JOB_TIMEOUT_MS = 300000;

const which = process.argv[2];
if (!BROWSERS.includes(which)) {
  console.log(`usage: node test-font-browser.cjs ${BROWSERS.join('|')}`);
  process.exit(2);
}
const glue = path.resolve(process.env.FONTWRAP_GLUE || DEFAULT_GLUE);
const eo = engineOracle();
if (!eo) {
  console.log(`FONTWRAP-BROWSER-FAIL ${which}: no fontwrap-oracle.json (plan step C4)`);
  process.exit(1);
}
const fo = fontOracle().fixtures;

// The jobs: per uploaded fixture, the ops of the oracle that apply. names/ copies are judged by their source's entries.
const ENCODES = ['samples/OpenSans-Regular.ttf', 'samples/OpenSans-Regular.otf', 'samples/slick.ttf',
  'generated/names/프메2.ttf', 'generated/names/Open Sans Regular.ttf'];
const DECODES = ['derived/OpenSans-Regular.woff2', 'derived/OpenSans-Regular.eot', 'generated/eot/slick.xor.eot'];
const GROWTH = 'real/var-ttf/OpenSans-VF.ttf';
const REFUSED = 'generated/bad-input/zip-named.ttf';

function entry(key) {
  const e = eo.outputs[key];
  if (!e) throw new Error(`fontwrap-oracle.json has no ${key}`);
  return e;
}

const jobs = [];
for (const id of ENCODES) {
  const src = id.startsWith('generated/names/') ? fo[id].source : id;
  const file = path.basename(id);
  const stem = `j${jobs.length}`;
  const cff = ['cff', 'cff2'].includes(fo[src].flavour);
  jobs.push({ id: `${stem}-woff`, file, argv: ['woff-encode'], ext: 'woff', expect: entry(`${src}#woff`).file.sha256 });
  jobs.push({ id: `${stem}-woff2`, file, argv: ['woff2-encode', `--quality=${woff2Quality(fo[src].size)}`],
    ext: 'woff2', expect: entry(`${src}#woff2`).file.sha256 });
  jobs.push({ id: `${stem}-eot`, file, argv: cff ? ['eot-encode', '--allow-cff'] : ['eot-encode'], ext: 'eot',
    expect: entry(`${src}#${cff ? 'eot-allow-cff' : 'eot'}`).file.sha256 });
  jobs.push({ id: `${stem}-rt`, file, fromJob: `${stem}-woff2`, argv: ['woff2-decode'], ext: cff ? 'otf' : 'ttf',
    expect: entry(`${src}#woff2-roundtrip`).file.sha256 });
}
for (const id of DECODES) {
  const kind = fo[id].kind;
  jobs.push({ id: `j${jobs.length}-dec`, file: path.basename(id), argv: [`${kind}-decode`], ext: 'ttf',
    expect: entry(`${id}#decode`).file.sha256 });
}
jobs.push({ id: `j${jobs.length}-grow`, file: path.basename(GROWTH), argv: ['woff2-encode', '--quality=11'],
  ext: 'woff2', expect: entry(`${GROWTH}#woff2`).file.sha256, probeAfter: true });
jobs.push({ id: `j${jobs.length}-zip`, file: path.basename(REFUSED), argv: ['woff-encode'], ext: 'woff',
  expect: 'refused' });
const uploads = [...new Set([...ENCODES, ...DECODES, GROWTH, REFUSED])].map((id) => fx(id));

const PAGES = {
  '/': [path.join(__dirname, 'test-font-browser.html'), 'text/html; charset=utf-8'],
  '/test-font-browser-worker.js': [path.join(__dirname, 'test-font-browser-worker.js'), 'text/javascript'],
  '/fontwrap.js': [glue, 'text/javascript'],
  '/fontwrap.wasm': [glue.replace(/\.js$/, '.wasm'), 'application/wasm'],
};

async function main() {
  const server = http.createServer((req, res) => {
    const hit = PAGES[req.url.split('?')[0]];
    if (!hit) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': hit[1], 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(hit[0]));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const pw = require(PW);
  console.log(`playwright ${require(path.join(PW, 'package.json')).version}, ${which}, glue ${glue}`);
  const type = which === 'chrome' ? pw.chromium : pw[which];
  const browser = await type.launch({ headless: true, channel: which === 'chrome' ? 'chrome' : undefined,
    proxy: { server: 'http://127.0.0.1:9', bypass: 'localhost,127.0.0.1' } });
  let passed = 0;
  let total = 0;
  const check = (name, ok, detail) => {
    total++;
    if (ok) passed++;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ' -- ' + detail}`);
  };
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(JOB_TIMEOUT_MS);
    console.log(`browser ${browser.version()}`);
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.setInputFiles('#files', uploads);
    const report = await page.evaluate((j) => window.runJobs(j), jobs);
    if (report.fatal) check('the worker ran', false, report.fatal);
    for (const job of jobs) {
      const r = report.results.find((x) => x.id === job.id) || {};
      const label = `${job.argv.join(' ')} ${job.fromJob ? '(round trip)' : job.file}`;
      if (job.expect === 'refused') {
        check(`${label} is refused with no output`, r.code === 1 && !r.exists && !r.threw, JSON.stringify(r));
      } else {
        check(`${label} gives node's bytes`, r.code === 0 && r.sha === job.expect, JSON.stringify(r).slice(0, 300));
      }
    }
    const p = report.probes || {};
    check('the heap grew past 64 MiB', p.heapBytes > INITIAL_HEAP, String(p.heapBytes));
    check('after growth HEAPU8.buffer is not resizable', p.resizable === false, String(p.resizable));
    check('after growth a long path opens and info JSON parses', p.infoCode === 0 && p.container === 'sfnt',
      JSON.stringify(p));
    check('a C++ exception arrives as C++ Exception [type]: message', Boolean(p.selftestThrow) &&
      p.selftestThrow.message === 'C++ Exception [std::runtime_error]: fontwrap selftest exception' &&
      p.selftestThrow.cppType === 'std::runtime_error', JSON.stringify(p.selftestThrow));
    check('flushStderr() delivers the unterminated stderr line the hook left',
      JSON.stringify(p.flushed) === JSON.stringify(['fontwrap: selftest: unterminated']), JSON.stringify(p.flushed));
    const m = await page.evaluate(([n, a]) => window.runOom(n, a), ['slick.ttf', ['woff-encode']]);
    const o = m.oom || {};
    check('selftest-oom aborts at the 1 GiB ceiling and lastAbort() is "oom"', Boolean(o.threw) && o.abort === 'oom' &&
      o.heap <= CEILING_BYTES && o.heap > CEILING_BYTES - 64 * 1048576, JSON.stringify(m).slice(0, 300));
    check("a fresh instance in the same worker then converts slick.ttf to node's bytes", o.code === 0 &&
      o.sha === entry('samples/slick.ttf#woff').file.sha256, JSON.stringify(o).slice(0, 300));
    check('lastAbort() is null on an instance that never aborted', o.clean === null, JSON.stringify(o.clean));
  } catch (e) {
    check('the harness ran', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e));
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`FONTWRAP-BROWSER-${passed === total ? 'OK' : 'FAIL'} ${which} ${passed}/${total}`);
  process.exitCode = passed === total ? 0 : 1;
}

main();
