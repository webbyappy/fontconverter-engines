// sfnt.cc -- see sfnt.h.
#include "sfnt.h"

#include <algorithm>
#include <set>

namespace fw {

const Table* Sfnt::find(uint32_t tag) const {
  for (const Table& t : tables) {
    if (t.tag == tag) return &t;
  }
  return nullptr;
}

bool is_sfnt_flavor(uint32_t v) {
  return v == kFlavorTrueType || v == kFlavorCFF || v == kFlavorApple || v == kFlavorType1;
}

const char* flavor_name(uint32_t v) {
  switch (v) {
    case kFlavorTrueType: return "truetype";
    case kFlavorCFF: return "cff";
    case kFlavorApple: return "truetype-apple";
    case kFlavorType1: return "type1-sfnt";
    case kFlavorCollection: return "collection";
    default: return "unknown";
  }
}

Sfnt parse_sfnt(const uint8_t* data, size_t len, size_t base, const char* what) {
  Sfnt f;
  if (base > len || len - base < 12) fail(Err::SfntInvalid, "%s is truncated: no room for an sfnt header", what);
  const uint8_t* h = data + base;
  f.flavor = be32(h);
  if (!is_sfnt_flavor(f.flavor)) {
    fail(Err::SfntInvalid, "%s is not an sfnt font (unknown version tag 0x%08X)", what, f.flavor);
  }
  uint32_t n = be16(h + 4);
  f.searchRange = be16(h + 6);
  f.entrySelector = be16(h + 8);
  f.rangeShift = be16(h + 10);
  if (n == 0) fail(Err::SfntInvalid, "%s has an empty table directory", what);
  if (n > MAX_TABLES) fail(Err::SfntInvalid, "%s declares %u tables (limit %u)", what, n, MAX_TABLES);
  uint64_t dir_end = (uint64_t)base + 12 + 16ull * n;
  if (dir_end > len) {
    fail(Err::SfntInvalid, "%s is truncated: the table directory (%u tables) runs past the end of the file", what, n);
  }
  std::set<uint32_t> seen;
  f.tables.reserve(n);
  for (uint32_t i = 0; i < n; ++i) {
    const uint8_t* e = h + 12 + 16 * (size_t)i;
    Table t;
    t.tag = be32(e);
    t.checksum = be32(e + 4);
    t.offset = be32(e + 8);
    t.length = be32(e + 12);
    if ((uint64_t)t.offset + t.length > len) {
      fail(Err::SfntInvalid, "%s is truncated or corrupt: table '%s' (offset %u, length %u) runs past the end of the "
           "file (%zu bytes)",
           what, tag_str(t.tag).c_str(), t.offset, t.length, len);
    }
    // In a stand-alone sfnt no table may lie inside the header or directory.
    if (base == 0 && t.length > 0 && t.offset < dir_end) {
      fail(Err::SfntInvalid, "%s is corrupt: table '%s' (offset %u) overlaps the table directory", what,
           tag_str(t.tag).c_str(), t.offset);
    }
    if (!seen.insert(t.tag).second) {
      fail(Err::SfntInvalid, "%s is corrupt: table '%s' is listed twice", what, tag_str(t.tag).c_str());
    }
    f.tables.push_back(t);
  }
  return f;
}

TtcHeader parse_ttc(const uint8_t* data, size_t len, const char* what) {
  TtcHeader h;
  if (len < 12 || be32(data) != kFlavorCollection) fail(Err::CollectionInvalid, "%s is not a font collection", what);
  h.version = be32(data + 4);
  uint32_t n = be32(data + 8);
  if (n == 0) fail(Err::CollectionInvalid, "%s is a collection with no fonts", what);
  if (n > 65535) fail(Err::CollectionInvalid, "%s declares %u fonts in the collection", what, n);
  if (12 + 4ull * n > len) fail(Err::CollectionInvalid, "%s is truncated: collection header runs past the end", what);
  for (uint32_t i = 0; i < n; ++i) h.offsets.push_back(be32(data + 12 + 4 * (size_t)i));
  return h;
}

uint32_t checksum_bytes(const uint8_t* p, size_t len) {
  uint32_t sum = 0;
  size_t i = 0;
  for (; i + 4 <= len; i += 4) sum += be32(p + i);
  if (i < len) {
    uint8_t last[4] = {0, 0, 0, 0};
    for (size_t j = 0; i + j < len; ++j) last[j] = p[i + j];
    sum += be32(last);
  }
  return sum;
}

uint32_t table_checksum(const uint8_t* data, const Table& t) {
  uint32_t sum = checksum_bytes(data + t.offset, t.length);
  if (t.tag == kTagHead && t.length >= 12) sum -= be32(data + t.offset + 8);
  return sum;
}

int count_bad_checksums(const uint8_t* data, const Sfnt& f, std::string* tags) {
  int bad = 0;
  tags->clear();
  for (const Table& t : f.tables) {
    if (table_checksum(data, t) != t.checksum) {
      if (bad < 8) *tags += (bad ? ", " : "") + tag_str(t.tag);
      ++bad;
    }
  }
  return bad;
}

void search_params(uint16_t n, uint16_t* search_range, uint16_t* entry_selector,
                   uint16_t* range_shift) {
  uint16_t es = 0;
  while ((1u << (es + 1)) <= n) ++es;
  uint16_t sr = (uint16_t)((1u << es) * 16);
  *search_range = sr;
  *entry_selector = es;
  *range_shift = (uint16_t)(n * 16 - sr);
}

std::string outline_flavor(const std::vector<uint32_t>& tags, uint32_t sfnt_version) {
  bool cff2 = false, cff = false, glyf = false;
  for (uint32_t t : tags) {
    cff2 = cff2 || t == FW_TAG('C', 'F', 'F', '2');
    cff = cff || t == FW_TAG('C', 'F', 'F', ' ');
    glyf = glyf || t == FW_TAG('g', 'l', 'y', 'f');
  }
  if (cff2) return "cff2";
  if (cff) return "cff";
  if (glyf) return "truetype";
  if (sfnt_version == kFlavorCFF) return "cff";
  if (sfnt_version == kFlavorTrueType || sfnt_version == kFlavorApple) return "truetype";
  return flavor_name(sfnt_version);
}

std::string outline_flavor(const Sfnt& f) {
  std::vector<uint32_t> tags;
  for (const Table& t : f.tables) tags.push_back(t.tag);
  return outline_flavor(tags, f.flavor);
}

int num_glyphs(const uint8_t* data, const Sfnt& f) {
  const Table* maxp = f.find(FW_TAG('m', 'a', 'x', 'p'));
  if (!maxp || maxp->length < 6) return -1;
  return be16(data + maxp->offset + 4);
}

std::vector<size_t> physical_order(const Sfnt& f) {
  std::vector<size_t> idx(f.tables.size());
  for (size_t i = 0; i < idx.size(); ++i) idx[i] = i;
  std::stable_sort(idx.begin(), idx.end(), [&f](size_t a, size_t b) {
    const Table& x = f.tables[a];
    const Table& y = f.tables[b];
    if (x.offset != y.offset) return x.offset < y.offset;
    return (x.length != 0) < (y.length != 0);
  });
  return idx;
}

LayoutReport check_layout(const uint8_t* data, size_t len, const Sfnt& f) {
  LayoutReport r;
  auto bad = [&r](const std::string& why) {
    if (r.canonical) {
      r.canonical = false;
      r.reason = why;
    }
  };
  size_t n = f.tables.size();
  for (size_t i = 1; i < n; ++i) {
    if (f.tables[i - 1].tag >= f.tables[i].tag) {
      bad("table directory is not sorted by tag");
      break;
    }
  }
  uint16_t sr, es, rs;
  search_params((uint16_t)n, &sr, &es, &rs);
  if (sr != f.searchRange || es != f.entrySelector || rs != f.rangeShift) {
    bad("searchRange/entrySelector/rangeShift in the header are wrong");
  }
  uint64_t expect = 12 + 16ull * n;
  for (size_t i : physical_order(f)) {
    const Table& t = f.tables[i];
    if (t.offset != expect) {
      bad(std::string(t.offset < expect ? "table '" : "gap or unaligned data before table '") +
          tag_str(t.tag) + (t.offset < expect ? "' overlaps the previous table" : "'"));
      break;
    }
    uint64_t end = (uint64_t)t.offset + t.length;
    uint64_t padded = round4(end);
    for (uint64_t p = end; p < padded && p < len; ++p) {
      if (data[p] != 0) {
        bad("padding after table '" + tag_str(t.tag) + "' is not zero");
        break;
      }
    }
    expect = padded;
  }
  if (r.canonical && expect != len) {
    bad(expect > len ? "last table is not padded to a 4-byte boundary"
                     : "extra data after the last table");
  }
  return r;
}

bool checksum_adjustment(const uint8_t* data, size_t len, const Sfnt& f, uint32_t* stored,
                         uint32_t* expected) {
  const Table* head = f.find(kTagHead);
  if (!head || head->length < 12) return false;
  size_t adj = (size_t)head->offset + 8;
  uint32_t sum = checksum_bytes(data, len);
  // Remove the contribution of the four checkSumAdjustment bytes wherever they fall in a word.
  for (size_t i = 0; i < 4; ++i) {
    size_t pos = adj + i;
    sum -= (uint32_t)data[pos] << (8 * (3 - (pos & 3)));
  }
  *stored = be32(data + adj);
  *expected = 0xB1B0AFBAu - sum;
  return true;
}

}  // namespace fw
