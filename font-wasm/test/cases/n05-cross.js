'use strict';
// N5: fontwrap decodes the WOFF and WOFF2 files other tools wrote (fontTools, production, third parties) to the tables
// font-oracle.json records for them (fontTools' own decode). fontTools reading fontwrap's files is N12's job. Where
// fontTools itself misreads a file (the transformed hmtx of three of its own WOFF2s), the source is the reference.

const { fontOracle, fx, readFixture } = require('../lib/fixtures');
const { IN, OUT } = require('../lib/engine');
const oracle = require('../lib/oracle');
const { LOCA_SWITCH, decodable, extOf, opTable } = oracle;
const { checksum, hex32, readSfnt, tableBytes, woff2Directory } = require('../lib/sfnt');
const { compareGlyphs } = require('../lib/glyf');
const { describe, fontProblems, success, tablesByTag } = require('../lib/checks');

// Production's WOFF2 files have no source in the oracle; they were made from these samples.
const DERIVED_SOURCE = {
  'derived/OpenSans-Regular.woff2': 'samples/OpenSans-Regular.ttf',
  'derived/slick.woff2': 'samples/slick.ttf',
};

function factProblems(out, facts, skip) {
  const got = new Map(readSfnt(out).tables.map((t) => [t.tag, t]));
  const p = [];
  for (const w of facts.tables) {
    if (skip.includes(w.tag)) continue;
    const t = got.get(w.tag);
    if (!t) { p.push(`${w.tag} missing`); continue; }
    const sum = hex32(checksum(tableBytes(out, t), t.tag));
    if (t.length !== w.length || sum !== w.checksum) p.push(`${w.tag} ${t.length}/${sum} vs ${w.length}/${w.checksum}`);
  }
  if (got.size !== facts.tables.length) p.push(`${got.size} tables, oracle ${facts.tables.length}`);
  return p;
}

function hmtxLength(fact) {
  const t = fact && fact.font ? fact.font.tables.find((x) => x.tag === 'hmtx') : null;
  return t ? t.length : null;
}

// fontTools rebuilds the transformed hmtx of some WOFF2 files it wrote too short, then cannot read it back (P1 results
// 12.5). The signature in font-oracle.json: fontTools' decoded hmtx is shorter than the source's. The fixtures showing
// it must be exactly lib/oracle.js's list, each bound by sha256, so any change (a fontTools fix included) is "limit
// changed" and is reviewed. Their decode is judged against the source (N12) and, here, every table byte for byte.
function hmtxMisread(ctx, fo) {
  const signature = decodable('woff2')
    .filter((id) => fo[id].source && hmtxLength(fo[id]) < hmtxLength(fo[fo[id].source]));
  const listed = oracle.FONTTOOLS_HMTX_MISREAD || [];
  const listedIds = listed.map((x) => x.id).sort();
  const bound = listed.every((x) => fo[x.id] && fo[x.id].sha256 === x.sha256);
  ctx.rep.check('fontTools misreads the transformed hmtx of exactly the listed fixtures, bound by sha256 ' +
    '(else: limit changed)', JSON.stringify(signature) === JSON.stringify(listedIds) && bound,
    `signature: ${signature.join(', ')}; listed: ${listedIds.join(', ') || 'none'}`);
  const ops = new Map(opTable('wasm').map((o) => [o.key, o]));
  for (const id of signature) {
    const op = ops.get(`${id}#decode`);
    const ext = extOf(fo[id].flavour);
    ctx.rep.check(`judged against its source in the oracle (${ext}-${ext}, strict na, reason given): ${id}`,
      Boolean(op) && op.pair === `${ext}-${ext}` && op.scoreIn === 'expected' && op.expectedFrom === fo[id].source &&
      op.strictNa === true && typeof op.reason === 'string', JSON.stringify(op));
  }
  return signature;
}

