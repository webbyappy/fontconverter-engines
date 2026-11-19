// eot.h -- Embedded OpenType (W3C Member Submission, 5 March 2008); from spike S2.
//
// Encoding (sfnt -> EOT 0x00020002, no compression, no XOR), header parsing and the decoding of plain and XOR files
// are written here against the submission. Only MTX-compressed files are decoded by libeot (MPL-2.0), behind
// fontwrap's own size checks (P1 plan, P1-4).
#ifndef FONTWRAP_EOT_H_
#define FONTWRAP_EOT_H_

#include <string>

#include "common.h"

namespace fw {

const uint32_t kEotVersion1 = 0x00010000;
const uint32_t kEotVersion21 = 0x00020001;
const uint32_t kEotVersion22 = 0x00020002;

const uint32_t kEotFlagSubset = 0x00000001;
const uint32_t kEotFlagCompressed = 0x00000004;  // TTEMBED_TTCOMPRESSED (MTX)
const uint32_t kEotFlagXor = 0x10000000;         // TTEMBED_XORENCRYPTDATA

struct EotHeader {
  uint32_t eotSize = 0, fontDataSize = 0, version = 0, flags = 0;
  uint8_t panose[10] = {0};
  uint8_t charset = 0, italic = 0;
  uint32_t weight = 0;
  uint16_t fsType = 0, magic = 0;
  uint32_t unicodeRange[4] = {0, 0, 0, 0};
  uint32_t codePageRange[2] = {0, 0};
  uint32_t checkSumAdjustment = 0;
  Bytes familyName, styleName, versionName, fullName, rootString;  // UTF-16LE
  uint32_t rootStringCheckSum = 0, eudcCodePage = 0, eudcFlags = 0, eudcFontSize = 0;
  uint16_t signatureSize = 0;
  uint64_t fontDataOffset = 0;  // where the parsed header ends and the font data starts
};

// True when the buffer looks like an EOT (magic 0x504C at offset 34 and a known version).
bool looks_like_eot(const uint8_t* data, size_t len);

// Strict header parse (throws Error). Does not touch the font data.
void parse_eot_header(const uint8_t* data, size_t len, EotHeader* h);

// "none", "xor" or "mtx" from the flags.
const char* eot_compression(uint32_t flags);

// sfnt -> EOT 0x00020002, the header as sfntly (production) writes it; the font is embedded byte for byte. CFF
// outlines are refused unless `allow_cff`; `strict` refuses (instead of warning about) a wrong table checksum.
void eot_encode(const Bytes& in, bool allow_cff, bool strict, Bytes* out, uint32_t* flavor);

struct EotDecodeReport {
  std::string compression;  // none | xor | mtx
  std::string decoder;      // fontwrap | libeot
};

// EOT -> sfnt. Plain and XOR files in own code, MTX files through libeot. The result must parse as an sfnt.
// max_out: --max-output-bytes; a plain or XOR FontDataSize over it is refused before copying, an MTX font after
// its decode (libeot reserves inside the decode; the module's memory ceiling bounds that).
void eot_decode(const Bytes& in, bool strict, uint64_t max_out, Bytes* out, uint32_t* flavor,
                EotDecodeReport* report);

}  // namespace fw

#endif  // FONTWRAP_EOT_H_
