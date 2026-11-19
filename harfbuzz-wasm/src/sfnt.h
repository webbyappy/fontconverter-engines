// sfnt.h -- hbfont's own reading of a single sfnt font's table directory, checked before HarfBuzz sees the bytes
// (HarfBuzz reads a malformed font as an empty face instead of refusing it).
#ifndef HBFONT_SFNT_H_
#define HBFONT_SFNT_H_

#include <cstdint>
#include <map>
#include <string>
#include <vector>

#include "common.h"

namespace hbf {

#define HBF_TAG(a, b, c, d) \
  (((uint32_t)(a) << 24) | ((uint32_t)(b) << 16) | ((uint32_t)(c) << 8) | (uint32_t)(d))

struct Table {
  uint32_t tag;
  uint32_t offset;
  uint32_t length;
};

struct Sfnt {
  uint32_t version;  // 0x00010000, 'OTTO' or 'true'
  std::vector<Table> tables;
  const Table* find(uint32_t tag) const;
};

const uint32_t MAX_TABLES = 4096;

// The directory of a single font: refuses a collection, WOFF, WOFF2, EOT or anything else (not-a-font, collection),
// a directory or table running past the end, or a font without maxp (sfnt-invalid).
Sfnt parse_sfnt(const Bytes& b);

// "truetype" (glyf), "cff2", "cff" or "none" (no outlines: a bitmap-only font), by the tables, never the version.
std::string outline_flavor(const Sfnt& s);

std::string tag_str(uint32_t tag);

// The font's best Unicode cmap, chosen as fontTools' getBestCmap chooses it ((3,10), (0,6), (0,4), (3,1), (0,3),
// (0,2), (0,1), (0,0)): code point -> glyph id. Formats 0, 4, 6 and 12; empty when none is present.
std::map<uint32_t, uint32_t> best_cmap(const Bytes& font, const Sfnt& s);

// maxp's glyph count; hmtx's advance of each glyph; head's unitsPerEm.
uint32_t glyph_count(const Bytes& font, const Sfnt& s);
std::vector<uint32_t> advances(const Bytes& font, const Sfnt& s);
uint32_t units_per_em(const Bytes& font, const Sfnt& s);

}  // namespace hbf

#endif  // HBFONT_SFNT_H_
