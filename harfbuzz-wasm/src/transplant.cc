// transplant.cc -- see transplant.h. The P3b plan's P3b-9 to P3b-11:
//  1. The glyph map (ffconv --glyph-map) parsed and checked: v 1, its counts the fonts' own, injective, inside the
//     outline font, .notdef at 0 (glyph-map-invalid). A CID-keyed map is turned into glyph ids through the source's
//     CFF charset.
//  2. The map agrees with the fonts: unitsPerEm equal, every mapped pair's advance equal (scaled, 1 unit allowed), every
//     code point of the source's best cmap reaching the mapped glyph in the outline font's (glyph-map-mismatch).
//  3. HarfBuzz builds a subset plan of the source with exactly the mapped glyphs and the map as its glyph mapping
//     (no layout closure; CPAL never subset); every glyph the colour tables reach must be mapped
//     (colour-glyph-unmapped), and the plan's own mapping must equal the map. COLR, CPAL, sbix, CBDT and CBLC come from
//     the plan's output; sbix is padded to the outline font's glyph count; COLR's and CBLC's glyph-sorted lists are
//     checked sorted (COLR's sorted where they are not).
//  4. The SVG table is renumbered by own code (svg_table.h).
//  5. CPAL's palette and entry names are copied into the outline font's name table under fresh ids above its highest.
// Every other table of the outline font is kept byte for byte.
#include "transplant.h"

#include <hb-subset.h>
#include <hb.h>

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <map>
#include <set>

#include "cff.h"
#include "names.h"
#include "sfnt.h"
#include "sfnt_edit.h"
#include "svg_table.h"

