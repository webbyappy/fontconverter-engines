#!/usr/bin/env node
'use strict';
// test-ffconv-browser.cjs -- ffconv in a real browser (P2 plan, P2-17; after font-wasm/test/test-font-browser.cjs).
// One browser per invocation; never alongside a build, a native run or the oracle generator.
//
//   node fontforge-wasm/test/test-ffconv-browser.cjs chromium|firefox|webkit|chrome
//
// Playwright comes from ezyzip-app (1.61.1). Hermetic: every non-local host goes to a dead proxy. A node http server on
// an ephemeral port serves the page, the classic worker and the engine (application/wasm; no COOP/COEP, as production).
// The driver uploads fixtures through a real <input type="file">; the worker compiles the module once, makes a fresh
// instance per job, writes the input into MEMFS (one job mounts it with WORKERFS), hashes the outputs; the driver
// compares them with ffconv-oracle.json (FFCONV_ORACLE_FILE selects another). 17 counted rows, in a UTC context; 3
// observation rows (another time zone, another locale) are reported, not counted. FFCONV_GLUE selects another glue
// (the planted growable-buffer break). Final line: FFCONV-BROWSER-OK|FAIL <browser> <n>/17.
//
// Time zone: SVG metadata prints the font's date in the worker's local time. Playwright's timezoneId does not reach
// a dedicated worker in Firefox (found in P2's C5: the worker ran in the host's zone), so every browser is launched
// with TZ=UTC, and the counted rows require a worker that reports UTC (a precondition; the run fails without it).
// Each observation row prints the zone and language its worker saw, so an emulation that did not reach the worker
// shows as such instead of passing for a result.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { fx } = require('./lib/fixtures');
const { DEFAULT_GLUE, ENV } = require('./lib/engine');
const oracle = require('./lib/oracle');

const PW = process.env.PLAYWRIGHT_DIR; // a node_modules/playwright folder (Playwright 1.61 or later)
if (!PW) throw new Error('Set PLAYWRIGHT_DIR to a node_modules/playwright folder');
const BROWSERS = ['chromium', 'firefox', 'webkit', 'chrome'];
const INITIAL_HEAP = 32 * 1024 * 1024; // bytes (P2-8)
const CEILING_BYTES = 1073741824; // 1 GiB, linked with ABORTING_MALLOC=1 (fontconverter-web P3b plan, P3b-5)
const JOB_TIMEOUT_MS = 600000;
const PIN_KEYS = ['fontforge', 'glib', 'pcre2', 'libxml2', 'libiconv', 'freetype', 'zlib'];

const which = process.argv[2];
if (!BROWSERS.includes(which)) {
  console.log(`usage: node test-ffconv-browser.cjs ${BROWSERS.join('|')}`);
  process.exit(2);
}
const glue = path.resolve(process.env.FFCONV_GLUE || DEFAULT_GLUE);
const recorded = oracle.ffconvOracle();
if (!recorded) {
  console.log(`FFCONV-BROWSER-FAIL ${which}: no ffconv-oracle.json (plan step C4)`);
  process.exit(1);
}
const sha = (key) => {
  const e = recorded.outputs[key];
  if (!e) throw new Error(`ffconv-oracle.json has no ${key}`);
  return e.file.sha256;
};

// [id, fixture, target, expected sha256 (or 'refused'), extra]
const ROWS = [
  [1, 'samples/OpenSans-Regular.ttf', 'otf', sha('samples/OpenSans-Regular.ttf#otf')],
  [2, 'samples/OpenSans-Regular.otf', 'ttf', sha('samples/OpenSans-Regular.otf#ttf'), { probeSecond: true }],
  [3, 'samples/OpenSans-Regular.ttf', 'svg', sha('samples/OpenSans-Regular.ttf#svg')],
  [4, 'derived/slick.svg', 'ttf', sha('derived/slick.svg#ttf')],
  [5, 'real/dejavu/DejaVuSans.ttf', 'otf', sha('real/dejavu/DejaVuSans.ttf#otf'), { probeHeap: true }],
  [6, 'generated/names/프메2.ttf', 'otf', sha('samples/OpenSans-Regular.ttf#otf')],
  [7, 'generated/names/Open Sans Regular.ttf', 'svg', sha('samples/OpenSans-Regular.ttf#svg')],
  [8, 'generated/cid/NotoSansCJKjp-cid-small.otf', 'svg', sha('generated/cid/NotoSansCJKjp-cid-small.otf#svg')],
  [9, 'generated/aliases/slick-aliases-fmt12.ttf', 'svg', sha('generated/aliases/slick-aliases-fmt12.ttf#svg')],
  [10, 'real/fontawesome-web/fa-solid-900.ttf', 'otf', sha('real/fontawesome-web/fa-solid-900.ttf#otf')],
  [11, 'samples/slick.ttf', 'otf', sha('samples/slick.ttf#otf'), { workerfs: true }],
  [12, 'real/var-ttf/OpenSans-VF.ttf', 'otf', 'refused'],
  [13, 'generated/bad-input/zip-named.ttf', 'ttf', 'refused'],
];
// Observation rows (P2-7): [id, fixture, target, context options, ENV, the UTC entry they are compared with]
const NO_LANG = { SOURCE_DATE_EPOCH: ENV.SOURCE_DATE_EPOCH, USER: ENV.USER };
const OBSERVE = [
  [18, 'samples/slick.ttf', 'svg', { timezoneId: 'Asia/Tokyo' }, ENV, 'samples/slick.ttf#svg'],
  [19, 'derived/slick.svg', 'ttf', { timezoneId: 'Asia/Tokyo' }, ENV, 'derived/slick.svg#ttf'],
  [20, 'samples/slick.ttf', 'svg', { timezoneId: 'UTC', locale: 'de-DE' }, NO_LANG, 'samples/slick.ttf#svg'],
];

