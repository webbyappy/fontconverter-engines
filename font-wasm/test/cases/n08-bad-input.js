'use strict';
// N8: bad input fails closed: exit 1, exactly one `fontwrap: error:` line, no output file even when a stale file was
// at the output path; usage errors exit 2 and touch nothing (P1 plan, P1-2 and section 4).

const { fontOracle, fx, readFixture } = require('../lib/fixtures');
const { IN, IN_ALIAS, OUT } = require('../lib/engine');
const { compareGlyphs } = require('../lib/glyf');
const { cleanFailure, describe, success, usageFailure } = require('../lib/checks');

const STALE = Buffer.from('stale output of an earlier run');
const COMMANDS = ['woff-encode', 'woff2-encode', 'eot-encode', 'woff-decode', 'woff2-decode', 'eot-decode'];
const SFNT = 'samples/slick.ttf';
const WOFF = 'generated/fonttools-wrapped/samples/slick.ttf.woff';
const WOFF2 = 'generated/fonttools-wrapped/samples/slick.ttf.woff2';
const EOT = 'generated/eot/slick.plain.eot';
const INITIAL_HEAP = 64 * 1024 * 1024; // bytes: -sINITIAL_MEMORY
const MUTANTS_PER_PAIR = 100;
const UNI0482 = 561; // glyph id of uni0482 in OpenSans-Regular.ttf (fontTools)
const LONG_MAC_NAME_BYTES = 40000; // Mac Roman; 80,000 bytes as UTF-16, past the EOT header's 16-bit name size
const WOFF2_CLAIM_BYTES = 600 * 1024 * 1024; // declared table data, over the 512 MiB output limit
const WOFF2_CLAIM_STREAM_BYTES = 6.4 * 1024 * 1024; // keeps the claim under google/woff2's 100:1 plausibility ratio

function patched(buf, edit) {
  const b = Buffer.from(buf);
  edit(b);
  return b;
}

async function expectRefused(ctx, label, cmd, input, re) {
  const args = cmd === 'info' ? ['info', IN] : [cmd, IN, OUT];
  const r = await ctx.eng.run(args, { input, inName: 'bad.input', outName: 'out.bin', stale: cmd === 'info' ? null : STALE });
  return ctx.rep.check(`${cmd} refuses ${label}`, cleanFailure(r, re), describe(r));
}

async function fixtureCases(ctx) {
  const ids = Object.keys(fontOracle().fixtures).filter((id) => id.startsWith('generated/bad-input/') &&
    !id.endsWith('.woff')).sort();
  for (const id of ids.filter(ctx.keep)) {
    for (const cmd of ['info', ...COMMANDS]) await expectRefused(ctx, id, cmd, { path: fx(id) });
  }
  ctx.count('bad-input fixtures', ids.length, 15);
  await expectRefused(ctx, 'woff-corrupt-table.woff', 'woff-decode', { path: fx('generated/bad-input/woff-corrupt-table.woff') },
    /does not inflate to its declared 78592 bytes/);
  const claim = { path: fx('generated/bad-input/woff-inflate-2000x.woff') };
  await expectRefused(ctx, 'woff-inflate-2000x.woff', 'info', claim, /claims to inflate/);
  const r = await ctx.eng.run(['woff-decode', IN, OUT], { input: claim, outName: 'out.ttf', stale: STALE });
  ctx.rep.check('woff-decode refuses woff-inflate-2000x.woff before allocating', cleanFailure(r, /claims to inflate/) &&
    (ctx.kind !== 'wasm' || r.heap === INITIAL_HEAP), `${describe(r)}; heap ${r.heap}`);
}

function sfntRecipes() {
  return [
    ['0 tables', (b) => b.writeUInt16BE(0, 4)],
    ['65,535 tables', (b) => b.writeUInt16BE(0xffff, 4)],
    ['a table past the end', (b) => b.writeUInt32BE(b.length, 12 + 8)],
    ['length 0xFFFFFFF0', (b) => b.writeUInt32BE(0xfffffff0, 12 + 12)],
    ['a table inside the directory', (b) => b.writeUInt32BE(12, 12 + 8)],
    ['a duplicate tag', (b) => b.copy(b, 12 + 16, 12, 16)],
    ['an unknown version', (b) => b.writeUInt32BE(0xdeadbeef, 0)],
  ];
}