namespace hbf {

namespace {

const uint32_t COLOUR_TABLES[] = {HBF_TAG('C', 'O', 'L', 'R'), HBF_TAG('C', 'P', 'A', 'L'), HBF_TAG('s', 'b', 'i', 'x'),
                                  HBF_TAG('C', 'B', 'D', 'T'), HBF_TAG('C', 'B', 'L', 'C'), HBF_TAG('S', 'V', 'G', ' ')};

struct GlyphMap {
  bool cid = false;
  long source = -1, output = -1;
  std::vector<int> map;
};

// The map's JSON: exactly {"v":1,"keyedBy":"gid"|"cid","sourceGlyphs":N,"outputGlyphs":M,"map":[...]} in any key order.
GlyphMap parse_map(const Bytes& b) {
  std::string s(b.begin(), b.end());
  size_t p = 0;
  auto ws = [&]() {
    while (p < s.size() && (s[p] == ' ' || s[p] == '\n' || s[p] == '\r' || s[p] == '\t')) ++p;
  };
  auto bad = [&](const char* what) { fail(Err::GlyphMapInvalid, "the glyph map is not ffconv's: %s", what); };
  auto expect = [&](char c) {
    ws();
    if (p >= s.size() || s[p] != c) bad("unexpected character");
    ++p;
  };
  auto str = [&]() {
    expect('"');
    size_t e = s.find('"', p);
    if (e == std::string::npos || e - p > 32) bad("a string");
    std::string v = s.substr(p, e - p);
    p = e + 1;
    return v;
  };
  auto num = [&]() {
    ws();
    char* end = nullptr;
    long v = strtol(s.c_str() + p, &end, 10);
    if (end == s.c_str() + p) bad("a number");
    p = (size_t)(end - s.c_str());
    return v;
  };
  GlyphMap m;
  long version = -1;
  bool have_map = false;
  std::string keyed;
  expect('{');
  for (;;) {
    std::string key = str();
    expect(':');
    if (key == "v") version = num();
    else if (key == "keyedBy") keyed = str();
    else if (key == "sourceGlyphs") m.source = num();
    else if (key == "outputGlyphs") m.output = num();
    else if (key == "map") {
      expect('[');
      ws();
      if (p < s.size() && s[p] == ']') {
        ++p;
      } else {
        for (;;) {
          long v = num();
          if (v < -1 || v > 65535 || m.map.size() > 1000000) bad("an entry");
          m.map.push_back((int)v);
          ws();
          if (p < s.size() && s[p] == ',') {
            ++p;
            continue;
          }
          expect(']');
          break;
        }
      }
      have_map = true;
    } else {
      bad("an unknown key");
    }
    ws();
    if (p < s.size() && s[p] == ',') {
      ++p;
      continue;
    }
    expect('}');
    break;
  }
  ws();
  if (p != s.size()) bad("bytes after the object");
  if (version != 1 || (keyed != "gid" && keyed != "cid") || !have_map || m.source < 1 || m.output < 1) bad("its fields");
  if ((long)m.map.size() != m.source) bad("its length");
  m.cid = keyed == "cid";
  return m;
}

struct HbFace {
  hb_blob_t* blob;
  hb_face_t* face;
  explicit HbFace(const Bytes& b)
      : blob(hb_blob_create((const char*)b.data(), (unsigned)b.size(), HB_MEMORY_MODE_READONLY, nullptr, nullptr)),
        face(hb_face_create(blob, 0)) {}
  ~HbFace() {
    hb_face_destroy(face);
    hb_blob_destroy(blob);
  }
  HbFace(const HbFace&) = delete;
  HbFace& operator=(const HbFace&) = delete;
};

Bytes table_bytes(const Bytes& f, const Sfnt& s, uint32_t tag) {
  const Table* t = s.find(tag);
  return t ? Bytes(f.begin() + t->offset, f.begin() + t->offset + t->length) : Bytes();
}

Bytes hb_table(hb_face_t* face, uint32_t tag) {
  hb_blob_t* b = hb_face_reference_table(face, tag);
  unsigned len = 0;
  const char* d = hb_blob_get_data(b, &len);
  Bytes out(d ? (const uint8_t*)d : nullptr, d ? (const uint8_t*)d + len : nullptr);
  hb_blob_destroy(b);
  return out;
}

void put16(Bytes* b, size_t at, uint32_t v) {
  (*b)[at] = (uint8_t)(v >> 8);
  (*b)[at + 1] = (uint8_t)v;
}
void put32(Bytes* b, size_t at, uint32_t v) {
  for (int k = 0; k < 4; ++k) (*b)[at + k] = (uint8_t)(v >> (24 - 8 * k));
}

// sbix written by HarfBuzz for `have` glyphs, padded to `want`: each strike's offset array gains entries repeating its
// last offset (empty glyphs), every later strike and its data shifted.
Bytes pad_sbix(const Bytes& sbix, uint32_t have, uint32_t want) {
  if (want == have) return sbix;
  if (want < have || sbix.size() < 8) fail(Err::Internal, "sbix for %u glyphs, the outline font has %u", have, want);
  uint32_t n = be32(sbix.data() + 4);
  if (8ull + 4ull * n > sbix.size()) fail(Err::Internal, "HarfBuzz's sbix is damaged");
  uint32_t grow = 4 * (want - have);
  Bytes out(sbix.begin(), sbix.begin() + 8 + 4 * n);
  for (uint32_t i = 0; i < n; ++i) {
    uint32_t at = be32(sbix.data() + 8 + 4 * i);
    uint32_t end = i + 1 < n ? be32(sbix.data() + 12 + 4 * i) : (uint32_t)sbix.size();
    if (at + 4 + 4ull * (have + 1) > end || end > sbix.size()) fail(Err::Internal, "HarfBuzz's sbix strike is damaged");
    put32(&out, 8 + 4 * i, (uint32_t)out.size());
    size_t strike = out.size();
    out.insert(out.end(), sbix.begin() + at, sbix.begin() + at + 4);  // ppem, ppi
    uint32_t last = be32(sbix.data() + at + 4 + 4 * have);
    for (uint32_t g = 0; g <= have; ++g) {
      out.resize(out.size() + 4);
      put32(&out, out.size() - 4, be32(sbix.data() + at + 4 + 4 * g) + grow);
    }
    for (uint32_t g = have + 1; g <= want; ++g) {
      out.resize(out.size() + 4);
      put32(&out, out.size() - 4, last + grow);
    }
    out.insert(out.end(), sbix.begin() + at + 4 + 4 * (have + 1), sbix.begin() + end);
    (void)strike;
  }
  return out;
}

// COLR's gid-sorted lists sorted: v0 base glyph records (6 bytes each) and v1's BaseGlyphList (6 bytes each, offsets
// relative to the list); a ClipList left unsorted is refused (its ranges cannot be reordered in place).
Bytes sort_colr(Bytes c) {
  if (c.size() < 14) fail(Err::Internal, "HarfBuzz's COLR is %zu bytes", c.size());
  auto sort_records = [&](size_t at, uint32_t n, size_t size) {
    if (at + (uint64_t)n * size > c.size()) fail(Err::Internal, "HarfBuzz's COLR is damaged");
    std::vector<Bytes> recs;
    for (uint32_t i = 0; i < n; ++i) recs.push_back(Bytes(c.begin() + at + i * size, c.begin() + at + (i + 1) * size));
    std::stable_sort(recs.begin(), recs.end(), [](const Bytes& a, const Bytes& b) { return be16(a.data()) < be16(b.data()); });
    for (uint32_t i = 0; i < n; ++i) std::copy(recs[i].begin(), recs[i].end(), c.begin() + at + i * size);
  };
  sort_records(be32(c.data() + 4), be16(c.data() + 2), 6);
  if (be16(c.data()) >= 1 && c.size() >= 34) {
    uint32_t list = be32(c.data() + 14);
    if (list) {
      if (list + 4ull > c.size()) fail(Err::Internal, "HarfBuzz's COLR is damaged");
      sort_records(list + 4, be32(c.data() + list), 6);
    }
    uint32_t clips = be32(c.data() + 26);
    if (clips) {
      if (clips + 5ull > c.size()) fail(Err::Internal, "HarfBuzz's COLR is damaged");
      uint32_t n = be32(c.data() + clips + 1);
      for (uint32_t i = 1; i < n; ++i) {
        if (be16(c.data() + clips + 5 + 7 * i) <= be16(c.data() + clips + 5 + 7 * (i - 1) + 2)) {
          fail(Err::Internal, "HarfBuzz's COLR ClipList is not sorted");
        }
      }
    }
  }
  return c;
}

// CBLC's index subtable ranges, checked sorted and disjoint per strike.
void check_cblc(const Bytes& c) {
  if (c.size() < 8) return;
  uint32_t n = be32(c.data() + 4);
  for (uint32_t i = 0; i < n && 8 + 48ull * (i + 1) <= c.size(); ++i) {
    uint32_t arr = be32(c.data() + 8 + 48 * i), count = be32(c.data() + 8 + 48 * i + 8);
    if (arr + 8ull * count > c.size()) fail(Err::Internal, "HarfBuzz's CBLC is damaged");
    for (uint32_t k = 1; k < count; ++k) {
      if (be16(c.data() + arr + 8 * k) <= be16(c.data() + arr + 8 * (k - 1) + 2)) {
        fail(Err::Internal, "HarfBuzz's CBLC index subtables are not sorted");
      }
    }
  }
}

}  // namespace

TransplantResult transplant(const Bytes& src, const Bytes& outline, const Bytes& map_json) {
  Sfnt s = parse_sfnt(src);
  Sfnt o = parse_sfnt(outline);
  std::vector<uint32_t> present;
  for (uint32_t t : COLOUR_TABLES) {
    if (s.find(t)) present.push_back(t);
  }
  if (present.empty() || (present.size() == 1 && present[0] == HBF_TAG('C', 'P', 'A', 'L'))) {
    fail(Err::NoColour, "the source has no colour table to put back");
  }
  uint32_t n = glyph_count(src, s), m = glyph_count(outline, o);
  GlyphMap gm = parse_map(map_json);
  if (gm.output != (long)m) fail(Err::GlyphMapInvalid, "the map names %ld output glyphs, the outline font has %u", gm.output, m);
  std::vector<int> map(n, -1);
  if (gm.cid) {
    const Table* cff = s.find(HBF_TAG('C', 'F', 'F', ' '));
    if (!cff) fail(Err::GlyphMapInvalid, "a map keyed by CID for a font without CFF");
    std::vector<uint32_t> cids = cff_glyph_cids(table_bytes(src, s, HBF_TAG('C', 'F', 'F', ' ')), n);
    if (cids.empty()) fail(Err::GlyphMapInvalid, "a map keyed by CID for a name-keyed CFF font");
    for (uint32_t g = 0; g < n; ++g) {
      if (cids[g] >= gm.map.size()) fail(Err::GlyphMapInvalid, "glyph %u's CID %u is past the map", g, cids[g]);
      map[g] = gm.map[cids[g]];
    }
  } else {
    if (gm.map.size() != n) fail(Err::GlyphMapInvalid, "the map has %zu entries, the source %u glyphs", gm.map.size(), n);
    map = gm.map;
  }
  if (map[0] != 0) fail(Err::GlyphMapInvalid, ".notdef does not stay glyph 0");
  std::vector<bool> used(m, false);
  for (uint32_t g = 0; g < n; ++g) {
    if (map[g] < 0) continue;
    if ((uint32_t)map[g] >= m) fail(Err::GlyphMapInvalid, "glyph %u maps past the outline font (%d of %u)", g, map[g], m);
    if (used[map[g]]) fail(Err::GlyphMapInvalid, "two source glyphs map to output glyph %d", map[g]);
    used[map[g]] = true;
  }
  // Every glyph that draws colour is mapped (P3b-10): COLR v0 layers, a COLR v1 paint, a PNG image in sbix or CBDT
  // (HarfBuzz's own readers; a CBDT bitmap in another format than PNG is not seen here). SVG documents are checked
  // by the rewrite, which refuses any glyph they name that the map leaves out.
  {
    HbFace f(src);
    hb_font_t* font = hb_font_create(f.face);
    for (uint32_t g = 0; g < n; ++g) {
      if (map[g] >= 0) continue;
      bool colour = hb_ot_color_glyph_get_layers(f.face, g, 0, nullptr, nullptr) > 0 || hb_ot_color_glyph_has_paint(f.face, g);
      if (!colour) {
        hb_blob_t* png = hb_ot_color_glyph_reference_png(font, g);
        colour = hb_blob_get_length(png) > 0;
        hb_blob_destroy(png);
      }
      if (colour) {
        hb_font_destroy(font);
        fail(Err::ColourGlyphUnmapped, "glyph %u draws colour, but FontForge's output lacks it", g);
      }
    }
    hb_font_destroy(font);
  }

  // 2. The map agrees with the fonts.
  uint32_t upm_s = units_per_em(src, s), upm_o = units_per_em(outline, o);
  if (upm_s != upm_o) fail(Err::GlyphMapMismatch, "unitsPerEm %u against %u", upm_s, upm_o);
  std::vector<uint32_t> adv_s = advances(src, s), adv_o = advances(outline, o);
  for (uint32_t g = 0; g < n; ++g) {
    if (map[g] >= 0 && std::labs((long)adv_s[g] - (long)adv_o[map[g]]) > 1) {
      fail(Err::GlyphMapMismatch, "glyph %u advances %u, its output glyph %d %u", g, adv_s[g], map[g], adv_o[map[g]]);
    }
  }
  std::map<uint32_t, uint32_t> cm_s = best_cmap(src, s), cm_o = best_cmap(outline, o);
  for (const auto& e : cm_s) {
    if (e.second >= n) continue;
    auto it = cm_o.find(e.first);
    if (map[e.second] < 0 || it == cm_o.end() || (int)it->second != map[e.second]) {
      fail(Err::GlyphMapMismatch, "U+%04X maps to glyph %u, whose output glyph is not the outline font's", e.first, e.second);
    }
  }

  // 3. HarfBuzz's plan with exactly the mapped glyphs and the map.
  TransplantResult r;
  std::map<uint32_t, Bytes> replace;
  bool needs_hb = false;
  for (uint32_t t : present) needs_hb = needs_hb || t != HBF_TAG('S', 'V', 'G', ' ');
  if (needs_hb) {
    HbFace f(src);
    hb_subset_input_t* in = hb_subset_input_create_or_fail();
    if (!in) fail(Err::OutOfMemory, "out of memory for HarfBuzz's subset input");
    hb_subset_input_keep_everything(in);
    hb_set_clear(hb_subset_input_unicode_set(in));
    hb_set_t* glyphs = hb_subset_input_glyph_set(in);
    hb_set_clear(glyphs);
    hb_map_t* mapping = hb_subset_input_old_to_new_glyph_mapping(in);
    for (uint32_t g = 0; g < n; ++g) {
      if (map[g] < 0) continue;
      hb_set_add(glyphs, g);
      hb_map_set(mapping, g, (hb_codepoint_t)map[g]);
    }
    hb_subset_input_set_flags(in, hb_subset_input_get_flags(in) | HB_SUBSET_FLAGS_NO_LAYOUT_CLOSURE);
    hb_set_add(hb_subset_input_set(in, HB_SUBSET_SETS_NO_SUBSET_TABLE_TAG), HB_TAG('C', 'P', 'A', 'L'));
    hb_subset_plan_t* plan = hb_subset_plan_create_or_fail(f.face, in);
    hb_subset_input_destroy(in);
    if (!plan) fail(Err::TransplantFailed, "HarfBuzz could not plan the colour tables");
    const hb_map_t* got = hb_subset_plan_old_to_new_glyph_mapping(plan);
    int idx = -1;
    hb_codepoint_t old_g, new_g;
    while (hb_map_next(got, &idx, &old_g, &new_g)) {
      if (old_g >= n || map[old_g] < 0) {
        hb_subset_plan_destroy(plan);
        fail(Err::ColourGlyphUnmapped, "the colour tables reach glyph %u, which FontForge's output lacks", old_g);
      }
      if ((int)new_g != map[old_g]) {
        hb_subset_plan_destroy(plan);
        fail(Err::TransplantFailed, "HarfBuzz gave glyph %u the id %u, the map %d", old_g, new_g, map[old_g]);
      }
    }
    hb_face_t* out = hb_subset_plan_execute_or_fail(plan);
    hb_subset_plan_destroy(plan);
    if (!out) fail(Err::TransplantFailed, "HarfBuzz could not write the colour tables");
    uint32_t hb_glyphs = hb_face_get_glyph_count(out);
    for (uint32_t t : present) {
      if (t == HBF_TAG('S', 'V', 'G', ' ')) continue;
      Bytes b = hb_table(out, t);
      if (b.empty()) {
        hb_face_destroy(out);
        fail(Err::TransplantFailed, "HarfBuzz wrote no %s table", tag_str(t).c_str());
      }
      if (t == HBF_TAG('s', 'b', 'i', 'x')) b = pad_sbix(b, hb_glyphs, m);
      if (t == HBF_TAG('C', 'O', 'L', 'R')) b = sort_colr(b);
      if (t == HBF_TAG('C', 'B', 'L', 'C')) check_cblc(b);
      replace[t] = b;
    }
    hb_face_destroy(out);
  }

  // 4. SVG by own code.
  if (s.find(HBF_TAG('S', 'V', 'G', ' '))) replace[HBF_TAG('S', 'V', 'G', ' ')] = svg_remap(table_bytes(src, s, HBF_TAG('S', 'V', 'G', ' ')), map);

  // 5. CPAL's names under fresh ids in the outline font's name table.
  auto cpal = replace.find(HBF_TAG('C', 'P', 'A', 'L'));
  if (cpal == replace.end() && s.find(HBF_TAG('C', 'P', 'A', 'L'))) {
    replace[HBF_TAG('C', 'P', 'A', 'L')] = table_bytes(src, s, HBF_TAG('C', 'P', 'A', 'L'));
    cpal = replace.find(HBF_TAG('C', 'P', 'A', 'L'));
  }
  if (cpal != replace.end() && cpal->second.size() >= 12 && be16(cpal->second.data()) >= 1) {
    Bytes& c = cpal->second;
    uint32_t palettes = be16(c.data() + 4), entries = be16(c.data() + 2);
    size_t v1 = 12 + 2ull * palettes;
    if (v1 + 12 > c.size()) fail(Err::SfntInvalid, "the CPAL version 1 header runs past the table");
    uint32_t labels_at = be32(c.data() + v1 + 4), entry_labels_at = be32(c.data() + v1 + 8);
    NameTable nt_src = read_name_table(src, s);
    NameTable nt = read_name_table(outline, o);
    uint32_t next = 256;
    for (const NameRecord& rec : nt.records) next = std::max<uint32_t>(next, rec.id + 1u);
    std::map<uint32_t, uint32_t> renamed;
    auto rename = [&](size_t at) {
      if (at + 2 > c.size()) fail(Err::SfntInvalid, "a CPAL label runs past the table");
      uint32_t id = be16(c.data() + at);
      if (id == 0xffff) return;
      if (!renamed.count(id)) {
        if (next > 32767) fail(Err::TransplantFailed, "no name id is free for a CPAL label");
        renamed[id] = next++;
        for (const NameRecord& rec : nt_src.records) {
          if (rec.id == id) nt.records.push_back({rec.platform, rec.encoding, rec.language, (uint16_t)renamed[id], rec.bytes});
        }
      }
      put16(&c, at, renamed[id]);
    };
    for (uint32_t i = 0; labels_at && i < palettes; ++i) rename(labels_at + 2 * i);
    for (uint32_t i = 0; entry_labels_at && i < entries; ++i) rename(entry_labels_at + 2 * i);
    if (!renamed.empty()) replace[HBF_TAG('n', 'a', 'm', 'e')] = write_name_table(nt);
  }

  r.out = replace_tables(outline, replace);
  Sfnt check = parse_sfnt(r.out);
  for (uint32_t t : present) {
    if (!check.find(t)) fail(Err::OutputInvalid, "the result lacks %s", tag_str(t).c_str());
    r.tables.push_back(tag_str(t));
  }
  r.glyphs = m;
  return r;
}

}  // namespace hbf
