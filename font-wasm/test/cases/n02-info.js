'use strict';
// N2: `fontwrap info` for every fixture equals font-oracle.json (P1 plan, section 3.3).

const { fontOracle, fx } = require('../lib/fixtures');
const { IN } = require('../lib/engine');
const { cleanFailure, describe } = require('../lib/checks');

const FONT_KINDS = ['sfnt', 'collection', 'woff', 'woff2', 'eot'];
// A sound directory over damaged table data: info reads directories, not table data (P1 plan, N2).
const SOUND_DIRECTORY = ['generated/bad-input/woff-corrupt-table.woff'];
// font-oracle.json's fixtures, pinned rather than read from the oracle (a set that shrinks or grows unannounced must
// fail here): P1's 150; P2 (ffconv) added 11 generated fonts (aliases/ 5, cid/ 1, large/ 1, limits/ 2, special/ 2);
// P3's fontforge-0009 added generated/layout/slick-gpos-devices.ttf. None was removed.
const FIXTURE_COUNT = 150 + 11 + 1 + 24 + 1; // + 24 in P3b (fontconverter-web P3b plan, section 2), + 1 for scorer R8

function inReaderOrder(tables, offsetKey) {
  return tables.map((t, i) => [t, i]).sort((a, b) => a[0][offsetKey] - b[0][offsetKey] || a[1] - b[1]).map(([t]) => t);
}

function sfntProblems(got, want) {
  if (!got || !Array.isArray(got.tables)) return ['no tables'];
  const p = [];
  const tables = inReaderOrder(got.tables, 'offset');
  if (tables.length !== want.tables.length) p.push(`${tables.length} tables, oracle ${want.tables.length}`);
  want.tables.forEach((w, i) => {
    const g = tables[i];
    if (!g || g.tag !== w.tag || g.length !== w.length || g.checksum !== w.checksum) {
      p.push(`table ${i}: ${g ? `${g.tag}/${g.length}/${g.checksum}` : 'none'} vs ${w.tag}/${w.length}/${w.checksum}`);
    }
  });
  if (got.numGlyphs !== want.numGlyphs) p.push(`numGlyphs ${got.numGlyphs} vs ${want.numGlyphs}`);
  return p;
}

function problems(j, f) {
  const p = [];
  if (j.container !== f.kind) return [`container ${j.container}, oracle kind ${f.kind}`];
  if (['sfnt', 'woff', 'woff2'].includes(f.kind) && j.flavor !== f.flavour) p.push(`flavor ${j.flavor} vs ${f.flavour}`);
  if (f.kind === 'sfnt') p.push(...sfntProblems(j, f.font));
  if (f.kind === 'collection') {
    if (j.numFonts !== f.faces.length) p.push(`numFonts ${j.numFonts} vs ${f.faces.length}`);
    f.faces.forEach((face, i) => p.push(...sfntProblems((j.fonts || [])[i], face).map((s) => `face ${i}: ${s}`)));
  }
  if (f.kind === 'woff' && f.font) {
    const tables = inReaderOrder(j.tables || [], 'offset');
    f.font.tables.forEach((w, i) => {
      const g = tables[i];
      if (!g || g.tag !== w.tag || g.origLength !== w.length || g.origChecksum !== w.checksum) {
        p.push(`table ${i}: ${g ? `${g.tag}/${g.origLength}/${g.origChecksum}` : 'none'} vs ${w.tag}/${w.length}/${w.checksum}`);
      }
    });
  }
  if (f.kind === 'woff2' && f.font) {
    const tags = (j.tables || []).map((t) => t.tag);
    if (JSON.stringify(tags) !== JSON.stringify(f.font.tables.map((t) => t.tag))) p.push(`tags ${tags.join(',')}`);
    for (const w of f.font.tables) {
      const g = (j.tables || []).find((t) => t.tag === w.tag);
      // Rebuilt tables (glyf, loca, a transformed hmtx) are not comparable with fontTools' reconstruction, which is
      // 2 bytes short for three hmtx-transformed files (P1 results 12.3); their source is the reference (N5).
      const rebuilt = w.tag === 'glyf' || w.tag === 'loca' || (g && g.transformed);
      if (!rebuilt && (!g || g.origLength !== w.length)) p.push(`${w.tag} origLength`);
    }
  }
  if (f.kind === 'eot') {
    const e = f.eot;
    if (j.compression !== e.compression || j.eotSize !== e.eot_size || j.fontDataSize !== e.font_data_size ||
      j.version !== e.version || j.flags !== e.flags) p.push(`header ${JSON.stringify([j.compression, j.eotSize, j.fontDataSize, j.version, j.flags])}`);
    if (f.font) p.push(...sfntProblems(j.font, f.font).map((s) => `embedded: ${s}`));
    else if (j.font !== null) p.push('MTX: font must be null');
  }
  return p;
}

module.exports = {
  id: 'N2', title: 'info', needsEngine: true,
  async run(ctx) {
    const fo = fontOracle().fixtures;
    let n = 0;
    for (const [id, f] of Object.entries(fo).sort()) {
      if (!ctx.keep(id)) continue;
      n++;
      const r = await ctx.eng.run(['info', IN], { input: { path: fx(id) }, inName: id.split('/').pop() });
      const readable = FONT_KINDS.includes(f.kind) && (!f.font_error || SOUND_DIRECTORY.includes(id));
      if (!readable) {
        ctx.rep.check(`refused ${id}`, cleanFailure(r), describe(r));
        continue;
      }
      if (r.code !== 0 || !r.json) {
        ctx.rep.fail(`info ${id}`, describe(r));
        continue;
      }
      const p = f.font_error ? (r.json.container === f.kind ? [] : [`container ${r.json.container}`]) : problems(r.json, f);
      ctx.rep.check(`info ${id}`, p.length === 0, p.slice(0, 3).join('; '));
    }
    ctx.count('fixtures', n, FIXTURE_COUNT);
  },
};
