#!/usr/bin/env node
'use strict';
// test-hbfont-browser.cjs -- hbfont in a real browser (fontconverter-web P3b plan, section 4.1). One browser per
// invocation; never alongside a build, a sweep, the oracle generator or another browser.
//
//   TZ=UTC node harfbuzz-wasm/test/test-hbfont-browser.cjs chromium|firefox|webkit|chrome
//
// Node first makes what the page needs with the same engine (and the committed ffconv for transplant inputs): the
// expected bytes of each job and the fonts to draw. The page compiles hbfont.wasm once and posts the module to each
// worker (one request per worker, P3b-1); rows: every job gives node's bytes; the module arrives posted, and a worker
// whose module could not be cloned compiles its own; selftest-oom then a job in the same page; each transplanted font
// drawn with FontFace beside its source draws as the source does (at most 3 % of the inked pixels differing by more
// than 64 in a channel), and whether the browser draws the source's colour at all is recorded per table (the matrix).
// Hermetic: every non-local host goes to a dead proxy. Final line: HBFONT-BROWSER-OK|FAIL <browser> <n>/<m>.

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { readFixture } = require('./lib/fixtures');
const { DEFAULT_GLUE, OUT, WasmEngine, inp } = require('./lib/engine');
const { fontforge } = require('./lib/ffconv');
const { cblcFacts, colrFacts, sbixFacts, svgFacts, svgGlyphIds } = require('./lib/colour');
const { bestUnicodeMap } = require('./lib/sfnt');

const PW = process.env.PLAYWRIGHT_DIR; // a node_modules/playwright folder (Playwright 1.61 or later)
if (!PW) throw new Error('Set PLAYWRIGHT_DIR to a node_modules/playwright folder');
const BROWSERS = ['chromium', 'firefox', 'webkit', 'chrome'];
const CEILING_BYTES = 1073741824;
const DIFF_LEVEL = 64; // a pixel differs when a channel differs by more than this
const DIFF_SHARE = 0.03; // at most this share of the inked pixels may differ
const COLOUR_SPREAD = 40; // a pixel is chromatic when its channels spread by more than this
// A complete run: the module, 11 jobs, the clone failure, 2 memory rows, 7 colour pairs (Bungee sbix is a recorded
// known limit, not a row: browsers draw sbix over CFF unlike the source, which is why the app gives sbix sources no
// otf). A pair whose source the browser does not draw is n/a, never a pass.
const ROWS = 22;
const KNOWN = { bungeesbix: 'sbix in CFF draws unlike its source (why the app gives sbix sources no otf)' };

const which = process.argv[2];
if (!BROWSERS.includes(which)) {
  console.log(`usage: node test-hbfont-browser.cjs ${BROWSERS.join('|')}`);
  process.exit(2);
}
const glue = path.resolve(process.env.HBFONT_GLUE || DEFAULT_GLUE);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// [key, fixture, FontForge's input name, target, an instance first ([--at, options]) or null, table]
const COLOUR = [
  ['twemoji', 'real/twemoji/Twemoji.Mozilla.ttf', 'input.ttf', 'otf', null, 'COLRv0'],
  ['nabla', 'real/var-colr/Nabla[EDPT,EHLT].ttf', 'input.ttf', 'otf', ['EDPT=200,EHLT=24', []], 'COLRv1+SVG (variable)'],
  ['twemojicid', 'generated/colour/Twemoji-cid.otf', 'input.otf', 'ttf', null, 'COLRv0 (CID-keyed CFF)'],
  ['slicksbix', 'generated/special/slick-sbix.ttf', 'input.ttf', 'otf', null, 'sbix'],
  ['bungeesbix', 'real/color-sbix/BungeeColor-Regular_sbix_MacOS.ttf', 'input.ttf', 'otf', null, 'sbix'],
  ['slickcbdt', 'generated/colour/slick-cbdt.ttf', 'input.ttf', 'otf', null, 'CBDT'],
  ['slicksvg', 'generated/colour/slick-svg-multi.ttf', 'input.ttf', 'otf', null, 'SVG'],
  ['bungeesvg', 'real/color-svg/BungeeColor-Regular_svg.ttf', 'input.ttf', 'otf', null, 'SVG'],
];

// Up to 24 code points whose glyphs the source's colour tables draw.
function colourText(font) {
  const glyphs = new Set();
  const c = colrFacts(font);
  if (c) { c.base.forEach((b) => glyphs.add(b.gid)); c.v1.forEach((g) => glyphs.add(g)); }
  const s = sbixFacts(font);
  if (s) s.strikes.forEach((st) => [...st.data.keys()].forEach((g) => glyphs.add(g)));
  const b = cblcFacts(font);
  if (b) b.sizes.forEach((z) => { for (let g = z.start; g <= z.end; g++) glyphs.add(g); });
  const v = svgFacts(font);
  if (v) v.entries.forEach((e) => svgGlyphIds(e.doc).forEach((g) => glyphs.add(g)));
  const cps = [...bestUnicodeMap(font)].filter(([cp, g]) => glyphs.has(g) && cp > 0x20).map(([cp]) => cp);
  return String.fromCodePoint(...cps.slice(0, 24));
}

