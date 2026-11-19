// woff1.cc -- see woff1.h. From spike S2, with the layout checks shared with `info` and padding checked (P1-3).
//
// WOFF 1.0 layout (all big-endian):
//   WOFFHeader (44 bytes): signature 'wOFF', flavor, length, numTables, reserved, totalSfntSize, majorVersion,
//                          minorVersion, metaOffset, metaLength, metaOrigLength, privOffset, privLength
//   TableDirectoryEntry (20 bytes each, ascending tag): tag, offset, compLength, origLength, origChecksum
//   table data, each block on a 4-byte boundary, zero-padded; optional metadata block, optional private block
#include "woff1.h"

#include <zlib.h>

#include <algorithm>

#include "sfnt.h"

namespace fw {

namespace {

const uint32_t WOFF_SIGNATURE = FW_TAG('w', 'O', 'F', 'F');
const size_t WOFF_HEADER_BYTES = 44;
const size_t WOFF_ENTRY_BYTES = 20;
const int ZLIB_LEVEL = 9;

struct Block {
  uint64_t start, end;
  std::string name;
};

// Nothing but zero bytes in [from, to): the only data the spec allows between blocks is padding of null bytes.
void require_padding(const uint8_t* d, uint64_t from, uint64_t to, const std::string& where) {
  for (uint64_t p = from; p < to; ++p) {
    if (d[p] != 0) fail(Err::WoffInvalid, "WOFF is invalid: extraneous data %s (a padding byte is 0x%02X, not zero)", where.c_str(), d[p]);
  }
}

}  // namespace

WoffLayout woff1_layout(const Bytes& in) {
  const uint8_t* d = in.data();
  const uint64_t size = in.size();
  if (size < WOFF_HEADER_BYTES) fail(Err::WoffInvalid, "input is truncated: shorter than a WOFF header");
  if (be32(d) != WOFF_SIGNATURE) fail(Err::WoffInvalid, "input is not a WOFF 1.0 file (bad signature)");
  WoffLayout L;
  L.flavor = be32(d + 4);
  L.length = be32(d + 8);
  const uint32_t n = be16(d + 12);
  const uint32_t reserved = be16(d + 14);
  L.totalSfntSize = be32(d + 16);
  L.majorVersion = be16(d + 20);
  L.minorVersion = be16(d + 22);
  L.metaOffset = be32(d + 24);
  L.metaLength = be32(d + 28);
  L.metaOrigLength = be32(d + 32);
  L.privOffset = be32(d + 36);
  L.privLength = be32(d + 40);

  if (L.length != size) {
    fail(Err::WoffInvalid, "WOFF is truncated or corrupt: header says %u bytes, file has %llu", L.length, (unsigned long long)size);
  }
  if (!is_sfnt_flavor(L.flavor)) fail(Err::WoffInvalid, "WOFF has an unsupported font flavor 0x%08X", L.flavor);
  if (reserved != 0) fail(Err::WoffInvalid, "WOFF is invalid: reserved header field is not zero");
  if (n == 0) fail(Err::WoffInvalid, "WOFF has an empty table directory");
  if (n > MAX_TABLES) fail(Err::WoffInvalid, "WOFF declares %u tables (limit %u)", n, MAX_TABLES);
  const uint64_t dir_end = WOFF_HEADER_BYTES + WOFF_ENTRY_BYTES * (uint64_t)n;
  if (dir_end > size) fail(Err::WoffInvalid, "WOFF is truncated: table directory runs past the end of the file");
  if ((L.metaOffset == 0) != (L.metaLength == 0) || (L.metaLength == 0 && L.metaOrigLength != 0)) {
    fail(Err::WoffInvalid, "WOFF is invalid: inconsistent metadata offset/length fields");
  }
  if ((L.privOffset == 0) != (L.privLength == 0)) fail(Err::WoffInvalid, "WOFF is invalid: inconsistent private-data offset/length fields");

  std::vector<Block> blocks;
  uint64_t expect_total = 12 + 16ull * n;
  L.entries.resize(n);
  for (uint32_t i = 0; i < n; ++i) {
    const uint8_t* e = d + WOFF_HEADER_BYTES + WOFF_ENTRY_BYTES * (size_t)i;
    WoffEntry& w = L.entries[i];
    w.tag = be32(e);
    w.offset = be32(e + 4);
    w.compLength = be32(e + 8);
    w.origLength = be32(e + 12);
    w.origChecksum = be32(e + 16);
    std::string name = "table '" + tag_str(w.tag) + "'";
    if (w.compLength > w.origLength) {
      fail(Err::WoffInvalid, "WOFF is invalid: %s has compLength %u greater than origLength %u", name.c_str(), w.compLength,
           w.origLength);
    }
    if ((uint64_t)w.offset + w.compLength > size) {
      fail(Err::WoffInvalid, "WOFF is truncated or corrupt: %s (offset %u, length %u) runs past the end of the file", name.c_str(),
           w.offset, w.compLength);
    }
    if (w.offset < dir_end || (w.offset & 3) != 0) {
      fail(Err::WoffInvalid, "WOFF is invalid: %s starts at offset %u (inside the directory or not 4-byte aligned)", name.c_str(),
           w.offset);
    }
    if (w.compLength < w.origLength &&
        (uint64_t)w.origLength > WOFF_MAX_INFLATE_RATIO * w.compLength + WOFF_INFLATE_SLACK_BYTES) {
      fail(Err::WoffInvalid, "WOFF is corrupt: %s claims to inflate from %u to %u bytes", name.c_str(), w.compLength, w.origLength);
    }
    expect_total += round4(w.origLength);
    blocks.push_back({w.offset, (uint64_t)w.offset + w.compLength, name});
  }
  std::vector<uint32_t> tags;
  for (const WoffEntry& w : L.entries) tags.push_back(w.tag);
  std::sort(tags.begin(), tags.end());
  for (size_t i = 1; i < tags.size(); ++i) {
    if (tags[i - 1] == tags[i]) fail(Err::WoffInvalid, "WOFF is invalid: table '%s' is listed twice", tag_str(tags[i]).c_str());
  }
  if (expect_total != L.totalSfntSize) {
    fail(Err::WoffInvalid, "WOFF is invalid: totalSfntSize is %u but the tables add up to %llu", L.totalSfntSize,
         (unsigned long long)expect_total);
  }
  if (expect_total > MAX_OUTPUT_BYTES) {
    fail(Err::OutputLimit, "WOFF decodes to more than the %llu MiB output limit", (unsigned long long)(MAX_OUTPUT_BYTES >> 20));
  }
  if (L.metaLength) {
    if ((uint64_t)L.metaOffset + L.metaLength > size) fail(Err::WoffInvalid, "WOFF is truncated: metadata block runs past the end");
    blocks.push_back({L.metaOffset, (uint64_t)L.metaOffset + L.metaLength, "metadata block"});
  }
  if (L.privLength) {
    if ((uint64_t)L.privOffset + L.privLength > size) fail(Err::WoffInvalid, "WOFF is truncated: private block runs past the end");
    blocks.push_back({L.privOffset, (uint64_t)L.privOffset + L.privLength, "private data block"});
  }
  // No overlap, and nothing between or after the blocks but null padding (spec section 3). An empty block sorts
  // before a non-empty one that starts at the same offset.
  std::stable_sort(blocks.begin(), blocks.end(), [](const Block& a, const Block& b) {
    return a.start != b.start ? a.start < b.start : a.end < b.end;
  });
  uint64_t prev_end = dir_end;
  for (const Block& b : blocks) {
    if (b.start < prev_end) fail(Err::WoffInvalid, "WOFF is invalid: %s overlaps the data before it", b.name.c_str());
    if (b.start != round4(prev_end)) fail(Err::WoffInvalid, "WOFF is invalid: extraneous data before %s", b.name.c_str());
    require_padding(d, prev_end, b.start, "before " + b.name);
    prev_end = b.end;
  }
  if (size != prev_end && size != round4(prev_end)) fail(Err::WoffInvalid, "WOFF is invalid: extraneous data after the last block");
  require_padding(d, prev_end, size, "after the last block");
  return L;
}

void woff1_encode(const Bytes& in, bool strict, Bytes* out, uint32_t* flavor) {
  if (in.size() >= 4 && be32(in.data()) == kFlavorCollection) {
    fail(Err::CollectionNotAllowed, "input is a font collection (.ttc/.otc); WOFF 1.0 can hold only a single font. Use woff2-encode, or extract "
         "one face first");
  }
  Sfnt f = parse_sfnt(in.data(), in.size(), 0, "input");
  *flavor = f.flavor;
  const size_t n = f.tables.size();

  // "Well-formed" checks (spec section 5). They never change what is written.
  LayoutReport layout = check_layout(in.data(), in.size(), f);
  if (!layout.canonical) {
    if (strict) fail(Err::LayoutNotCanonical, "input sfnt is not well-formed: %s", layout.reason.c_str());
    warn("input sfnt is not in canonical layout (%s); the font decoded from this WOFF keeps every table byte for "
         "byte but will not be bit-identical as a file", layout.reason.c_str());
  }
  std::string bad_sums;
  int bad_count = count_bad_checksums(in.data(), f, &bad_sums);
  if (bad_count) {
    if (strict) fail(Err::Checksum, "input sfnt has %d table(s) with a wrong checksum: %s", bad_count, bad_sums.c_str());
    warn("input sfnt has %d table(s) with a wrong checksum (%s); checksums are copied unchanged", bad_count,
         bad_sums.c_str());
  }

  uint64_t total_sfnt = 12 + 16ull * n;
  for (const Table& t : f.tables) total_sfnt += round4(t.length);
  if (total_sfnt > 0xFFFFFFFFull) fail(Err::InputTooLarge, "input is too large for WOFF 1.0");

  Bytes& o = *out;
  o.clear();
  o.resize(WOFF_HEADER_BYTES + WOFF_ENTRY_BYTES * n, 0);
  std::vector<WoffEntry> entries(n);
  Bytes scratch;
  for (size_t i : physical_order(f)) {
    const Table& t = f.tables[i];
    WoffEntry& e = entries[i];
    e.tag = t.tag;
    e.origLength = t.length;
    e.origChecksum = t.checksum;
    e.offset = (uint32_t)o.size();
    e.compLength = t.length;
    const uint8_t* src = in.data() + t.offset;
    bool stored = false;
    if (t.length > 0) {
      uLongf clen = compressBound(t.length);
      scratch.resize(clen);
      int rc = compress2(scratch.data(), &clen, src, t.length, ZLIB_LEVEL);
      if (rc != Z_OK) fail(Err::ZlibFailed, "zlib failed while compressing table '%s' (code %d)", tag_str(t.tag).c_str(), rc);
      if (clen < t.length) {
        o.insert(o.end(), scratch.begin(), scratch.begin() + (ptrdiff_t)clen);
        e.compLength = (uint32_t)clen;
        stored = true;
      }
    }
    if (!stored) o.insert(o.end(), src, src + t.length);  // spec: store raw unless strictly smaller
    o.resize(round4(o.size()), 0);
    if (o.size() > 0xFFFFFFFFull) fail(Err::InputTooLarge, "output is too large for WOFF 1.0");
  }

  // The WOFF version is the font's head.fontRevision (its two 16-bit halves), as fontTools writes; 0.0 without head.
  uint16_t major = 0, minor = 0;
  const Table* head = f.find(kTagHead);
  if (head && head->length >= 8) {
    major = be16(in.data() + head->offset + 4);
    minor = be16(in.data() + head->offset + 6);
  }
  uint8_t* h = o.data();
  set_be32(h + 0, WOFF_SIGNATURE);
  set_be32(h + 4, f.flavor);
  set_be32(h + 8, (uint32_t)o.size());
  set_be16(h + 12, (uint16_t)n);
  set_be16(h + 14, 0);
  set_be32(h + 16, (uint32_t)total_sfnt);
  set_be16(h + 20, major);
  set_be16(h + 22, minor);
  // metaOffset, metaLength, metaOrigLength, privOffset, privLength stay zero: no such blocks are written.

  std::vector<WoffEntry> sorted(entries);
  std::sort(sorted.begin(), sorted.end(), [](const WoffEntry& a, const WoffEntry& b) { return a.tag < b.tag; });
  for (size_t i = 0; i < n; ++i) {
    uint8_t* e = o.data() + WOFF_HEADER_BYTES + WOFF_ENTRY_BYTES * i;
    set_be32(e + 0, sorted[i].tag);
    set_be32(e + 4, sorted[i].offset);
    set_be32(e + 8, sorted[i].compLength);
    set_be32(e + 12, sorted[i].origLength);
    set_be32(e + 16, sorted[i].origChecksum);
  }
}

void woff1_decode(const Bytes& in, bool strict, uint64_t max_out, Bytes* out, uint32_t* flavor) {
  const WoffLayout L = woff1_layout(in);
  const uint8_t* d = in.data();
  const size_t n = L.entries.size();

  // sfnt layout: directory in ascending tag order, table data in the order it is stored in the WOFF (zero-length
  // tables first on ties), each table padded to 4 bytes.
  std::vector<size_t> phys(n);
  for (size_t i = 0; i < n; ++i) phys[i] = i;
  std::stable_sort(phys.begin(), phys.end(), [&L](size_t a, size_t b) {
    if (L.entries[a].offset != L.entries[b].offset) return L.entries[a].offset < L.entries[b].offset;
    return (L.entries[a].origLength != 0) < (L.entries[b].origLength != 0);
  });
  std::vector<uint32_t> sfnt_offset(n);
  uint64_t off = 12 + 16ull * n;
  for (size_t i : phys) {
    sfnt_offset[i] = (uint32_t)off;
    off += round4(L.entries[i].origLength);
  }

  if (L.totalSfntSize > max_out) {
    fail(Err::OutputLimit, "WOFF decodes to %u bytes, over the %llu-byte output limit", L.totalSfntSize,
         (unsigned long long)max_out);
  }
  Bytes& o = *out;
  o.assign((size_t)L.totalSfntSize, 0);
  std::string bad_sums;
  int bad_count = 0;
  for (size_t i = 0; i < n; ++i) {
    const WoffEntry& w = L.entries[i];
    uint8_t* dst = o.data() + sfnt_offset[i];
    if (w.compLength == w.origLength) {
      std::copy(d + w.offset, d + w.offset + w.origLength, dst);
    } else {
      uLongf dlen = w.origLength;
      int rc = uncompress(dst, &dlen, d + w.offset, w.compLength);
      if (rc != Z_OK || dlen != w.origLength) {
        fail(Err::WoffInvalid, "WOFF is corrupt: table '%s' does not inflate to its declared %u bytes (zlib code %d, got %lu)",
             tag_str(w.tag).c_str(), w.origLength, rc, (unsigned long)dlen);
      }
    }
    Table t = {w.tag, w.origChecksum, sfnt_offset[i], w.origLength};
    if (table_checksum(o.data(), t) != w.origChecksum) {
      if (bad_count < 8) bad_sums += (bad_count ? ", " : "") + tag_str(w.tag);
      ++bad_count;
    }
  }
  if (bad_count) {
    if (strict) fail(Err::Checksum, "WOFF has %d table(s) whose data does not match its checksum: %s", bad_count, bad_sums.c_str());
    warn("%d table(s) do not match their recorded checksum (%s); data and checksums are written unchanged", bad_count,
         bad_sums.c_str());
  }
  if (L.metaLength || L.privLength) note("the WOFF metadata/private block is not part of the font and is not carried over");

  std::vector<size_t> by_tag(n);
  for (size_t i = 0; i < n; ++i) by_tag[i] = i;
  std::sort(by_tag.begin(), by_tag.end(), [&L](size_t a, size_t b) { return L.entries[a].tag < L.entries[b].tag; });
  uint16_t sr, es, rs;
  search_params((uint16_t)n, &sr, &es, &rs);
  uint8_t* h = o.data();
  set_be32(h, L.flavor);
  set_be16(h + 4, (uint16_t)n);
  set_be16(h + 6, sr);
  set_be16(h + 8, es);
  set_be16(h + 10, rs);
  for (size_t k = 0; k < n; ++k) {
    const size_t i = by_tag[k];
    uint8_t* e = h + 12 + 16 * k;
    set_be32(e + 0, L.entries[i].tag);
    set_be32(e + 4, L.entries[i].origChecksum);
    set_be32(e + 8, sfnt_offset[i]);
    set_be32(e + 12, L.entries[i].origLength);
  }
  *flavor = L.flavor;
}

}  // namespace fw
