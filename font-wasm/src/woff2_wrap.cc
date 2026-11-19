// woff2_wrap.cc -- see woff2_wrap.h.
#include "woff2_wrap.h"

#include <woff2/decode.h>
#include <woff2/encode.h>
#include <woff2/output.h>

#include <algorithm>
#include <string>

#include "sfnt.h"

namespace fw {

namespace {

const uint32_t WOFF2_SIGNATURE = FW_TAG('w', 'O', 'F', '2');
const size_t WOFF2_HEADER_BYTES = 48;
const size_t DECODE_RESERVE_CAP_BYTES = 64u * 1024 * 1024;  // bytes: pre-sizing from an untrusted estimate
const uint32_t WOFF2_ARBITRARY_TAG = 0x3F;

// Known-tag table of the WOFF2 directory (spec section 5.2; index 63 means "an arbitrary tag follows").
const char* const WOFF2_KNOWN_TAGS[63] = {
    "cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post", "cvt ", "fpgm", "glyf", "loca", "prep", "CFF ",
    "VORG", "EBDT", "EBLC", "gasp", "hdmx", "kern", "LTSH", "PCLT", "VDMX", "vhea", "vmtx", "BASE", "GDEF", "GPOS",
    "GSUB", "EBSC", "JSTF", "MATH", "CBDT", "CBLC", "COLR", "CPAL", "SVG ", "sbix", "acnt", "avar", "bdat", "bloc",
    "bsln", "cvar", "fdsc", "feat", "fmtx", "fvar", "gvar", "hsty", "just", "lcar", "mort", "morx", "opbd", "prop",
    "trak", "Zapf", "Silf", "Glat", "Gloc", "Feat", "Sill"};

struct DirReader {
  const uint8_t* d;
  size_t len;
  size_t pos;
  uint8_t u8() {
    if (pos + 1 > len) fail(Err::Woff2Invalid, "WOFF2 is truncated: table directory runs past the end");
    return d[pos++];
  }
  uint32_t u32() {
    if (pos + 4 > len) fail(Err::Woff2Invalid, "WOFF2 is truncated: table directory runs past the end");
    uint32_t v = be32(d + pos);
    pos += 4;
    return v;
  }
  uint32_t base128() {
    uint32_t v = 0;
    for (int i = 0; i < 5; ++i) {
      uint8_t b = u8();
      if (i == 0 && b == 0x80) fail(Err::Woff2Invalid, "WOFF2 is corrupt: UIntBase128 with a leading zero");
      if (v & 0xFE000000) fail(Err::Woff2Invalid, "WOFF2 is corrupt: UIntBase128 overflow");
      v = (v << 7) | (b & 0x7F);
      if ((b & 0x80) == 0) return v;
    }
    fail(Err::Woff2Invalid, "WOFF2 is corrupt: UIntBase128 longer than 5 bytes");
  }
};

// Structural check of an sfnt or collection: a bad input is refused with a precise message before the encoder sees
// it, and a bad decode result is never written.
uint32_t validate_font(const Bytes& b, const char* what) {
  if (b.size() >= 4 && be32(b.data()) == kFlavorCollection) {
    TtcHeader h = parse_ttc(b.data(), b.size(), what);
    for (uint32_t off : h.offsets) parse_sfnt(b.data(), b.size(), off, what);
    return kFlavorCollection;
  }
  return parse_sfnt(b.data(), b.size(), 0, what).flavor;
}

// google/woff2 refuses any table that does not start on a 4-byte boundary (vendor/woff2/src/font.cc:78), as OpenType
// requires; name the first such table instead of the library's generic failure (P1 results 12.3).
void require_aligned_tables(const Bytes& b) {
  if (b.size() >= 4 && be32(b.data()) == kFlavorCollection) {
    TtcHeader h = parse_ttc(b.data(), b.size(), "input");
    for (size_t face = 0; face < h.offsets.size(); ++face) {
      for (const Table& t : parse_sfnt(b.data(), b.size(), h.offsets[face], "input").tables) {
        if (t.offset & 3) {
          fail(Err::Woff2Unaligned, "table '%s' of face %zu starts at byte %u, not on a 4-byte boundary; WOFF2 needs every table aligned, "
               "as OpenType requires", tag_str(t.tag).c_str(), face, t.offset);
        }
      }
    }
    return;
  }
  for (const Table& t : parse_sfnt(b.data(), b.size(), 0, "input").tables) {
    if (t.offset & 3) {
      fail(Err::Woff2Unaligned, "table '%s' starts at byte %u, not on a 4-byte boundary; WOFF2 needs every table aligned, as OpenType "
           "requires", tag_str(t.tag).c_str(), t.offset);
    }
  }
}

}  // namespace

void woff2_check_header(const Bytes& in) {
  if (in.size() < WOFF2_HEADER_BYTES) fail(Err::Woff2Invalid, "input is truncated: shorter than a WOFF2 header");
  if (be32(in.data()) != WOFF2_SIGNATURE) fail(Err::Woff2Invalid, "input is not a WOFF2 file (bad signature)");
  if (be32(in.data() + 8) != in.size()) {
    fail(Err::Woff2Invalid, "WOFF2 is truncated or corrupt: header says %u bytes, file has %zu", be32(in.data() + 8), in.size());
  }
}

std::vector<Woff2Table> woff2_tables(const Bytes& in, size_t* end) {
  const uint32_t n = be16(in.data() + 12);
  if (n == 0) fail(Err::Woff2Invalid, "WOFF2 has an empty table directory");
  if (n > MAX_TABLES) fail(Err::Woff2Invalid, "WOFF2 declares %u tables (limit %u)", n, MAX_TABLES);
  DirReader r = {in.data(), in.size(), WOFF2_HEADER_BYTES};
  std::vector<Woff2Table> tables;
  for (uint32_t i = 0; i < n; ++i) {
    const uint8_t flags = r.u8();
    uint32_t tag;
    if ((flags & 0x3F) == WOFF2_ARBITRARY_TAG) {
      tag = r.u32();
    } else {
      const char* k = WOFF2_KNOWN_TAGS[flags & 0x3F];
      tag = FW_TAG(k[0], k[1], k[2], k[3]);
    }
    const uint32_t version = flags >> 6;
    Woff2Table t = {tag, r.base128(), false, 0};
    const bool glyf_or_loca = tag == FW_TAG('g', 'l', 'y', 'f') || tag == FW_TAG('l', 'o', 'c', 'a');
    t.transformed = glyf_or_loca ? (version == 0) : (version != 0);  // as woff2_dec.cc ReadTableDirectory
    if (t.transformed) t.transform_length = r.base128();
    tables.push_back(t);
  }
  *end = r.pos;
  return tables;
}

void woff2_encode(const Bytes& in, int quality, Bytes* out, uint32_t* flavor) {
  *flavor = validate_font(in, "input");
  require_aligned_tables(in);
  woff2::WOFF2Params params;
  params.brotli_quality = quality;
  size_t out_len = woff2::MaxWOFF2CompressedSize(in.data(), in.size());
  out->assign(out_len, 0);
  if (!woff2::ConvertTTFToWOFF2(in.data(), in.size(), out->data(), &out_len, params)) {
    out->clear();
    fail(Err::Woff2EncoderRejected, "the WOFF2 encoder rejected the font (its tables are malformed or use a layout the encoder cannot normalise)");
  }
  out->resize(out_len);
}

void woff2_decode(const Bytes& in, uint64_t max_out, Bytes* out, uint32_t* flavor) {
  woff2_check_header(in);
  // google/woff2 reserves the whole declared table data (up to 100 times the file) before Brotli can say the stream
  // is bad (woff2_dec.cc:1368-1377), and wasm memory never shrinks: refuse a claim over the output limit first.
  size_t dir_end = 0;
  uint64_t stream = 0;
  for (const Woff2Table& t : woff2_tables(in, &dir_end)) stream += t.transformed ? t.transform_length : t.orig_length;
  if (stream > max_out) {
    fail(Err::OutputLimit, "WOFF2 declares %llu bytes of table data, over the %llu-byte output limit",
         (unsigned long long)stream, (unsigned long long)max_out);
  }
  size_t estimate = woff2::ComputeWOFF2FinalSize(in.data(), in.size());
  if (estimate > max_out) {
    fail(Err::OutputLimit, "WOFF2 declares a %zu-byte font, over the %llu-byte output limit", estimate,
         (unsigned long long)max_out);
  }
  std::string buf;
  buf.reserve(std::min<size_t>(std::min<size_t>(estimate, DECODE_RESERVE_CAP_BYTES), (size_t)max_out));
  woff2::WOFF2StringOut sink(&buf);
  sink.SetMaxSize((size_t)max_out);
  if (!woff2::ConvertWOFF2ToTTF(in.data(), in.size(), &sink)) {
    fail(Err::Woff2DecodeFailed, "WOFF2 is corrupt: the decoder could not reconstruct the font");
  }
  out->assign(buf.begin(), buf.begin() + (ptrdiff_t)sink.Size());
  *flavor = validate_font(*out, "font decoded from the WOFF2");
}

}  // namespace fw
