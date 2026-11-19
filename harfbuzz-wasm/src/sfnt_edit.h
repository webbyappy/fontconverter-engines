// sfnt_edit.h -- the font with some tables replaced (P3b plan, section 3.1): every other table byte for byte, the
// tables in their order, each 4-byte aligned, table checksums and head.checkSumAdjustment recomputed.
#ifndef HBFONT_SFNT_EDIT_H_
#define HBFONT_SFNT_EDIT_H_

#include <cstdint>
#include <map>

#include "common.h"

namespace hbf {

// `replace` maps a tag to its new bytes; a tag the font lacks is added (in tag order after the others).
Bytes replace_tables(const Bytes& font, const std::map<uint32_t, Bytes>& replace);

uint32_t table_checksum(const uint8_t* p, size_t n);

}  // namespace hbf

#endif  // HBFONT_SFNT_EDIT_H_
