'use strict';
// GSUB and GPOS language systems, read independently of the engine: for each script/LangSys record (the script's
// DefaultLangSys as "dflt"), its required feature's tag and its features' tags, sorted. Feature and lookup indices
// differ between a source and its instance; their tags may not.

const { table } = require('./sfnt');

function tagAt(b, at) {
  return b.toString('latin1', at, at + 4);
}

// { 'latn/dflt': { req: 'rqd ' | null, features: ['kern', 'mark', ...] }, ... } for the table `tag`, or null.
function languageSystems(font, tag) {
  const t = table(font, tag);
  if (!t) return null;
  const scripts = t.readUInt16BE(4);
  const features = t.readUInt16BE(6);
  const featureTag = (i) => tagAt(t, features + 2 + 6 * i);
  const featureCount = t.readUInt16BE(features);
  const langSys = (at) => {
    const req = t.readUInt16BE(at + 2);
    const n = t.readUInt16BE(at + 4);
    const tags = [];
    for (let k = 0; k < n; k++) {
      const i = t.readUInt16BE(at + 6 + 2 * k);
      tags.push(i < featureCount ? featureTag(i) : `#${i}`);
    }
    return { req: req === 0xffff ? null : (req < featureCount ? featureTag(req) : `#${req}`), features: tags.sort() };
  };
  const out = {};
  const count = t.readUInt16BE(scripts);
  for (let s = 0; s < count; s++) {
    const script = tagAt(t, scripts + 2 + 6 * s);
    const at = scripts + t.readUInt16BE(scripts + 2 + 6 * s + 4);
    const def = t.readUInt16BE(at);
    if (def) out[`${script}/dflt`] = langSys(at + def);
    const n = t.readUInt16BE(at + 2);
    for (let k = 0; k < n; k++) {
      out[`${script}/${tagAt(t, at + 4 + 6 * k)}`] = langSys(at + t.readUInt16BE(at + 4 + 6 * k + 4));
    }
  }
  return out;
}

// The differences between two fonts' language systems in `tag`, as short strings (empty when equal).
function languageSystemDifferences(a, b, tag) {
  const x = languageSystems(a, tag);
  const y = languageSystems(b, tag);
  if (!x || !y) return x === y ? [] : [`${tag} ${x ? 'missing' : 'added'}`];
  const out = [];
  for (const k of Object.keys(x)) {
    if (!y[k]) out.push(`${tag} ${k} missing`);
    else if (JSON.stringify(x[k]) !== JSON.stringify(y[k])) out.push(`${tag} ${k} features differ`);
  }
  for (const k of Object.keys(y)) if (!x[k]) out.push(`${tag} ${k} added`);
  return out;
}

module.exports = { languageSystemDifferences, languageSystems };
