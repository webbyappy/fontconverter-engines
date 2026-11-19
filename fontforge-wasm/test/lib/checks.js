'use strict';
// ffconv's result contract (P2 plan, P2-3) as predicates over an engine run (lib/engine.js).

const RESULT_FIELDS = ['ok', 'input', 'output', 'cidFlattened'];
const MAGIC = { ttf: [0x00, 0x01, 0x00, 0x00], otf: [0x4f, 0x54, 0x54, 0x4f] };

function describe(r) {
  const err = (r.stderr || []).slice(-2).join(' | ');
  return `exit ${r.code}${r.threw ? ' threw ' + String(r.threw.message || r.threw).slice(0, 200) : ''}` +
    `, stdout ${(r.stdout || []).length} line(s), stderr: ${err.slice(0, 300)}`;
}

function ffconvLines(r) {
  return (r.stderr || []).filter((l) => l.startsWith('ffconv:'));
}

function magicOk(out, ext) {
  if (!out || out.length === 0) return false;
  if (ext === 'svg') {
    const head = out.subarray(0, 256).toString('latin1').replace(/^﻿?\s*/, '');
    return head.startsWith('<?xml') || head.startsWith('<svg');
  }
  return MAGIC[ext].every((b, i) => out[i] === b);
}

// exit 0, exactly one stdout line with the result fields, no `ffconv:` line on stderr, an output of the target's kind.
function success(r, ext) {
  const why = [];
  if (r.threw) why.push('threw');
  if (r.code !== 0) why.push(`exit ${r.code}`);
  if (!r.json) why.push(`stdout is ${(r.stdout || []).length} line(s), not one JSON line`);
  else {
    const missing = RESULT_FIELDS.filter((f) => !(f in r.json));
    if (missing.length || r.json.ok !== true) why.push(`result fields: missing ${missing}, ok ${r.json.ok}`);
  }
  if (ffconvLines(r).length) why.push('an ffconv: line on stderr');
  if (!magicOk(r.out, ext)) why.push(`no ${ext} output`);
  return { ok: why.length === 0, why: why.join('; ') + (why.length ? ' -- ' + describe(r) : '') };
}

// exit 1, exactly one `ffconv: error:` line and it is the last stderr line, nothing at the output path.
// The ids `ffconv error-ids` lists (the driver loads them first; fontconverter-web P3b plan, P3b-7).
let ERROR_IDS = null;
function setErrorIds(ids) {
  ERROR_IDS = new Set(ids);
}

// The only stdout line of a failure: {"ok":false,"v":1,"command":...,"error":<a listed id>} (`id` when given).
function failureLine(r, id) {
  const j = r.json;
  return (r.stdout || []).length === 1 && j !== null && j.ok === false && j.v === 1 && 'command' in j &&
    typeof j.error === 'string' && ERROR_IDS !== null && ERROR_IDS.has(j.error) && (!id || j.error === id);
}

function cleanFailure(r, id) {
  const lines = ffconvLines(r);
  const last = (r.stderr || [])[r.stderr.length - 1] || '';
  const ok = !r.threw && r.code === 1 && lines.length === 1 && lines[0].startsWith('ffconv: error: ') &&
    last === lines[0] && !r.outExists && failureLine(r, id);
  return { ok, why: ok ? '' : describe(r) + (r.outExists ? ' (an output was left)' : '') };
}

// exit 2 and exactly one `ffconv: usage error:` line. A usage error touches no file: the caller checks that what it
// placed at the output path is still there, unchanged (N6), or that nothing appeared (N10).
function usageFailure(r) {
  const lines = ffconvLines(r);
  const ok = !r.threw && r.code === 2 && lines.length === 1 && lines[0].startsWith('ffconv: usage error: ') &&
    failureLine(r, 'usage');
  return { ok, why: ok ? '' : describe(r) };
}

module.exports = { RESULT_FIELDS, cleanFailure, describe, failureLine, magicOk, setErrorIds, success, usageFailure };
