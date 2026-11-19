'use strict';
// The font fixture corpus, named once (P2 plan, section 4.1; adapted from font-wasm/test/lib/fixtures.js at
// 840fd65d8). Root: $FONT_FIXTURES or the external drive. A missing fixture fails loudly; nothing is skipped.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

if (!process.env.FONT_FIXTURES) {
  throw new Error('Set FONT_FIXTURES to the font fixture corpus (the sample-font-files folder of the test drive)');
}
const FONT_FIXTURES = process.env.FONT_FIXTURES;
const EXTERNAL_BASE = path.dirname(FONT_FIXTURES);
const STEP0 = 'p2-step0-2026-11-17'; // P2 plan, section 2: the spike's outputs and the measured job list

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

const cache = {};
function readJson(rel) {
  if (!cache[rel]) cache[rel] = JSON.parse(fs.readFileSync(requireFixture(rel), 'utf8'));
  return cache[rel];
}

const fontOracle = () => readJson('font-oracle.json');
const fontwrapOracle = () => readJson('fontwrap-oracle.json');

// The twin's requested output for an upload and a target, or null (none, or an empty file).
function twinFile(arch, fid, target) {
  const e = fontOracle().twin[`${arch}/${fid}/${target}`];
  if (!e || !e.requested_file || e.requested_empty) return null;
  return { rel: `twin/${arch}/${fid}/${target}/folder/${e.requested_file}`, sha256: e.files[e.requested_file].sha256 };
}

module.exports = { EXTERNAL_BASE, FONT_FIXTURES, STEP0, fontOracle, fontwrapOracle, fx, readFixture, readJson,
  requireFixture, sha256, twinFile };
