'use strict';
// The harness's own reading of an SVG font (P2 plan, section 5): <glyph>/<missing-glyph> elements with their
// attributes, and <hkern>/<vkern> rules. Enough for FontForge's output (one element per tag, attributes in double
// quotes); independent of the scorer and of parity_diff.py.

const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function unescape(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITY[e] !== undefined ? ENTITY[e] : m;
  });
}

function attributes(body) {
  const out = {};
  for (const m of body.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = unescape(m[2]);
  return out;
}

function elements(text, tags) {
  const re = new RegExp(`<(${tags.join('|')})\\b([^>]*?)/?>`, 'g');
  return [...text.matchAll(re)].map((m) => ({ tag: m[1], attrs: attributes(m[2]) }));
}

function glyphs(text) {
  return elements(text, ['glyph', 'missing-glyph']);
}

function kerns(text) {
  return elements(text, ['hkern', 'vkern']);
}

// One string per element: its tag and every attribute (sorted); `withPath` false leaves `d` out.
function signature(el, withPath = true) {
  const keys = Object.keys(el.attrs).filter((k) => withPath || k !== 'd').sort();
  return el.tag + ' ' + keys.map((k) => `${k}=${JSON.stringify(el.attrs[k])}`).join(' ');
}

// How many elements repeat an earlier element exactly (every attribute, the path included).
function repeats(text) {
  const seen = new Set();
  let n = 0;
  for (const el of glyphs(text)) {
    const s = signature(el);
    if (seen.has(s)) n++;
    else seen.add(s);
  }
  return n;
}

function multiset(list) {
  const m = new Map();
  for (const s of list) m.set(s, (m.get(s) || 0) + 1);
  return m;
}

function sameMultiset(a, b) {
  const ma = multiset(a);
  const mb = multiset(b);
  return ma.size === mb.size && [...ma].every(([k, v]) => mb.get(k) === v);
}

function isSelector(cp) {
  return (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef);
}

// Production's elements that ours lacks (signatures without d, as a multiset). One swap is not a loss: production's
// element whose unicode is a variation selector alone, where ours has an element of the same glyph whose unicode is
// a base followed by that selector (fontforge-0003 writes a sequence as base + selector).
function lostFrom(ours, theirs) {
  const have = multiset(glyphs(ours).map((e) => signature(e, false)));
  const mine = glyphs(ours);
  const lost = [];
  for (const e of glyphs(theirs)) {
    const s = signature(e, false);
    if ((have.get(s) || 0) > 0) {
      have.set(s, have.get(s) - 1);
      continue;
    }
    const u = [...(e.attrs.unicode || '')];
    const swapped = u.length === 1 && isSelector(u[0].codePointAt(0)) && mine.some((o) =>
      o.attrs['glyph-name'] === e.attrs['glyph-name'] && [...(o.attrs.unicode || '')].length === 2 &&
      [...o.attrs.unicode][1] === u[0]);
    if (!swapped) lost.push(s);
  }
  return lost;
}

// Our elements that production lacks (the elements themselves).
function addedTo(ours, theirs) {
  const have = multiset(glyphs(theirs).map((e) => signature(e, false)));
  return glyphs(ours).filter((e) => {
    const s = signature(e, false);
    if ((have.get(s) || 0) > 0) {
      have.set(s, have.get(s) - 1);
      return false;
    }
    return true;
  });
}

// The two kinds of SVG structure problem the scorer reports, as complete sets (P2-25: evidence never comes from the
// scorer's text, which truncates): the source's code points no <glyph> maps alone, and those more than one maps.
function coverage(text, codePoints) {
  const n = new Map();
  for (const e of glyphs(text)) {
    const u = [...(e.attrs.unicode || '')];
    if (e.tag === 'glyph' && u.length === 1) n.set(u[0].codePointAt(0), (n.get(u[0].codePointAt(0)) || 0) + 1);
  }
  const cps = [...codePoints].sort((x, y) => x - y);
  return { missing: cps.filter((c) => !n.has(c)), repeated: cps.filter((c) => (n.get(c) || 0) > 1) };
}

// P2-25 (D): an element production lacks is a source alias when production has no element like it at all (a copy of
// one of production's elements is a repeat, never an alias), its one code point maps in the source to the same glyph
// as a code point production writes for that glyph name, and it is drawn exactly like that element.
function aliasJustified(el, prodEls, srcMap) {
  const u = [...(el.attrs.unicode || '')];
  if (u.length !== 1 || !srcMap.has(u[0].codePointAt(0))) return false;
  if (prodEls.some((p) => signature(p, false) === signature(el, false))) return false;
  const gid = srcMap.get(u[0].codePointAt(0));
  return prodEls.some((p) => p.attrs['glyph-name'] === el.attrs['glyph-name'] && p.attrs.d === el.attrs.d &&
    [...(p.attrs.unicode || '')].length === 1 && srcMap.get(p.attrs.unicode.codePointAt(0)) === gid);
}

// Elements (full signatures, path included) ours writes more often than production does, or more than once when
// production has none: every new repeat, not a total.
function newRepeats(ours, theirs) {
  const a = multiset(glyphs(ours).map((e) => signature(e)));
  const b = multiset(glyphs(theirs).map((e) => signature(e)));
  return [...a].filter(([k, n]) => n > Math.max(b.get(k) || 0, 1)).map(([k, n]) => `${n}x ${k.slice(0, 80)}`);
}

module.exports = { addedTo, aliasJustified, coverage, glyphs, isSelector, kerns, lostFrom, multiset, newRepeats, repeats,
  sameMultiset, signature };
