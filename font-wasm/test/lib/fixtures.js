'use strict';
// The font fixture corpus, named once (P1 plan, section 3.5). Root: $FONT_FIXTURES or the external drive.
// A missing fixture fails loudly; nothing is skipped.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

if (!process.env.FONT_FIXTURES) {
  throw new Error('Set FONT_FIXTURES to the font fixture corpus (the sample-font-files folder of the test drive)');
}
const FONT_FIXTURES = process.env.FONT_FIXTURES;
const EXTERNAL_BASE = path.dirname(FONT_FIXTURES);

function fx(rel) {
  return path.join(FONT_FIXTURES, rel);
}

function requireFixture(rel) {
  const p = fx(rel);
  if (!fs.existsSync(p)) {
    throw new Error(`Required fixture missing: ${p}\nIs the External HDD mounted at ${EXTERNAL_BASE}?`);
  }
  return p;
}

function readFixture(rel) {
  return fs.readFileSync(requireFixture(rel));
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

let fontOracleCache = null;
function fontOracle() {
  if (!fontOracleCache) fontOracleCache = JSON.parse(fs.readFileSync(requireFixture('font-oracle.json'), 'utf8'));
  return fontOracleCache;
}

// Production's own outputs, not in font-oracle.json's fixture list (checked against its twin records before use).
const GOLDEN_OPENSANS_WOFF =
  'production-goldens-2026-11-16/OpenSans-Regular.ttf/woff/extracted/OpenSans-Regular.woff';

module.exports = { EXTERNAL_BASE, FONT_FIXTURES, GOLDEN_OPENSANS_WOFF, fontOracle, fx, readFixture, requireFixture,
  sha256 };
