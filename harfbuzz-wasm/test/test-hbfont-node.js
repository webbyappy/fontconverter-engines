#!/usr/bin/env node
'use strict';
// test-hbfont-node.js -- the hbfont node harness (fontconverter-web docs/audits/P3b-VARIABLE-COLOUR-PLAN-2026-11-18.md,
// section 4.1): cases N0 to N12 against the fixtures on the external drive and hbfont-oracle.json.
//
//   node --no-maglev harfbuzz-wasm/test/test-hbfont-node.js [--only=N1,N11] [--fixture=<substring>]
//   HBFONT_ENGINE=native:harfbuzz-wasm/build/native/hbfont-asan node --no-maglev harfbuzz-wasm/test/test-hbfont-node.js
//
// Env: FONT_FIXTURES (fixture root), HBFONT_GLUE (another glue), HBFONT_ENGINE (wasm | native:<binary>).
// Final line: HBFONT-NODE-OK|FAIL (wasm) or HBFONT-NATIVE-OK|FAIL (native); a filtered run prints -PARTIAL and never
// counts as OK. Judge by that line, not by the exit status.

const fs = require('fs');
const path = require('path');
const { makeEngine } = require('./lib/engine');
const { Report } = require('./lib/report');
const { setErrorIds } = require('./lib/checks');

// The cases that exist; each is added with its own RED run (plan, section 5, D2).
const CASES = fs.readdirSync(path.join(__dirname, 'cases')).filter((n) => /^n\d\d-.*\.js$/.test(n)).sort()
  .map((n) => n.slice(0, -3));
const KNOWN_LIMITS = { wasm: 0, native: 0 };

function option(name) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

async function main() {
  const only = option('only') ? option('only').split(',').map((s) => s.trim().toUpperCase()) : null;
  const fixture = option('fixture');
  const eng = makeEngine();
  const rep = new Report(eng.kind === 'wasm' ? 'HBFONT-NODE' : 'HBFONT-NATIVE', KNOWN_LIMITS[eng.kind],
    Boolean(only || fixture));
  let ready = false;
  if (eng.available()) {
    await eng.init();
    ready = true;
    // The failure line's ids (P3b-7): every failure row checks its id against this list; N1 checks the list itself.
    const ids = await eng.run(['error-ids']);
    if (ids.json && ids.json.ok === true && Array.isArray(ids.json.ids)) setErrorIds(ids.json.ids);
  }
  const ctx = {
    eng, rep, kind: eng.kind, filtered: Boolean(fixture),
    keep: (id) => !fixture || id.includes(fixture),
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
  console.log(`HBFONT-NODE-FAIL harness error: ${e && e.stack ? e.stack : e}`);
  process.exitCode = 1;
});