function woffRecipes(w) {
  const len = w.length;
  const n = w.readUInt16BE(12);
  const entries = [...Array(n).keys()].map((i) => ({ i, off: w.readUInt32BE(44 + 20 * i + 4), comp: w.readUInt32BE(44 + 20 * i + 8) }))
    .sort((a, b) => a.off - b.off);
  const padded = entries.find((e) => e.comp % 4 !== 0);
  if (!padded) throw new Error(`${WOFF} has no table with padding to damage`);
  return [
    ['a bad signature', (b) => b.write('wOFX', 0, 'latin1')],
    ['length too large', (b) => b.writeUInt32BE(len + 4, 8)],
    ['length too small', (b) => b.writeUInt32BE(len - 4, 8)],
    ['reserved not zero', (b) => b.writeUInt16BE(1, 14)],
    ['a wrong totalSfntSize', (b) => b.writeUInt32BE(b.readUInt32BE(16) + 4, 16)],
    ['0 tables', (b) => b.writeUInt16BE(0, 12)],
    ['65,535 tables', (b) => b.writeUInt16BE(0xffff, 12)],
    ['flavour ttcf', (b) => b.write('ttcf', 4, 'latin1')],
    ['a table past the end', (b) => b.writeUInt32BE(len, 44 + 4)],
    ['compLength above origLength', (b) => b.writeUInt32BE(b.readUInt32BE(44 + 12) + 4, 44 + 8)],
    ['overlapping tables', (b) => b.writeUInt32BE(b.readUInt32BE(44 + 4), 64 + 4)],
    ['a duplicate tag', (b) => b.copy(b, 64, 44, 48)],
    ['a metadata block past the end', (b) => { b.writeUInt32BE(len, 24); b.writeUInt32BE(8, 28); b.writeUInt32BE(8, 32); }],
    ['a padding byte set to 0x7F', (b) => { b[padded.off + padded.comp] = 0x7f; }, /extraneous data/],
  ];
}

function woff2Recipes(w) {
  return [
    ['a bad signature', (b) => b.write('wOFX', 0, 'latin1')],
    ['a wrong length', (b) => b.writeUInt32BE(w.length + 4, 8)],
    ['0 tables', (b) => b.writeUInt16BE(0, 12)],
    ['a wrong totalCompressedSize', (b) => b.writeUInt32BE(b.readUInt32BE(20) + 1000, 20)],
  ];
}

function eotRecipes(e) {
  const off = e.length - e.readUInt32LE(4);
  return [
    ['a bad magic number', (b) => b.writeUInt16LE(0x1234, 34)],
    ['a wrong EOTSize', (b) => b.writeUInt32LE(e.length + 1, 0)],
    ['FontDataSize too large', (b) => b.writeUInt32LE(e.length, 4)],
    ['FontDataSize 0', (b) => b.writeUInt32LE(0, 4)],
    ['FontDataSize 0xFFFFFFF0', (b) => b.writeUInt32LE(0xfffffff0, 4)],
    ['an unknown version', (b) => b.writeUInt32LE(0x00030000, 8)],
    ['a payload that is not an sfnt', (b) => b.write('abcd', off, 'latin1')],
    ['the XOR flag on plain data', (b) => b.writeUInt32LE(b.readUInt32LE(12) | 0x10000000, 12)],
    ['the MTX flag on plain data', (b) => b.writeUInt32LE(b.readUInt32LE(12) | 0x4, 12)],
  ];
}

function renameTable(buf, from, to) {
  return patched(buf, (b) => {
    const n = b.readUInt16BE(4);
    for (let i = 0; i < n; i++) if (b.toString('latin1', 12 + 16 * i, 16 + 16 * i) === from) b.write(to, 12 + 16 * i, 'latin1');
  });
}

