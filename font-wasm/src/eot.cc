// eot.cc -- see eot.h. From spike S2; plain and XOR decoding moved out of libeot (P1-4).
//
// EOT header (all little-endian), from the W3C submission:
//   ULONG EOTSize, FontDataSize, Version, Flags
//   BYTE  FontPANOSE[10], Charset, Italic
//   ULONG Weight;  USHORT fsType;  USHORT MagicNumber (0x504C)
//   ULONG UnicodeRange1..4, CodePageRange1..2, CheckSumAdjustment, Reserved1..4
//   USHORT Padding1, FamilyNameSize;  FamilyName[]      (UTF-16LE)
//   USHORT Padding2, StyleNameSize;   StyleName[]
//   USHORT Padding3, VersionNameSize; VersionName[]
//   USHORT Padding4, FullNameSize;    FullName[]
//   -- version 0x00020001 and later --
//   USHORT Padding5, RootStringSize;  RootString[]
//   -- version 0x00020002 --
//   ULONG RootStringCheckSum, EUDCCodePage;  USHORT Padding6, SignatureSize;  Signature[]
//   ULONG EUDCFlags, EUDCFontSize;  EUDCFontData[]
//   -- all versions --
//   BYTE FontData[FontDataSize]
#include "eot.h"

#include <cstring>

#include "sfnt.h"

extern "C" {
#include <libeot/libeot.h>
}

