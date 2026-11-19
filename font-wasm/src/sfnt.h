// sfnt.h -- minimal, bounds-checked reader for the sfnt wrapper (TrueType / OpenType); from spike S2.
// Only the container is understood (offset table, table directory, checksums); table contents
// are never interpreted or modified here.
#ifndef FONTWRAP_SFNT_H_
#define FONTWRAP_SFNT_H_

#include <string>
#include <vector>

#include "common.h"

namespace fw {

const uint32_t kFlavorTrueType = 0x00010000;
const uint32_t kFlavorCFF = FW_TAG('O', 'T', 'T', 'O');
const uint32_t kFlavorApple = FW_TAG('t', 'r', 'u', 'e');
const uint32_t kFlavorType1 = FW_TAG('t', 'y', 'p', '1');
const uint32_t kFlavorCollection = FW_TAG('t', 't', 'c', 'f');

const uint32_t kTagHead = FW_TAG('h', 'e', 'a', 'd');
const uint32_t kTagOS2 = FW_TAG('O', 'S', '/', '2');
const uint32_t kTagName = FW_TAG('n', 'a', 'm', 'e');

struct Table {
  uint32_t tag;
  uint32_t checksum;
  uint32_t offset;  // from the start of the file
  uint32_t length;
};

struct Sfnt {
  uint32_t flavor = 0;
  uint16_t searchRange = 0, entrySelector = 0, rangeShift = 0;  // as stored in the file
  std::vector<Table> tables;                                    // in directory order
  const Table* find(uint32_t tag) const;
};

bool is_sfnt_flavor(uint32_t v);
const char* flavor_name(uint32_t v);  // "truetype", "cff", ... ("unknown" otherwise)

// Parse the sfnt whose offset table starts at `base`. Throws Error (message starts with `what`)
// on anything that is out of bounds, absurd or duplicated.
Sfnt parse_sfnt(const uint8_t* data, size_t len, size_t base, const char* what);

struct TtcHeader {
  uint32_t version = 0;
  std::vector<uint32_t> offsets;
};
TtcHeader parse_ttc(const uint8_t* data, size_t len, const char* what);

// Sum of big-endian uint32 words, the last word zero-padded.
uint32_t checksum_bytes(const uint8_t* p, size_t len);
// Table checksum as the OpenType spec defines it ('head' is summed with checkSumAdjustment = 0).
uint32_t table_checksum(const uint8_t* data, const Table& t);

// Number of tables whose data does not match the checksum in the directory; *tags gets the
// first few tags, comma separated.
int count_bad_checksums(const uint8_t* data, const Sfnt& f, std::string* tags);

void search_params(uint16_t num_tables, uint16_t* search_range, uint16_t* entry_selector,
                   uint16_t* range_shift);

// "Canonical" layout = what a WOFF 1.0 decoder regenerates: directory sorted by tag, correct
// searchRange fields, tables stored back to back from the end of the directory, each zero-padded
// to 4 bytes, nothing after the last table's padding. Only such a file can round-trip bit for bit.
struct LayoutReport {
  bool canonical = true;
  std::string reason;  // first deviation found
};
LayoutReport check_layout(const uint8_t* data, size_t len, const Sfnt& f);

// Is head.checkSumAdjustment right for this whole (single-sfnt) file?
// Returns false when there is no usable 'head' table.
bool checksum_adjustment(const uint8_t* data, size_t len, const Sfnt& f, uint32_t* stored,
                         uint32_t* expected);

// The flavour by font-oracle.json's rule (tests/tools/fixturegen/facts.py:67-76 and 110 in fontconverter-web): the
// outline table decides (CFF2 -> "cff2", CFF -> "cff", glyf -> "truetype"), else the sfnt version.
std::string outline_flavor(const Sfnt& f);
// The same rule over a list of tags and a version (WOFF and WOFF2 directories).
std::string outline_flavor(const std::vector<uint32_t>& tags, uint32_t sfnt_version);

// maxp.numGlyphs, or -1 when the font has no usable maxp.
int num_glyphs(const uint8_t* data, const Sfnt& f);

// Order in which table data is stored: by offset, zero-length tables first on ties, then by
// directory position. Returns indexes into f.tables.
std::vector<size_t> physical_order(const Sfnt& f);

}  // namespace fw

#endif  // FONTWRAP_SFNT_H_
