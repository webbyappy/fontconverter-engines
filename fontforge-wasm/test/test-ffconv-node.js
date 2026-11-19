#!/usr/bin/env node
'use strict';
// test-ffconv-node.js -- the ffconv node harness (P2 plan, fontconverter-web docs/audits/P2-FFCONV-PLAN-2026-11-17.md,
// section 5): cases N0 to N12 against font-oracle.json, fontwrap-oracle.json, the twin and ffconv-oracle.json.
//
//   TZ=UTC node --no-maglev fontforge-wasm/test/test-ffconv-node.js [--only=N3,N4] [--fixture=<substring>]
//   TZ=UTC FFCONV_ENGINE=native:fontforge-wasm/build/native/ffconv-asan node --no-maglev fontforge-wasm/test/test-ffconv-node.js
//
// Env: FONT_FIXTURES (fixture root), FFCONV_GLUE (another glue), FFCONV_ENGINE (wasm | native:<binary>),
// FFCONV_ORACLE_FILE (another ffconv-oracle.json). Refuses to start unless TZ=UTC (P2-7: SVG metadata carries local
// time). Final line: FFCONV-NODE-OK|FAIL (wasm) or FFCONV-NATIVE-OK|FAIL (native); a filtered run prints -PARTIAL and
// never counts as OK. Judge by that line, not by the exit status.

const path = require('path');
const { makeEngine } = require('./lib/engine');
const { Report } = require('./lib/report');
const { setErrorIds } = require('./lib/checks');

const CASES = ['n00-harness', 'n01-contract', 'n02-pairs', 'n03-parity', 'n04-baseline', 'n05-cid', 'n06-fail-closed',
  'n07-no-shell', 'n08-legacy', 'n09-names', 'n10-memory', 'n11-glue', 'n12-recorded', 'n13-p3b'];
const KNOWN_LIMITS = { wasm: 1, native: 1 }; // P2 plan, section 5: --allow-lossy cannot help a CFF2 font

function option(name) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

async function main() {
  if (process.env.TZ !== 'UTC') {
    console.log('FFCONV-NODE-FAIL run with TZ=UTC (SVG outputs carry the local time; the oracle was made in UTC)');
    process.exitCode = 1;
    return;
  }
  const only = option('only') ? option('only').split(',').map((s) => s.trim().toUpperCase()) : null;
  const fixture = option('fixture');
  const eng = makeEngine();
  const rep = new Report(eng.kind === 'wasm' ? 'FFCONV-NODE' : 'FFCONV-NATIVE', KNOWN_LIMITS[eng.kind],
    Boolean(only || fixture));
  let ready = false;
  if (eng.available()) {
    await eng.init();
    ready = true;
    // The failure line's ids (P3b plan, P3b-7): every failure row checks its id against this list; N13 checks it.
    const ids = await eng.run(['error-ids']);
    if (ids.json && ids.json.ok === true && Array.isArray(ids.json.ids)) setErrorIds(ids.json.ids);
  }
  const ctx = {
    eng, rep, kind: eng.kind, filtered: Boolean(fixture), outputs: new Map(), // op key -> run (lib/convert.js)
    keep: (id) => !fixture || id.includes(fixture),
    // Iteration counts are asserted only on unfiltered runs (P1's lesson: a count break must run unfiltered).
    count: (name, got, want) => (fixture ? true : rep.count(name, got, want)),
  };
  for (const name of CASES) {
    if (only && !only.includes('N' + Number(name.slice(1, 3)))) continue;
    const c = require(path.join(__dirname, 'cases', name));
    rep.start(`${c.id} ${c.title}`);
    if (c.needsEngine && !ready) {
      rep.fail('engine', `engine not built: ${eng.kind === 'wasm' ? eng.gluePath : eng.binary} missing`);
      continue;
    }
    try {
      await c.run(ctx);
    } catch (e) {
      rep.fail('threw', e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e));
    }
  }
  if (eng.kind === 'native' && eng.reports) console.log(`sanitizer reports logged in ${eng.reports}`);
  process.exitCode = rep.finish();
}

main().catch((e) => {
  console.log(`FFCONV-NODE-FAIL harness error: ${e && e.stack ? e.stack : e}`);
  process.exitCode = 1;
});