const job = ([id, fixture, target, , extra]) => ({ id: `row${id}`, file: path.basename(fixture), target, ...(extra || {}) });

const PAGES = {
  '/': [path.join(__dirname, 'test-ffconv-browser.html'), 'text/html; charset=utf-8'],
  '/test-ffconv-browser-worker.js': [path.join(__dirname, 'test-ffconv-browser-worker.js'), 'text/javascript'],
  '/ffconv.js': [glue, 'text/javascript'],
  '/ffconv.wasm': [glue.replace(/\.js$/, '.wasm'), 'application/wasm'],
};

async function runIn(browser, port, contextOptions, uploads, jobs, env) {
  const context = await browser.newContext(contextOptions);
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(JOB_TIMEOUT_MS);
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.setInputFiles('#files', uploads);
    return await page.evaluate(([j, v]) => window.runJobs(j, v), [jobs, env]);
  } finally {
    await context.close();
  }
}

async function main() {
  const server = http.createServer((req, res) => {
    const hit = PAGES[decodeURIComponent(req.url.split('?')[0])];
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
    env: { ...process.env, TZ: 'UTC' }, proxy: { server: 'http://127.0.0.1:9', bypass: 'localhost,127.0.0.1' } });
  let precondition = true;
  let passed = 0;
  let total = 0;
  const check = (name, ok, detail) => {
    total++;
    if (ok) passed++;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ' -- ' + detail}`);
  };
  try {
    console.log(`browser ${browser.version()}`);
    const uploads = [...new Set(ROWS.map((r) => fx(r[1])))];
    const report = await runIn(browser, port, { timezoneId: 'UTC' }, uploads, ROWS.map(job), ENV);
    if (report.fatal) console.log(`worker: ${report.fatal.slice(0, 400)}`);
    const w = report.worker || {};
    if (w.offset !== 0 || w.zone !== 'UTC') {
      precondition = false;
      console.log(`PRECONDITION-FAIL the counted rows need a worker in UTC; it reported ${JSON.stringify(w)}`);
    }
    for (const [id, fixture, target, want] of ROWS) {
      const r = report.results.find((x) => x.id === `row${id}`) || {};
      const label = `${id} ${fixture} -> ${target}${id === 11 ? ' (WORKERFS)' : ''}`;
      if (want === 'refused') {
        check(`${label} is refused with no output`, r.code === 1 && !r.exists && (r.outDir || []).length === 0 &&
          !r.threw && /^ffconv: error: /.test((r.stderr || [])[0] || ''), JSON.stringify(r).slice(0, 300));
      } else {
        check(`${label} gives node's bytes`, r.code === 0 && r.sha === want, JSON.stringify(r).slice(0, 300));
      }
    }
    const p = report.probes || {};
    check('14 after row 5 the heap grew past 32 MiB and HEAPU8.buffer is not resizable',
      p.heapBytes > INITIAL_HEAP && p.resizable === false, `${p.heapBytes} ${p.resizable}`);
    check('15 selftest-stderr, then flushStderr() delivers the unterminated line', p.stderr && p.stderr.code === 0 &&
      !p.stderr.before.length && p.stderr.after.includes('ffconv: selftest: unterminated'), JSON.stringify(p.stderr));
    check('16 a second callMain on one instance exits 2', p.second && p.second.code === 2 &&
      /one conversion per instance/.test(p.second.last), JSON.stringify(p.second));
    const info = fs.readFileSync(path.join(path.dirname(glue), 'BUILD-INFO.txt'), 'utf8');
    let v = null;
    try { v = JSON.parse(p.version.line); } catch (_) { /* reported below */ }
    check('17 version parses with the pins of BUILD-INFO.txt', p.version && p.version.code === 0 && v &&
      PIN_KEYS.every((k) => info.includes(`${k}@${v[k]}`)), JSON.stringify(p.version));
    const o = p.oom || {};
    check('21 selftest-oom aborts at the 1 GiB ceiling and lastAbort() is "oom"', Boolean(o.threw) && o.abort === 'oom' &&
      o.heap <= CEILING_BYTES && o.heap > CEILING_BYTES - 64 * 1048576, JSON.stringify(o).slice(0, 300));
    check("22 a fresh instance in the same worker then converts slick.ttf to node's bytes", Boolean(o.after) &&
      o.after.code === 0 && o.after.sha === sha('samples/slick.ttf#otf'), JSON.stringify(o.after));
    check('23 lastAbort() is null on an instance that never aborted', o.clean === null, JSON.stringify(o.clean));
    for (const [id, fixture, target, opts, env, utcKey] of OBSERVE) {
      const o = await runIn(browser, port, opts, [fx(fixture)], [job([id, fixture, target])], env);
      const r = (o.results || [])[0] || {};
      const ow = o.worker || {};
      console.log(`OBSERVE ${id} ${fixture} -> ${target} ${JSON.stringify(opts)}${env === NO_LANG ? ' LANG unset' : ''}: ` +
        `the worker saw ${ow.zone} (offset ${ow.offset}) and language ${ow.language}; ` +
        `exit ${r.code}, ${r.sha === sha(utcKey) ? 'IDENTICAL to' : 'DIFFERS from'} the UTC output`);
    }
  } catch (e) {
    check('the harness ran', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e));
  } finally {
    await browser.close();
    server.close();
  }
  const ok = precondition && passed === total && total === 20; // 17, and P3b's three memory rows (21 to 23)
  console.log(`FFCONV-BROWSER-${ok ? 'OK' : 'FAIL'} ${which} ${passed}/${total}`);
  process.exitCode = ok ? 0 : 1;
}

main();
