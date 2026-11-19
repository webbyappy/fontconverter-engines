// sfnt.cc -- see sfnt.h.
#include "sfnt.h"

namespace hbf {

const Table* Sfnt::find(uint32_t tag) const {
  for (const Table& t : tables) {
    if (t.tag == tag) return &t;
  }
  return nullptr;
}

std::string tag_str(uint32_t tag) {
  std::string s(4, '?');
  for (int i = 0; i < 4; ++i) {
    uint8_t c = (uint8_t)(tag >> (24 - 8 * i));
    if (c >= 0x20 && c <= 0x7e) s[i] = (char)c;
  }
  return s;
}

Sfnt parse_sfnt(const Bytes& b) {
  if (b.size() < 12) fail(Err::NotAFont, "the input is %zu bytes, shorter than an sfnt header", b.size());
  Sfnt s;
  s.version = be32(b.data());
  if (s.version == HBF_TAG('t', 't', 'c', 'f')) fail(Err::Collection, "a font collection (TTC/OTC); hbfont takes one font");
  if (s.version != 0x00010000 && s.version != HBF_TAG('O', 'T', 'T', 'O') && s.version != HBF_TAG('t', 'r', 'u', 'e')) {
    fail(Err::NotAFont, "not an sfnt font (signature %s)", tag_str(s.version).c_str());
  }
  uint32_t n = be16(b.data() + 4);
  if (n == 0 || n > MAX_TABLES) fail(Err::SfntInvalid, "the directory lists %u tables", n);
  if ((uint64_t)12 + 16ull * n > b.size()) fail(Err::SfntInvalid, "the table directory runs past the end of the file");
  for (uint32_t i = 0; i < n; ++i) {
    const uint8_t* r = b.data() + 12 + 16 * i;
    Table t = {be32(r), be32(r + 8), be32(r + 12)};
    if ((uint64_t)t.offset + t.length > b.size()) {
      fail(Err::SfntInvalid, "table %s runs past the end of the file", tag_str(t.tag).c_str());
    }
    // Two records of one tag: HarfBuzz's binary search and these readers could each take another (the closing review).
    if (s.find(t.tag)) fail(Err::SfntInvalid, "table %s appears twice in the directory", tag_str(t.tag).c_str());
    s.tables.push_back(t);
  }
  const Table* maxp = s.find(HBF_TAG('m', 'a', 'x', 'p'));
  if (!maxp || maxp->length < 6) fail(Err::SfntInvalid, "no maxp table, or one too short for its glyph count");
  return s;
}

std::string outline_flavor(const Sfnt& s) {
  if (s.find(HBF_TAG('g', 'l', 'y', 'f'))) return "truetype";
  if (s.find(HBF_TAG('C', 'F', 'F', '2'))) return "cff2";
  if (s.find(HBF_TAG('C', 'F', 'F', ' '))) return "cff";
  return "none";
}

namespace {

void cmap_subtable(const uint8_t* t, uint64_t avail, std::map<uint32_t, uint32_t>* out) {
  if (avail < 6) fail(Err::SfntInvalid, "a cmap subtable runs past its table");
  uint32_t format = be16(t);
  if (format == 0) {
    if (avail < 262) fail(Err::SfntInvalid, "a cmap format-0 subtable runs past its table");
    for (uint32_t c = 0; c < 256; ++c) {
      if (t[6 + c]) (*out)[c] = t[6 + c];
    }
  } else if (format == 4) {
    uint32_t len = be16(t + 2);
    if (len > avail || len < 14) fail(Err::SfntInvalid, "a cmap format-4 subtable runs past its table");
    uint32_t segs = be16(t + 6) / 2;
    if (16ull + 8ull * segs > len) fail(Err::SfntInvalid, "a cmap format-4 subtable's segments run past it");
    const uint8_t* ends = t + 14;
    const uint8_t* starts = ends + 2 * segs + 2;
    const uint8_t* deltas = starts + 2 * segs;
    const uint8_t* ranges = deltas + 2 * segs;
    for (uint32_t i = 0; i < segs; ++i) {
      uint32_t start = be16(starts + 2 * i), end = be16(ends + 2 * i), delta = be16(deltas + 2 * i),
               ro = be16(ranges + 2 * i);
      if (start > end) continue;
      for (uint32_t c = start; c <= end && c != 0xffff; ++c) {
        uint32_t g;
        if (ro == 0) {
          g = (c + delta) & 0xffff;
        } else {
          uint64_t at = (uint64_t)(ranges - t) + 2 * i + ro + 2ull * (c - start);
          if (at + 2 > len) fail(Err::SfntInvalid, "a cmap format-4 glyph index runs past its subtable");
          g = be16(t + at);
          if (g) g = (g + delta) & 0xffff;
        }
        if (g) (*out)[c] = g;
      }
    }
  } else if (format == 6) {
    uint32_t first = be16(t + 6), count = be16(t + 8);
    if (10ull + 2ull * count > avail) fail(Err::SfntInvalid, "a cmap format-6 subtable runs past its table");
    for (uint32_t i = 0; i < count; ++i) {
      uint32_t g = be16(t + 10 + 2 * i);
      if (g) (*out)[first + i] = g;
    }
  } else if (format == 12) {
    if (avail < 16) fail(Err::SfntInvalid, "a cmap format-12 subtable runs past its table");
    uint32_t groups = be32(t + 12);
    if (16ull + 12ull * groups > avail) fail(Err::SfntInvalid, "a cmap format-12 subtable runs past its table");
    for (uint32_t i = 0; i < groups; ++i) {
      uint32_t start = be32(t + 16 + 12 * i), end = be32(t + 20 + 12 * i), g = be32(t + 24 + 12 * i);
      if (end < start || end > 0x10ffff || end - start > 0x10ffff) fail(Err::SfntInvalid, "a cmap format-12 group is damaged");
      for (uint32_t c = start; c <= end; ++c) {
        if (g + (c - start)) (*out)[c] = g + (c - start);
      }
    }
  }
}

}  // namespace

std::map<uint32_t, uint32_t> best_cmap(const Bytes& font, const Sfnt& s) {
  std::map<uint32_t, uint32_t> out;
  const Table* t = s.find(HBF_TAG('c', 'm', 'a', 'p'));
  if (!t || t->length < 4) return out;
  const uint8_t* b = font.data() + t->offset;
  uint32_t n = be16(b + 2);
  if (4ull + 8ull * n > t->length) fail(Err::SfntInvalid, "the cmap table's records run past it");
  static const uint16_t kOrder[][2] = {{3, 10}, {0, 6}, {0, 4}, {3, 1}, {0, 3}, {0, 2}, {0, 1}, {0, 0}};
  for (const auto& want : kOrder) {
    for (uint32_t i = 0; i < n; ++i) {
      const uint8_t* r = b + 4 + 8 * i;
      if (be16(r) != want[0] || be16(r + 2) != want[1]) continue;
      uint32_t off = be32(r + 4);
      if (off >= t->length) fail(Err::SfntInvalid, "a cmap subtable offset points past the table");
      uint32_t format = be16(b + off);
      if (format != 0 && format != 4 && format != 6 && format != 12) continue;
      cmap_subtable(b + off, t->length - off, &out);
      return out;
    }
  }
  return out;
}

uint32_t glyph_count(const Bytes& font, const Sfnt& s) {
  return be16(font.data() + s.find(HBF_TAG('m', 'a', 'x', 'p'))->offset + 4);
}

std::vector<uint32_t> advances(const Bytes& font, const Sfnt& s) {
  uint32_t n = glyph_count(font, s);
  const Table* hhea = s.find(HBF_TAG('h', 'h', 'e', 'a'));
  const Table* hmtx = s.find(HBF_TAG('h', 'm', 't', 'x'));
  if (!hhea || hhea->length < 36 || !hmtx) fail(Err::SfntInvalid, "no hhea or hmtx table");
  uint32_t metrics = be16(font.data() + hhea->offset + 34);
  if (metrics == 0 || 4ull * metrics > hmtx->length) fail(Err::SfntInvalid, "hmtx is shorter than hhea says");
  std::vector<uint32_t> out(n);
  for (uint32_t g = 0; g < n; ++g) out[g] = be16(font.data() + hmtx->offset + 4 * (g < metrics ? g : metrics - 1));
  return out;
}

uint32_t units_per_em(const Bytes& font, const Sfnt& s) {
  const Table* head = s.find(HBF_TAG('h', 'e', 'a', 'd'));
  if (!head || head->length < 54) fail(Err::SfntInvalid, "no head table");
  return be16(font.data() + head->offset + 18);
}

}  // namespace hbf
