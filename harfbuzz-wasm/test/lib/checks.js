'use strict';
// hbfont's result contract (fontconverter-web P3b plan, section 3.1; P3b-7) as predicates over an engine run.

const ERROR_LINE = /^hbfont: error: /;
const USAGE_LINE = /^hbfont: usage error: /;

function describe(r) {
  const err = r.threw ? `threw ${String(r.threw.message || r.threw).slice(0, 200)}` : `exit ${r.code}`;
  return `${err}; stdout ${JSON.stringify(r.stdout).slice(0, 200)}; stderr ${JSON.stringify(r.stderr).slice(0, 300)}`;
}

// The ids `hbfont error-ids` lists (the driver loads them before any case).
let ERROR_IDS = null;
function setErrorIds(ids) {
  ERROR_IDS = new Set(ids);
}
function errorIds() {
  return ERROR_IDS;
}

// The only stdout line of a failure: {"ok":false,"v":1,"command":...,"error":<a listed id>} (`id` when given).
function failureLine(r, id) {
  const j = r.json;
  return r.stdout.length === 1 && j !== null && j.ok === false && j.v === 1 && 'command' in j &&
    typeof j.error === 'string' && ERROR_IDS !== null && ERROR_IDS.has(j.error) && (!id || j.error === id);
}

// Exit 1, exactly one error line and it is the last stderr line, the failure line (with `id` when given), no output
// file, nothing thrown.
function cleanFailure(r, id) {
  const errs = r.stderr.filter((l) => ERROR_LINE.test(l));
  return !r.threw && r.code === 1 && !r.outExists && failureLine(r, id) && errs.length === 1 &&
    r.stderr[r.stderr.length - 1] === errs[0];
}

function usageFailure(r) {
  return !r.threw && r.code === 2 && !r.outExists && failureLine(r, 'usage') && r.stderr.length > 0 &&
    USAGE_LINE.test(r.stderr[0]);
}

// Exit 0, one JSON line with ok:true, nothing on stderr that says error, and an output file unless `noOutput`.
function success(r, noOutput) {
  return !r.threw && r.code === 0 && r.json !== null && r.json.ok === true &&
    !r.stderr.some((l) => ERROR_LINE.test(l) || USAGE_LINE.test(l)) && (noOutput ? !r.outExists : r.outExists);
}

module.exports = { cleanFailure, describe, errorIds, failureLine, setErrorIds, success, usageFailure };