async function prepare(dir) {
  const eng = new WasmEngine(DEFAULT_GLUE); // node's bytes come from the committed engine, whatever glue the page gets
  await eng.init();
  const put = (name, bytes) => { fs.writeFileSync(path.join(dir, name), bytes); return path.join(dir, name); };
  const uploads = [];
  const jobs = [];
  const vf = readFixture('real/var-ttf/OpenSans-VF.ttf');
  const ss = readFixture('real/sourcesans-vf/SourceSans3VF-Upright.otf');
  uploads.push(put('OpenSans-VF.ttf', vf), put('SourceSans3VF.otf', ss));
  const infoN = await eng.run(['info', inp('f')], { inputs: { f: vf } });
  jobs.push({ id: 'info', argv: ['info', '@OpenSans-VF.ttf'], line: infoN.stdout[0] });
  for (const [id, file, args, src] of [['condensed-bold', 'OpenSans-VF.ttf', ['--at', 'wght=700,wdth=75'], vf],
    ['sourcesans-650', 'SourceSans3VF.otf', ['--downgrade-cff2', '--at', 'wght=650'], ss]]) {
    const r = await eng.run(['instance', ...args, inp('f'), OUT], { inputs: { f: src } });
    jobs.push({ id, argv: ['instance', ...args, `@${file}`, '#out'], sha: sha(r.out) });
  }
  const draws = [];
  for (const [key, id, inName, to, inst, table] of COLOUR) {
    let src = readFixture(id);
    if (inst) src = (await eng.run(['instance', ...inst[1], '--at', inst[0], inp('f'), OUT], { inputs: { f: src } })).out;
    const ff = await fontforge(src, inName, to);
    const r = await eng.run(['transplant', inp('s'), inp('o'), inp('m'), OUT], { inputs: { s: src, o: ff.font, m: ff.map } });
    uploads.push(put(`${key}.src`, src), put(`${key}.outline`, ff.font), put(`${key}.map`, ff.map), put(`${key}.out`, r.out));
    jobs.push({ id: `transplant-${key}`, argv: ['transplant', `@${key}.src`, `@${key}.outline`, `@${key}.map`, '#out'],
      sha: sha(r.out) });
    draws.push({ key, table, text: colourText(src) });
  }
  return { uploads, jobs, draws };
}