// For one listed fixture: the directory really transforms hmtx and keeps the source's length (so the file is sound and
// the short reconstruction is fontTools'), and fontwrap's decode equals the source table by table.
function againstSource(id, f, srcId, out) {
  const src = readFixture(srcId);
  const p = [];
  const h = woff2Directory(readFixture(id)).tables.find((t) => t.tag === 'hmtx');
  const srcLength = tablesByTag(src).get('hmtx').length;
  if (!h || !h.transformed) p.push('hmtx is not transformed in the directory');
  else if (h.origLength !== srcLength) p.push(`directory hmtx origLength ${h.origLength}, source ${srcLength}`);
  if (!(hmtxLength(f) < srcLength)) p.push(`fontTools' hmtx (${hmtxLength(f)}) is not shorter than the source's`);
  p.push(...fontProblems(src, out, { rebuilt: true, bit11: true }));
  return p;
}

module.exports = {
  id: 'N5', title: 'cross-decoding', needsEngine: true,
  async run(ctx) {
    const fo = fontOracle().fixtures;
    const misread = hmtxMisread(ctx, fo);
    let n = 0;
    for (const kind of ['woff', 'woff2']) {
      for (const id of decodable(kind).filter(ctx.keep)) {
        n++;
        const f = fo[id];
        const ext = extOf(f.flavour);
        const d = await ctx.eng.run([`${kind}-decode`, IN, OUT], { input: { path: fx(id) }, inName: `in.${kind}`,
          outName: `out.${ext}` });
        if (!ctx.rep.check(`${kind}-decode ${id}`, success(d) && d.json.ext === ext, describe(d))) continue;
        // Tables the WOFF2 decoder rebuilds are judged against the source font, not against fontTools' own decode:
        // glyf/loca by decoded glyphs, a transformed hmtx byte for byte. (fontTools' decode of its hmtx-transformed
        // files is 2 bytes short for slick, Vera and Twemoji, whose source hmtx is exactly the length their metrics
        // need: P1 results 12.3.)
        const rebuilt = kind === 'woff2' ? ['glyf', 'loca', ...(id.endsWith('.hmtx.woff2') ? ['hmtx'] : [])] : [];
        const p = factProblems(d.out, f.font, rebuilt);
        const srcId = f.source || DERIVED_SOURCE[id];
        if (kind === 'woff2' && f.font.tables.some((t) => t.tag === 'glyf')) {
          const g = compareGlyphs({ font: readFixture(srcId) }, { font: d.out });
          if (!g.equal) p.push(`${g.differing.length} glyphs differ from ${srcId}`);
        }
        if (id.endsWith('.hmtx.woff2')) {
          const a = tablesByTag(readFixture(srcId)).get('hmtx');
          if (!a.equals(tablesByTag(d.out).get('hmtx'))) p.push('hmtx not rebuilt byte for byte');
        }
        ctx.rep.check(`decodes to the oracle's tables: ${id}`, p.length === 0, p.slice(0, 4).join('; '));
        // fontTools wrapped these straight from their source: every table must come back as the source has it. WOFF2
        // allows what any WOFF2 encoder does: glyf/loca judged by glyphs, head's checkSumAdjustment and flags bit 11,
        // DSIG dropped, and for the one loca-switch font head.indexToLocFormat (fontTools pads glyphs as google/woff2
        // does, P1 results 12.4). Plan N5.
        if (id.startsWith('generated/fonttools-wrapped/') && !misread.includes(id)) {
          const w2 = kind === 'woff2';
          const q = fontProblems(readFixture(srcId), d.out, { rebuilt: w2, bit11: w2, dropped: w2 ? ['DSIG'] : [],
            locFormat: w2 && srcId === LOCA_SWITCH.id });
          ctx.rep.check(`decodes to the source font table by table: ${id}`, q.length === 0, q.slice(0, 4).join('; '));
        }
        if (misread.includes(id)) {
          const q = againstSource(id, f, srcId, d.out);
          ctx.rep.check("fontTools' short hmtx is fontTools': the directory keeps the source's length, and the " +
            `decode equals the source table by table: ${id}`, q.length === 0, q.slice(0, 4).join('; '));
        }
      }
    }
    ctx.count('WOFF and WOFF2 fixtures', n, 58); // +6 fontTools wrappings of the P3b real fonts
  },
};
