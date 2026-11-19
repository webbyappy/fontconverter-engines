'use strict';
// PASS / FAIL / KNOWN-LIMIT / N/A lines and the final marker. Copied unchanged from font-wasm/test/lib/report.js at
// wasm repo 840fd65d8 (P2 plan, P2-21).

class Report {
  constructor(marker, expectedKnown, partial) {
    this.marker = marker; // 'FFCONV-NODE' or 'FFCONV-NATIVE'
    this.expectedKnown = expectedKnown;
    this.partial = partial; // a run filtered by --only or --fixture never claims OK
    this.passed = 0;
    this.failed = 0;
    this.known = [];
    this.na = 0;
    this.group = '';
  }

  start(group) {
    this.group = group;
    console.log(`== ${group}`);
  }

  pass(name, detail) {
    this.passed++;
    console.log(`PASS ${this.group} ${name}${detail ? ' -- ' + detail : ''}`);
  }

  fail(name, detail) {
    this.failed++;
    console.log(`FAIL ${this.group} ${name}${detail ? ' -- ' + detail : ''}`);
  }

  check(name, ok, detail) {
    if (ok) this.pass(name);
    else this.fail(name, detail);
    return ok;
  }

  // A named limitation that behaved exactly as recorded. Behaving differently is a FAIL: "limit changed".
  knownLimit(name, behavedAsRecorded, detail) {
    if (behavedAsRecorded) {
      this.known.push(name);
      console.log(`KNOWN-LIMIT ${this.group} ${name}${detail ? ' -- ' + detail : ''}`);
    } else {
      this.fail(name, 'limit changed: ' + (detail || ''));
    }
  }

  notApplicable(name, why) {
    this.na++;
    console.log(`N/A ${this.group} ${name} -- ${why}`);
  }

  // Iterating the wrong number of items is a failure: a gate that passes on nothing proves nothing.
  count(name, got, want) {
    return this.check(`${name}: iterated ${want}`, got === want, `iterated ${got}, expected ${want}`);
  }

  finish() {
    const tail = `${this.passed} passed, ${this.failed} failed, ${this.known.length} known limits` +
      (this.na ? `, ${this.na} n/a` : '');
    let ok = this.failed === 0;
    if (this.partial) {
      console.log(`${this.marker}-PARTIAL ${tail} (filtered run; never counts as OK)`);
      return ok ? 0 : 1;
    }
    if (this.known.length !== this.expectedKnown) {
      console.log(`FAIL known limits: ${this.known.length} seen, ${this.expectedKnown} expected`);
      ok = false;
    }
    console.log(`${this.marker}-${ok ? 'OK' : 'FAIL'} ${tail}`);
    return ok ? 0 : 1;
  }
}

module.exports = { Report };