// Inked pixels (either picture; and each alone), differing ones, and the source's chromatic ones.
function compare(a, b) {
  let inked = 0;
  let inkedA = 0;
  let inkedB = 0;
  let differ = 0;
  let chromatic = 0;
  for (let i = 0; i < a.length; i += 4) {
    const ink = (p) => p[i] < 250 || p[i + 1] < 250 || p[i + 2] < 250;
    if (!ink(a) && !ink(b)) continue;
    inked++;
    if (ink(a)) inkedA++;
    if (ink(b)) inkedB++;
    if (Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2])) > DIFF_LEVEL) differ++;
    if (Math.max(a[i], a[i + 1], a[i + 2]) - Math.min(a[i], a[i + 1], a[i + 2]) > COLOUR_SPREAD) chromatic++;
  }
  return { inked, inkedA, inkedB, differ, chromatic };
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hbfont-browser-'));
  const { uploads, jobs, draws } = await prepare(dir);
  const PAGES = {
    '/': [path.join(__dirname, 'test-hbfont-browser.html'), 'text/html; charset=utf-8'],
    '/test-hbfont-browser-worker.js': [path.join(__dirname, 'test-hbfont-browser-worker.js'), 'text/javascript'],
    '/hbfont.js': [glue, 'text/javascript'],
    '/hbfont.wasm': [glue.replace(/\.js$/, '.wasm'), 'application/wasm'],
  };
  const server = http.createServer((req, res) => {
    const hit = PAGES[req.url.split('?')[0]];
    if (!hit) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': hit[1], 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(hit[0]));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const pw = require(PW);
  const type = which === 'chrome' ? pw.chromium : pw[which];
  const browser = await type.launch({ headless: true, channel: which === 'chrome' ? 'chrome' : undefined,
    proxy: { server: 'http://127.0.0.1:9', bypass: 'localhost,127.0.0.1' } });
  console.log(`playwright ${require(path.join(PW, 'package.json')).version}, ${which} ${browser.version()}, glue ${glue}`);
  let passed = 0;
  let total = 0;
  let na = 0;
  const check = (name, ok, detail) => {
    total++;
    if (ok) passed++;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ' -- ' + detail}`);
  };
  const matrix = [];
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(600000);
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.setInputFiles('#files', uploads);
    const report = await page.evaluate((j) => window.runWorker({ jobs: j }, 'posted'), jobs);
    if (report.fatal) console.log(`worker: ${report.fatal.slice(0, 300)}`);
    check('the compiled module is posted to the worker and instantiated there', report.sent === 'posted' &&
      report.module === 'posted', `${report.sent} / ${report.module}`);
    for (const job of jobs) {
      const r = report.results.find((x) => x.id === job.id) || {};
      if (job.line) check(`${job.id}: node's JSON line`, r.code === 0 && r.stdout[0] === job.line, JSON.stringify(r).slice(0, 200));
      else check(`${job.id}: node's bytes`, r.code === 0 && r.sha === job.sha, JSON.stringify(r).slice(0, 200));
    }
    const failed = await page.evaluate((j) => window.runWorker({ jobs: [j] }, 'fail'), jobs[1]);
    check('a module that cannot be cloned: the worker compiles its own and gives node\'s bytes',
      failed.sent === 'DataCloneError' && failed.module === 'compiled here' && failed.results[0] &&
      failed.results[0].sha === jobs[1].sha, JSON.stringify(failed).slice(0, 200));
    const oom = await page.evaluate((j) => window.runWorker({ kind: 'oom', jobs: [j] }, 'posted'), jobs[1]);
    const o = oom.oom || {};
    check('selftest-oom aborts at the 1 GiB ceiling with lastAbort() "oom"', Boolean(o.threw) && o.abort === 'oom' &&
      o.heap <= CEILING_BYTES && o.heap > CEILING_BYTES - 64 * 1048576, JSON.stringify(o));
    check('a fresh instance in the same worker then gives node\'s bytes', oom.results[0] &&
      oom.results[0].sha === jobs[1].sha && oom.results[0].lastAbort === null, JSON.stringify(oom.results).slice(0, 200));
    for (const d of draws) {
      const a = await page.evaluate(([n, t]) => window.draw(n, t), [`${d.key}.src`, d.text]);
      const b = await page.evaluate(([n, t]) => window.draw(n, t), [`${d.key}.out`, d.text]);
      if (KNOWN[d.key]) {
        const k = a.error || b.error ? null : compare(a.pixels, b.pixels);
        const share = k && k.inked ? `${((k.differ / k.inked) * 100).toFixed(2)} % of ${k.inked} inked pixels differ` : 'not drawn';
        matrix.push(`${d.table} (${d.key}): known limit, ${share}`);
        console.log(`KNOWN-LIMIT ${d.key} (${d.table}): ${KNOWN[d.key]}: ${share}`);
        continue;
      }
      if (a.error || b.error) {
        matrix.push(`${d.table} (${d.key}): ${a.error ? 'source refused' : 'source loads'}, ${b.error ? 'output refused' : 'output loads'}`);
        check(`${d.key} (${d.table}): the browser loads the source and the transplanted font`, false,
          `source: ${a.error || 'loaded'}; output: ${b.error || 'loaded'}`);
        continue;
      }
      const c = compare(a.pixels, b.pixels);
      if (c.inkedA < 200) { // the browser draws nothing for the source: not a pass, n/a (unsupported coverage)
        matrix.push(`${d.table} (${d.key}): the source draws nothing`);
        na++;
        console.log(`N/A ${d.key} (${d.table}): this browser draws nothing for the source (output: ${c.inkedB} inked pixels)`);
        continue;
      }
      const share = c.inked ? c.differ / c.inked : 1;
      const colour = c.inked > 0 && c.chromatic / c.inked > 0.02;
      matrix.push(`${d.table} (${d.key}): ${colour ? 'colour' : 'no colour'}`);
      check(`${d.key} (${d.table}): the transplanted font draws as its source (${(share * 100).toFixed(2)} % of ` +
        `${c.inked} inked pixels differ; the source draws ${colour ? 'colour' : 'no colour'} here)`,
      c.inked > 200 && share <= DIFF_SHARE, `${c.differ} of ${c.inked}`);
    }
  } catch (e) {
    check('the harness ran', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e));
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`MATRIX ${which}: ${matrix.join('; ')}`);
  const ok = passed === total && total + na === ROWS;
  console.log(`HBFONT-BROWSER-${ok ? 'OK' : 'FAIL'} ${which} ${passed}/${total}${na ? `, ${na} n/a` : ''}`);
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => {
  console.log(`HBFONT-BROWSER-FAIL ${which}: ${e && e.stack ? e.stack : e}`);
  process.exitCode = 1;
});