async function recipeCases(ctx) {
  const sfnt = readFixture(SFNT);
  for (const [label, edit] of sfntRecipes()) {
    for (const cmd of ['info', 'woff-encode', 'woff2-encode', 'eot-encode']) await expectRefused(ctx, `an sfnt with ${label}`, cmd, patched(sfnt, edit));
  }
  const woff = readFixture(WOFF);
  for (const [label, edit, re] of woffRecipes(woff)) {
    for (const cmd of ['info', 'woff-decode']) await expectRefused(ctx, `a WOFF with ${label}`, cmd, patched(woff, edit), re);
  }
  const woff2 = readFixture(WOFF2);
  for (const [label, edit] of woff2Recipes(woff2)) await expectRefused(ctx, `a WOFF2 with ${label}`, 'woff2-decode', patched(woff2, edit));
  const eot = readFixture(EOT);
  for (const [label, edit] of eotRecipes(eot)) {
    // info reads the header and a plain or XOR payload's directory; it never decompresses, so an MTX flag is not its to judge
    const cmds = label === 'the MTX flag on plain data' ? ['eot-decode'] : ['info', 'eot-decode'];
    for (const cmd of cmds) await expectRefused(ctx, `an EOT with ${label}`, cmd, patched(eot, edit));
  }
  for (const [from, to] of [['OS/2', 'OS/3'], ['name', 'nbme'], ['head', 'hexd']]) {
    await expectRefused(ctx, `a font without ${from}`, 'eot-encode', renameTable(sfnt, from, to));
  }
  const wrong = { 'woff-decode': [SFNT, WOFF2, EOT], 'woff2-decode': [SFNT, WOFF, EOT], 'eot-decode': [SFNT, WOFF, WOFF2],
    'woff-encode': [WOFF, WOFF2, EOT], 'woff2-encode': [WOFF, WOFF2, EOT], 'eot-encode': [WOFF, WOFF2, EOT] };
  for (const [cmd, inputs] of Object.entries(wrong)) {
    for (const id of inputs) await expectRefused(ctx, `the wrong container (${id})`, cmd, { path: fx(id) });
  }
}

async function truncations(ctx) {
  const src = { path: fx(SFNT) };
  for (const [enc, dec] of [['woff-encode', 'woff-decode'], ['woff2-encode', 'woff2-decode'], ['eot-encode', 'eot-decode']]) {
    const e = await ctx.eng.run([enc, IN, OUT], { input: src, outName: 'own.bin' });
    if (!ctx.rep.check(`${enc} of ${SFNT} for the cuts`, success(e), describe(e))) continue;
    const len = e.out.length;
    const cuts = [...new Set([1, 2, 4, 8, 12, 16, 20, 32, 44, 60, len >> 2, len >> 1, (3 * len) >> 2, len - 16, len - 4,
      len - 2, len - 1])].filter((c) => c > 0 && c < len);
    for (const c of cuts) await expectRefused(ctx, `our ${enc.split('-')[0]} cut at ${c} of ${len}`, dec, e.out.subarray(0, c));
    ctx.count(`${dec} cuts`, cuts.length, 17);
  }
}

