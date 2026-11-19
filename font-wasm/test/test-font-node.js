#!/usr/bin/env node
'use strict';
// test-font-node.js -- the fontwrap node harness (P1 plan, fontconverter-web docs/audits/P1-FONTWRAP-PLAN-2026-11-17.md,
// section 4): cases N0 to N12 against font-oracle.json and fontwrap-oracle.json on the external drive.
//
//   node --no-maglev font-wasm/test/test-font-node.js [--only=N3,N4] [--fixture=<substring>]
//   FONTWRAP_ENGINE=native:font-wasm/build/native/fontwrap-asan node --no-maglev font-wasm/test/test-font-node.js
//
// Env: FONT_FIXTURES (fixture root), FONTWRAP_GLUE (another glue), FONTWRAP_ENGINE (wasm | native:<binary>).
// Final line: FONTWRAP-NODE-OK|FAIL (wasm) or FONTWRAP-NATIVE-OK|FAIL (native); a filtered run prints -PARTIAL and
// never counts as OK. Judge by that line, not by the exit status.

const path = require('path');
const { makeEngine } = require('./lib/engine');
const { Report } = require('./lib/report');
const { setErrorIds } = require('./lib/checks');

const CASES = ['n00-harness', 'n01-contract', 'n02-info', 'n03-woff', 'n04-woff2', 'n05-cross', 'n06-eot',
  'n07-production', 'n08-bad-input', 'n09-special', 'n10-reuse-names', 'n11-glue', 'n12-recorded', 'n13-p3b'];
// P1 plan, section 4; P3b (fontconverter-web P3b plan, P3b-6): the MTX of Noto COLRv1 is no longer a known limit in
// wasm but a pinned out-of-memory row (N6, N13).
const KNOWN_LIMITS = { wasm: 2, native: 2 };

function option(name) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

async function main() {
  const only = option('only') ? option('only').split(',').map((s) => s.trim().toUpperCase()) : null;
  const fixture = option('fixture');
  const eng = makeEngine();
  const rep = new Report(eng.kind === 'wasm' ? 'FONTWRAP-NODE' : 'FONTWRAP-NATIVE', KNOWN_LIMITS[eng.kind],
    Boolean(only || fixture));
  let ready = false;
  if (eng.available()) {
    await eng.init();
    ready = true;
    // The failure line's ids (P3b plan, P3b-7): every failure row checks its id against this list; N13 checks the
    // list itself.
    const ids = await eng.run(['error-ids']);
    if (ids.json && ids.json.ok === true && Array.isArray(ids.json.ids)) setErrorIds(ids.json.ids);
  }
  const ctx = {
    eng, rep, kind: eng.kind, filtered: Boolean(fixture),
    keep: (id) => !fixture || id.includes(fixture),
    // Iteration counts are asserted only on unfiltered runs.
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
  process.exitCode = rep.finish();
}

main().catch((e) => {
  console.log(`FONTWRAP-NODE-FAIL harness error: ${e && e.stack ? e.stack : e}`);
  process.exitCode = 1;
});
