// woff2_wrap.h -- WOFF 2.0 through Google's woff2 library (MIT) and Brotli (MIT); from spike S2.
#ifndef FONTWRAP_WOFF2_WRAP_H_
#define FONTWRAP_WOFF2_WRAP_H_

#include <vector>

#include "common.h"

namespace fw {

// The header checks fontwrap makes itself before the library sees a WOFF2 (size, signature, declared length).
void woff2_check_header(const Bytes& in);

// One entry of a WOFF2 table directory (spec section 5.2).
struct Woff2Table {
  uint32_t tag;
  uint32_t orig_length;
  bool transformed;           // glyf and loca when their version is 0; any other table when its version is not 0
  uint32_t transform_length;  // 0 when not transformed
};

// The table directory of a file that passed woff2_check_header, every read bounds-checked; *end is the offset of the
// byte after it (where a collection's directory starts).
std::vector<Woff2Table> woff2_tables(const Bytes& in, size_t* end);

// sfnt or collection -> WOFF2 at Brotli `quality` (0..11). *flavor is the sfnt flavour ('ttcf' for a collection).
void woff2_encode(const Bytes& in, int quality, Bytes* out, uint32_t* flavor);

// WOFF2 -> sfnt or collection. The result must parse as one before it is returned.
// max_out: --max-output-bytes; a declared size over it is refused before the decoder reserves it.
void woff2_decode(const Bytes& in, uint64_t max_out, Bytes* out, uint32_t* flavor);

}  // namespace fw

#endif  // FONTWRAP_WOFF2_WRAP_H_