namespace fw {

namespace {

const uint16_t kEotMagic = 0x504C;
const size_t kEotMinHeader = 96;  // version 1 header with four empty names

struct Cursor {
  const uint8_t* d;
  uint64_t limit;
  uint64_t pos;
  void need(uint64_t n, const char* what) const {
    if (pos + n > limit) fail(Err::EotInvalid, "EOT is truncated or corrupt: the header ends inside %s", what);
  }
  uint8_t u8(const char* what) {
    need(1, what);
    return d[pos++];
  }
  uint16_t u16(const char* what) {
    need(2, what);
    uint16_t v = le16(d + pos);
    pos += 2;
    return v;
  }
  uint32_t u32(const char* what) {
    need(4, what);
    uint32_t v = le32(d + pos);
    pos += 4;
    return v;
  }
  void bytes(uint64_t n, const char* what, Bytes* out) {
    need(n, what);
    if (out) out->assign(d + pos, d + pos + n);
    pos += n;
  }
  void name(const char* what, Bytes* out) {
    uint16_t size = u16(what);
    if (size & 1) fail(Err::EotInvalid, "EOT is corrupt: %s has an odd byte length (%u)", what, size);
    bytes(size, what, out);
  }
};

// Mac OS Roman 0x80..0xFF -> Unicode.
const uint16_t kMacRoman[128] = {
    0x00C4, 0x00C5, 0x00C7, 0x00C9, 0x00D1, 0x00D6, 0x00DC, 0x00E1, 0x00E0, 0x00E2, 0x00E4,
    0x00E3, 0x00E5, 0x00E7, 0x00E9, 0x00E8, 0x00EA, 0x00EB, 0x00ED, 0x00EC, 0x00EE, 0x00EF,
    0x00F1, 0x00F3, 0x00F2, 0x00F4, 0x00F6, 0x00F5, 0x00FA, 0x00F9, 0x00FB, 0x00FC, 0x2020,
    0x00B0, 0x00A2, 0x00A3, 0x00A7, 0x2022, 0x00B6, 0x00DF, 0x00AE, 0x00A9, 0x2122, 0x00B4,
    0x00A8, 0x2260, 0x00C6, 0x00D8, 0x221E, 0x00B1, 0x2264, 0x2265, 0x00A5, 0x00B5, 0x2202,
    0x2211, 0x220F, 0x03C0, 0x222B, 0x00AA, 0x00BA, 0x03A9, 0x00E6, 0x00F8, 0x00BF, 0x00A1,
    0x00AC, 0x221A, 0x0192, 0x2248, 0x2206, 0x00AB, 0x00BB, 0x2026, 0x00A0, 0x00C0, 0x00C3,
    0x00D5, 0x0152, 0x0153, 0x2013, 0x2014, 0x201C, 0x201D, 0x2018, 0x2019, 0x00F7, 0x25CA,
    0x00FF, 0x0178, 0x2044, 0x20AC, 0x2039, 0x203A, 0xFB01, 0xFB02, 0x2021, 0x00B7, 0x201A,
    0x201E, 0x2030, 0x00C2, 0x00CA, 0x00C1, 0x00CB, 0x00C8, 0x00CD, 0x00CE, 0x00CF, 0x00CC,
    0x00D3, 0x00D4, 0xF8FF, 0x00D2, 0x00DA, 0x00DB, 0x00D9, 0x0131, 0x02C6, 0x02DC, 0x00AF,
    0x02D8, 0x02D9, 0x02DA, 0x00B8, 0x02DD, 0x02DB, 0x02C7};

// Preference of a name record for the EOT header; lower is better, -1 = not usable.
// sfntly (production) and ttf2eot read only (3, 1, 0x0409); the rest is a fallback chain.
int name_rank(uint16_t platform, uint16_t encoding, uint16_t language) {
  if (platform == 3) {
    if (encoding == 1) return language == 0x0409 ? 0 : 1;
    if (encoding == 10) return 2;
    if (encoding == 0) return 3;
    return -1;  // legacy CJK encodings: not UTF-16
  }
  if (platform == 0) return 4;
  if (platform == 1 && encoding == 0) return language == 0 ? 5 : 6;
  return -1;
}

// The string for nameID as UTF-16LE bytes (empty when the font has none).
Bytes pick_name(const uint8_t* nt, uint32_t nl, uint16_t name_id) {
  Bytes out;
  uint32_t count = be16(nt + 2);
  uint32_t string_offset = be16(nt + 4);
  int best_rank = -1;
  const uint8_t* best = nullptr;
  uint32_t best_len = 0;
  bool best_mac = false;
  for (uint32_t i = 0; i < count; ++i) {
    const uint8_t* r = nt + 6 + 12 * (size_t)i;
    if (be16(r + 6) != name_id) continue;
    uint16_t platform = be16(r), encoding = be16(r + 2), language = be16(r + 4);
    uint32_t length = be16(r + 8);
    uint64_t start = (uint64_t)string_offset + be16(r + 10);
    if (start + length > nl) continue;  // record points outside the table
    int rank = name_rank(platform, encoding, language);
    if (rank < 0) continue;
    if (best_rank < 0 || rank < best_rank) {
      best_rank = rank;
      best = nt + start;
      best_len = length;
      best_mac = (platform == 1);
    }
  }
  if (!best) return out;
  if (best_mac) {
    for (uint32_t i = 0; i < best_len; ++i) {
      uint16_t u = best[i] < 0x80 ? best[i] : kMacRoman[best[i] - 0x80];
      put_le16(out, u);
    }
  } else {
    for (uint32_t i = 0; i + 1 < best_len; i += 2) {  // UTF-16BE -> UTF-16LE
      out.push_back(best[i + 1]);
      out.push_back(best[i]);
    }
  }
  return out;
}

void put_name(Bytes& o, const Bytes& name, const char* which) {
  if (name.size() > 0xFFFF) {
    fail(Err::EotNameTooLong, "the font's %s name is %zu bytes as UTF-16, too long for an EOT header (65,535 at most)", which, name.size());
  }
  put_le16(o, (uint16_t)name.size());
  o.insert(o.end(), name.begin(), name.end());
}

const char* eot_error_text(enum EOTError e) {
  switch (e) {
    case EOT_INSUFFICIENT_BYTES: return "the file is truncated";
    case EOT_HEADER_TOO_BIG: return "the header is inconsistent with the declared sizes";
    case EOT_BOGUS_STRING_SIZE: return "a name string has an odd size";
    case EOT_CORRUPT_FILE: return "the file is corrupt";
    case EOT_SECOND_STREAM_INCOMPLETE:
    case EOT_THIRD_STREAM_INCOMPLETE: return "the compressed (MTX) font data is incomplete";
    case EOT_CANT_ALLOCATE_MEMORY: return "out of memory";
    case EOT_COMPRESSION_NOT_YET_IMPLEMENTED: return "this MTX compression variant is not supported";
    case EOT_NO_MAXP_TABLE:
    case EOT_NO_HEAD_TABLE:
    case EOT_NO_HMTX_TABLE:
    case EOT_NO_HDMX_TABLE: return "the compressed (MTX) font lacks a required table";
    case EOT_CORRUPT_HOPCODE_DATA:
    case EOT_MTX_ERROR:
    case EOT_MALFORMED_HEAD_TABLE: return "the compressed (MTX) font data is corrupt";
    default: return "libeot reported an internal error";
  }
}

}  // namespace

bool looks_like_eot(const uint8_t* data, size_t len) {
  if (len < 36) return false;
  uint32_t version = le32(data + 8);
  if (version != kEotVersion1 && version != kEotVersion21 && version != kEotVersion22) return false;
  return le16(data + 34) == kEotMagic;
}

void parse_eot_header(const uint8_t* data, size_t len, EotHeader* h) {
  if (len < 36) fail(Err::EotInvalid, "EOT is truncated: shorter than the fixed header");
  h->eotSize = le32(data);
  h->fontDataSize = le32(data + 4);
  h->version = le32(data + 8);
  h->magic = le16(data + 34);
  if (h->magic != kEotMagic) fail(Err::EotInvalid, "input is not an EOT file (magic number 0x504C not found)");
  if (h->version != kEotVersion1 && h->version != kEotVersion21 && h->version != kEotVersion22) {
    fail(Err::EotInvalid, "EOT has an unknown version 0x%08X", h->version);
  }
  if (h->eotSize != len) {
    fail(Err::EotInvalid, "EOT is truncated or corrupt: header says %u bytes, file has %zu", h->eotSize, len);
  }
  if (len < kEotMinHeader || h->fontDataSize > len - kEotMinHeader) {
    fail(Err::EotInvalid, "EOT is corrupt: font data size %u does not fit in a %zu-byte file", h->fontDataSize, len);
  }
  Cursor c = {data, (uint64_t)len - h->fontDataSize, 12};
  h->flags = c.u32("Flags");
  c.need(10, "PANOSE");
  memcpy(h->panose, data + c.pos, 10);
  c.pos += 10;
  h->charset = c.u8("Charset");
  h->italic = c.u8("Italic");
  h->weight = c.u32("Weight");
  h->fsType = c.u16("fsType");
  c.u16("MagicNumber");
  for (int i = 0; i < 4; ++i) h->unicodeRange[i] = c.u32("UnicodeRange");
  for (int i = 0; i < 2; ++i) h->codePageRange[i] = c.u32("CodePageRange");
  h->checkSumAdjustment = c.u32("CheckSumAdjustment");
  c.bytes(16, "Reserved", nullptr);
  c.u16("Padding1");
  c.name("FamilyName", &h->familyName);
  c.u16("Padding2");
  c.name("StyleName", &h->styleName);
  c.u16("Padding3");
  c.name("VersionName", &h->versionName);
  c.u16("Padding4");
  c.name("FullName", &h->fullName);
  if (h->version >= kEotVersion21) {
    c.u16("Padding5");
    c.name("RootString", &h->rootString);
  }
  if (h->version == kEotVersion22) {
    h->rootStringCheckSum = c.u32("RootStringCheckSum");
    h->eudcCodePage = c.u32("EUDCCodePage");
    c.u16("Padding6");
    h->signatureSize = c.u16("SignatureSize");
    c.bytes(h->signatureSize, "Signature", nullptr);
    h->eudcFlags = c.u32("EUDCFlags");
    h->eudcFontSize = c.u32("EUDCFontSize");
    c.bytes(h->eudcFontSize, "EUDCFontData", nullptr);
  }
  h->fontDataOffset = c.pos;
  if (c.pos + h->fontDataSize != len) {
    fail(Err::EotInvalid, "EOT is corrupt: the header ends at byte %llu but the font data (%u bytes) starts at %llu",
         (unsigned long long)c.pos, h->fontDataSize, (unsigned long long)(len - h->fontDataSize));
  }
}

void eot_encode(const Bytes& in, bool allow_cff, bool strict, Bytes* out, uint32_t* flavor) {
  if (in.size() >= 4 && be32(in.data()) == kFlavorCollection) {
    fail(Err::CollectionNotAllowed, "input is a font collection (.ttc/.otc); EOT can hold only a single font. Extract one "
         "face first");
  }
  Sfnt f = parse_sfnt(in.data(), in.size(), 0, "input");
  *flavor = f.flavor;
  const std::string outlines = outline_flavor(f);  // by the tables: the sfnt version can say TrueType over CFF
  if ((outlines == "cff" || outlines == "cff2") && !allow_cff) {
    fail(Err::CffNotAllowed, "input has CFF (PostScript) outlines; EOT is defined for TrueType outlines and Internet "
         "Explorer will not render it. Convert the outlines to TrueType first, or pass --allow-cff "
         "to wrap the font anyway");
  }
  if (f.flavor == kFlavorType1) fail(Err::Type1NotAllowed, "input is a Type 1 sfnt; EOT needs TrueType outlines");
  std::string bad_sums;
  int bad_count = count_bad_checksums(in.data(), f, &bad_sums);
  if (bad_count) {
    if (strict) {
      fail(Err::Checksum, "input sfnt has %d table(s) with a wrong checksum: %s", bad_count, bad_sums.c_str());
    }
    warn("input sfnt has %d table(s) with a wrong checksum (%s); the font is embedded unchanged",
         bad_count, bad_sums.c_str());
  }

  const Table* head = f.find(kTagHead);
  const Table* os2 = f.find(kTagOS2);
  const Table* name = f.find(kTagName);
  if (!head || head->length < 54) fail(Err::MissingTable, "input has no usable 'head' table; cannot build an EOT header");
  if (!os2) fail(Err::MissingTable, "input has no 'OS/2' table; cannot build an EOT header (weight, PANOSE, fsType)");
  if (os2->length < 64) fail(Err::MissingTable, "input has a truncated 'OS/2' table (%u bytes)", os2->length);
  if (!name || name->length < 6) fail(Err::MissingTable, "input has no usable 'name' table; cannot build an EOT header");

  const uint8_t* hd = in.data() + head->offset;
  const uint8_t* o2 = in.data() + os2->offset;
  const uint8_t* nt = in.data() + name->offset;
  if (6 + 12ull * be16(nt + 2) > name->length) fail(Err::MissingTable, "input has a truncated 'name' table");

  Bytes family = pick_name(nt, name->length, 1);
  Bytes style = pick_name(nt, name->length, 2);
  Bytes version = pick_name(nt, name->length, 5);
  Bytes full = pick_name(nt, name->length, 4);
  if (family.empty()) warn("no usable family name (name ID 1) found; EOT FamilyName is empty");

  uint64_t total = (uint64_t)in.size() + 120 + family.size() + style.size() + version.size() +
                   full.size();
  if (total > 0xFFFFFFFFull) fail(Err::InputTooLarge, "input is too large for EOT");

  Bytes& o = *out;
  o.clear();
  o.reserve((size_t)total);
  put_le32(o, 0);                         // EOTSize, patched below
  put_le32(o, (uint32_t)in.size());       // FontDataSize
  put_le32(o, kEotVersion22);             // Version 0x00020002, as sfntly (production) writes
  put_le32(o, 0);                         // Flags: not subsetted, not compressed, not XOR-ed
  o.insert(o.end(), o2 + 32, o2 + 42);    // FontPANOSE = OS/2.panose
  o.push_back(1);                         // Charset = DEFAULT_CHARSET
  o.push_back((uint8_t)(be16(o2 + 62) & 1));  // Italic = OS/2.fsSelection bit 0
  put_le32(o, be16(o2 + 4));              // Weight = OS/2.usWeightClass
  put_le16(o, be16(o2 + 8));              // fsType = OS/2.fsType
  put_le16(o, kEotMagic);                 // MagicNumber
  for (int i = 0; i < 4; ++i) put_le32(o, be32(o2 + 42 + 4 * i));  // UnicodeRange1..4
  // CodePageRange1..2 exist from OS/2 version 1 on. For a version 0 table sfntly (production)
  // writes "Latin 1" (bit 0) rather than nothing; the same default is used here.
  bool has_cpr = be16(o2) >= 1 && os2->length >= 86;
  put_le32(o, has_cpr ? be32(o2 + 78) : 0x00000001);
  put_le32(o, has_cpr ? be32(o2 + 82) : 0x00000000);
  put_le32(o, be32(hd + 8));              // CheckSumAdjustment = head.checkSumAdjustment
  for (int i = 0; i < 4; ++i) put_le32(o, 0);  // Reserved1..4
  put_le16(o, 0);                         // Padding1
  put_name(o, family, "family");
  put_le16(o, 0);                         // Padding2
  put_name(o, style, "style");
  put_le16(o, 0);                         // Padding3
  put_name(o, version, "version");
  put_le16(o, 0);                         // Padding4
  put_name(o, full, "full");
  put_le16(o, 0);                         // Padding5
  put_le16(o, 0);                         // RootStringSize: no URL binding
  put_le32(o, 0x50475342);                // RootStringCheckSum of an empty RootString
  put_le32(o, 0);                         // EUDCCodePage
  put_le16(o, 0);                         // Padding6
  put_le16(o, 0);                         // SignatureSize
  put_le32(o, 0);                         // EUDCFlags
  put_le32(o, 0);                         // EUDCFontSize
  o.insert(o.end(), in.begin(), in.end());  // FontData: the input sfnt, byte for byte
  uint32_t size = (uint32_t)o.size();
  o[0] = (uint8_t)size;
  o[1] = (uint8_t)(size >> 8);
  o[2] = (uint8_t)(size >> 16);
  o[3] = (uint8_t)(size >> 24);
}

const char* eot_compression(uint32_t flags) {
  if (flags & kEotFlagCompressed) return "mtx";
  if (flags & kEotFlagXor) return "xor";
  return "none";
}

namespace {

// MTX through libeot, behind fontwrap's own checks of the size fields (libeot's pointer arithmetic on them can wrap
// on a 32-bit target).
void decode_mtx(const Bytes& in, Bytes* out) {
  const uint8_t* d = in.data();
  const size_t len = in.size();
  struct EOTMetadata meta;
  memset(&meta, 0, sizeof(meta));
  uint8_t* buf = nullptr;
  unsigned buf_size = 0;
  enum EOTError rc = EOT2ttf_buffer(d, (unsigned)len, &meta, &buf, &buf_size);
  EOTfreeMetadata(&meta);
  if (rc != EOT_SUCCESS) {
    if (buf) EOTfreeBuffer(buf);
    // libeot reserves numGlyphs x (worst-case glyph size from maxp) for the rebuilt glyf table and reports a failed
    // reservation as a corrupt file, so both possibilities are named.
    fail(Err::EotMtxFailed, "EOT decode failed: %s (libeot code %d); the font data is MTX-compressed: it is either corrupt or needs "
         "more memory to decompress than this module can allocate", eot_error_text(rc), (int)rc);
  }
  if (!buf || buf_size == 0) {
    if (buf) EOTfreeBuffer(buf);
    fail(Err::EotInvalid, "EOT decode produced no font data");
  }
  try {
    out->assign(buf, buf + buf_size);
  } catch (...) {
    EOTfreeBuffer(buf);
    throw;
  }
  EOTfreeBuffer(buf);
}

}  // namespace

void eot_decode(const Bytes& in, bool strict, uint64_t max_out, Bytes* out, uint32_t* flavor,
                EotDecodeReport* report) {
  EotHeader h;
  parse_eot_header(in.data(), in.size(), &h);
  if (h.fontDataSize == 0) fail(Err::EotInvalid, "EOT contains no font data");
  report->compression = eot_compression(h.flags);
  if (h.flags & kEotFlagCompressed) {
    report->decoder = "libeot";
    decode_mtx(in, out);
    if (out->size() > max_out) {
      fail(Err::OutputLimit, "the MTX font decodes to %zu bytes, over the %llu-byte output limit", out->size(),
           (unsigned long long)max_out);
    }
  } else {
    report->decoder = "fontwrap";
    if (h.fontDataSize > max_out) {
      fail(Err::OutputLimit, "the EOT's font data is %u bytes, over the %llu-byte output limit", h.fontDataSize,
           (unsigned long long)max_out);
    }
    out->assign(in.begin() + (ptrdiff_t)h.fontDataOffset, in.begin() + (ptrdiff_t)(h.fontDataOffset + h.fontDataSize));
    if (h.flags & kEotFlagXor) {
      for (uint8_t& b : *out) b ^= 0x50;  // the submission's XOR "encryption" key
    }
  }

  // Whatever came out must be a structurally valid sfnt, otherwise nothing is written.
  const char* what = (h.flags & kEotFlagCompressed) ? "font decompressed from the EOT (MTX)" : "font data inside the EOT";
  Sfnt f = parse_sfnt(out->data(), out->size(), 0, what);
  *flavor = f.flavor;
  // EOT has no integrity check of its own; the sfnt's table checksums are the only evidence of a damaged payload,
  // and they cannot tell damage from a font that was sloppy to begin with.
  std::string bad_sums;
  int bad_count = count_bad_checksums(out->data(), f, &bad_sums);
  if (bad_count) {
    if (strict) {
      fail(Err::Checksum, "the font inside the EOT has %d table(s) whose data does not match its checksum: %s", bad_count,
           bad_sums.c_str());
    }
    warn("%d table(s) of the font inside the EOT do not match their recorded checksum (%s); the font is written "
         "unchanged", bad_count, bad_sums.c_str());
  }
}

}  // namespace fw