async function usage(ctx) {
  const input = readFixture(SFNT);
  const cases = [['no arguments', []], ['an unknown command', ['frobnicate', IN, OUT]],
    ['an unknown option', ['woff-encode', '--bogus', IN, OUT]], ['a missing argument', ['woff-encode', IN]],
    ['quality 12', ['woff2-encode', '--quality=12', IN, OUT]], ['input = output', ['woff-encode', IN, IN]],
    ['input = output under another spelling', ['woff-encode', IN, IN_ALIAS]]];
  for (const [label, args] of cases) {
    const inst = ctx.kind === 'wasm' ? await ctx.eng.instance() : null;
    const r = await ctx.eng.run(args, { input, inName: 'in.ttf', outName: 'out.woff', stale: STALE, instance: inst,
      checkInput: true });
    const staleKept = args.includes(OUT) ? r.outExists && r.out.equals(STALE) : true;
    const inputKept = Boolean(r.inAfter) && r.inAfter.equals(input);
    ctx.rep.check(`usage error: ${label}`, usageFailure(r) && staleKept && inputKept,
      `${describe(r)}${inputKept ? '' : '; the input was deleted or changed'}`);
  }
  const r = await ctx.eng.run(['woff-encode', IN, OUT], { inName: 'does-not-exist.ttf', outName: 'out.woff', stale: STALE });
  ctx.rep.check('a missing input is bad input (exit 1) and the stale output is removed', cleanFailure(r), describe(r));
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function mutants(ctx) {
  if (ctx.kind !== 'wasm') { ctx.rep.notApplicable('wasm mutants', 'the native mutation sweep covers this'); return; }
  const pairs = [['woff-decode', WOFF], ['woff2-decode', WOFF2], ['eot-decode', EOT],
    ['eot-decode', 'generated/eot/slick.mtx.eot'], ['woff-encode', SFNT], ['info', SFNT]];
  for (const [cmd, id] of pairs) {
    const base = readFixture(id);
    const rnd = mulberry32(20261117 + base.length);
    const inst = await ctx.eng.instance();
    let bad = null;
    for (let k = 0; k < MUTANTS_PER_PAIR && !bad; k++) {
      const m = Buffer.from(base);
      const flips = 1 + Math.floor(rnd() * 4);
      for (let j = 0; j < flips; j++) m[Math.floor(rnd() * m.length)] ^= 1 << Math.floor(rnd() * 8);
      const r = await ctx.eng.run(cmd === 'info' ? ['info', IN] : [cmd, IN, OUT], { input: m, outName: 'out.bin', instance: inst });
      const ok = r.code === 1 ? cleanFailure(r) : r.code === 0 && success(r, cmd === 'info');
      if (!ok) bad = `mutant ${k}: ${describe(r)}`;
    }
    ctx.rep.check(`${MUTANTS_PER_PAIR} mutants of ${id} through ${cmd} keep the contract on one instance`, !bad, bad);
  }
}

// The native mutation sweep's two findings (P1 results 12.5): slick's MTX EOT with these bytes changed decodes to a
// font with glyf but no loca; libeot's parseCTF then added loca to a full table array, realloc moved it, and the head
// pointer it kept was read after free (ASan, parseTTF.c:16). Fixed by `font-wasm patch` 1 (VENDORING.md).
const MTX_SWEEP_FINDINGS = [
  ['mutant 1', [[231, 0xd5], [402, 0x3c], [629, 0x32], [993, 0xdc]]],
  ['mutant 2', [[88, 0x68], [231, 0x8e]]],
];

async function mtxRegressions(ctx) {
  const base = readFixture('generated/eot/slick.mtx.eot');
  for (const [label, edits] of MTX_SWEEP_FINDINGS) {
    const m = patched(base, (b) => { for (const [at, v] of edits) b[at] = v; });
    const r = await ctx.eng.run(['eot-decode', IN, OUT], { input: m, outName: 'out.ttf', stale: STALE });
    ctx.rep.check(`sweep finding (${label}): an MTX font with glyf but no loca keeps the contract, no memory error`,
      cleanFailure(r) || success(r), describe(r));
  }
}

// A font whose only family name is a Mac Roman string too long for the EOT header's 16-bit size once it is UTF-16:
// the old name table stays in place as dead space and the directory points at a new one appended at the end.
function withLongMacName(sfnt) {
  const name = Buffer.alloc(6 + 12 + LONG_MAC_NAME_BYTES, 0x41);
  name.writeUInt16BE(0, 0);
  name.writeUInt16BE(1, 2);
  name.writeUInt16BE(18, 4);
  [1, 0, 0, 1, LONG_MAC_NAME_BYTES, 0].forEach((v, i) => name.writeUInt16BE(v, 6 + 2 * i));
  const at = (sfnt.length + 3) & ~3;
  const out = Buffer.concat([sfnt, Buffer.alloc(at - sfnt.length), name]);
  const n = out.readUInt16BE(4);
  for (let i = 0; i < n; i++) {
    const r = 12 + 16 * i;
    if (out.toString('latin1', r, r + 4) === 'name') {
      out.writeUInt32BE(at, r + 8);
      out.writeUInt32BE(name.length, r + 12);
    }
  }
  return out;
}

// A WOFF2 whose one table claims 600 MiB, followed by 6.4 MB of data that is no Brotli stream: within google/woff2's
// 100:1 ratio, so without a check of its own the library reserves the whole claim before Brotli fails.
function woff2WithHugeClaim() {
  const base128 = (v) => {
    const out = [v & 0x7f];
    for (let x = Math.floor(v / 128); x > 0; x = Math.floor(x / 128)) out.unshift(0x80 | (x & 0x7f));
    return Buffer.from(out);
  };
  const dir = Buffer.concat([Buffer.from([5]), base128(WOFF2_CLAIM_BYTES)]); // flags 5 = 'name', null transform
  const stream = Buffer.alloc(Math.floor(WOFF2_CLAIM_STREAM_BYTES), 0xa5);
  const header = Buffer.alloc(48);
  header.write('wOF2', 0, 'latin1');
  header.writeUInt32BE(0x00010000, 4);
  header.writeUInt32BE(48 + dir.length + stream.length, 8);
  header.writeUInt16BE(1, 12);
  header.writeUInt32BE(12 + 16 + WOFF2_CLAIM_BYTES, 16);
  header.writeUInt32BE(stream.length, 20);
  header.writeUInt16BE(1, 24);
  return Buffer.concat([header, dir, stream]);
}

// Review findings after P1 (P1 results 12.6): limits that must hold before any work or allocation.
async function reviewLimits(ctx) {
  const sfnt = readFixture(SFNT);
  await expectRefused(ctx, `a font whose only family name is ${LONG_MAC_NAME_BYTES} bytes of Mac Roman`, 'eot-encode',
    withLongMacName(sfnt), /too long for an EOT/);
  const inst = ctx.kind === 'wasm' ? await ctx.eng.instance() : null;
  const r = await ctx.eng.run(['woff2-decode', IN, OUT], { input: woff2WithHugeClaim(), inName: 'claim.woff2',
    outName: 'out.ttf', stale: STALE, instance: inst });
  ctx.rep.check('woff2-decode refuses a WOFF2 declaring 600 MiB of table data before reserving it',
    cleanFailure(r, null, 'output-limit') && (r.heap === null || r.heap <= INITIAL_HEAP), `${describe(r)}; heap ${r.heap}`);
}

async function brotliDamage(ctx) {
  const src = readFixture('samples/OpenSans-Regular.ttf');
  const e = await ctx.eng.run(['woff2-encode', '--quality=11', IN, OUT], { input: src, outName: 'out.woff2' });
  if (!ctx.rep.check('woff2-encode OpenSans for the stream damage', success(e), describe(e))) return;
  // Spike S2's stream damages on its own base (our OpenSans WOFF2): these three were rejected there. (On slick's tiny
  // WOFF2 a flipped bit can land where nothing notices: WOFF2 has no checksum, P1 results 12.3.)
  for (const [label, edit] of [['the last 64 bytes zeroed', (b) => b.fill(0, b.length - 64)],
    ['1 bit flipped at 25 %', (b) => { b[Math.floor(b.length / 4)] ^= 0x10; }],
    ['1 bit flipped at 75 %', (b) => { b[Math.floor(b.length * 3 / 4)] ^= 0x10; }]]) {
    await expectRefused(ctx, `our OpenSans WOFF2 with ${label}`, 'woff2-decode', patched(e.out, edit));
  }
  const m = patched(e.out, (b) => { const mid = Math.floor(b.length / 2); for (let i = 0; i < 16; i++) b[mid + i] ^= 0xff; });
  const d = await ctx.eng.run(['woff2-decode', IN, OUT], { input: m, outName: 'out.ttf' });
  const g = d.out ? compareGlyphs({ font: src }, { font: d.out }) : null;
  ctx.rep.knownLimit('16 bytes flipped mid-Brotli decode with exit 0 and glyph uni0482 changed (WOFF2 has no checksum)',
    success(d) && g && JSON.stringify(g.differing) === JSON.stringify([UNI0482]), `${describe(d)}; ${g ? g.differing : ''}`);
}

module.exports = {
  id: 'N8', title: 'bad input', needsEngine: true,
  async run(ctx) {
    await fixtureCases(ctx);
    if (ctx.filtered) return;
    await recipeCases(ctx);
    await truncations(ctx);
    await usage(ctx);
    await mutants(ctx);
    await mtxRegressions(ctx);
    await reviewLimits(ctx);
    await brotliDamage(ctx);
  },
};
