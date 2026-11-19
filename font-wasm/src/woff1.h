// woff1.h -- WOFF 1.0 (W3C Recommendation, 13 December 2012), written against the spec; zlib is the only dependency.
#ifndef FONTWRAP_WOFF1_H_
#define FONTWRAP_WOFF1_H_

#include <vector>

#include "common.h"

namespace fw {

struct WoffEntry {
  uint32_t tag, offset, compLength, origLength, origChecksum;
};

struct WoffLayout {
  uint32_t flavor = 0, length = 0, totalSfntSize = 0;
  uint16_t majorVersion = 0, minorVersion = 0;
  uint32_t metaOffset = 0, metaLength = 0, metaOrigLength = 0, privOffset = 0, privLength = 0;
  std::vector<WoffEntry> entries;  // in directory order
};

// Every header, directory and block check a conforming user agent must make (spec sections 3 to 5): signature,
// length, flavour, reserved field, table count, compLength <= origLength, offsets in bounds and aligned, no inflation
// beyond zlib's ceiling, no duplicate tag, totalSfntSize, no overlap, and nothing between or after the blocks but up
// to three zero bytes of padding. Table data is not inflated. Throws Error on the first problem. Shared by
// woff1_decode and `info`.
WoffLayout woff1_layout(const Bytes& in);

// sfnt -> WOFF (zlib 9). Table bytes are never modified; tables are stored in the input's offset order, so a font
// with a canonical layout decodes back bit for bit. `strict` refuses (instead of warning about) a non-canonical
// layout or a wrong table checksum.
void woff1_encode(const Bytes& in, bool strict, Bytes* out, uint32_t* flavor);

// WOFF -> sfnt. `strict` refuses (instead of warning about) a table whose data does not match its checksum.
// max_out: --max-output-bytes; a declared totalSfntSize over it is refused before anything is allocated.
void woff1_decode(const Bytes& in, bool strict, uint64_t max_out, Bytes* out, uint32_t* flavor);

}  // namespace fw

#endif  // FONTWRAP_WOFF1_H_
