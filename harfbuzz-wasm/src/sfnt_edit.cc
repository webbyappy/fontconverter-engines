// sfnt_edit.cc -- see sfnt_edit.h.
#include "sfnt_edit.h"

#include <algorithm>
#include <vector>

#include "sfnt.h"

namespace hbf {

uint32_t table_checksum(const uint8_t* p, size_t n) {
  uint32_t sum = 0;
  for (size_t i = 0; i < n; i += 4) {
    uint32_t w = 0;
    for (size_t k = 0; k < 4; ++k) w = (w << 8) | (i + k < n ? p[i + k] : 0);
    sum += w;
  }
  return sum;
}

namespace {

void put32(Bytes* b, size_t at, uint32_t v) {
  (*b)[at] = (uint8_t)(v >> 24);
  (*b)[at + 1] = (uint8_t)(v >> 16);
  (*b)[at + 2] = (uint8_t)(v >> 8);
  (*b)[at + 3] = (uint8_t)v;
}

void put16(Bytes* b, size_t at, uint16_t v) {
  (*b)[at] = (uint8_t)(v >> 8);
  (*b)[at + 1] = (uint8_t)v;
}

}  // namespace

Bytes replace_tables(const Bytes& font, const std::map<uint32_t, Bytes>& replace) {
  Sfnt s = parse_sfnt(font);
  struct Entry {
    uint32_t tag;
    const uint8_t* data;
    size_t len;
  };
  std::vector<Entry> entries;
  for (const Table& t : s.tables) {
    auto r = replace.find(t.tag);
    if (r != replace.end()) entries.push_back({t.tag, r->second.data(), r->second.size()});
    else entries.push_back({t.tag, font.data() + t.offset, t.length});
  }
  for (const auto& r : replace) {
    if (!s.find(r.first)) entries.push_back({r.first, r.second.data(), r.second.size()});
  }
  // The directory is sorted by tag (OpenType); the data keeps the font's order.
  std::vector<size_t> by_tag(entries.size());
  for (size_t i = 0; i < entries.size(); ++i) by_tag[i] = i;
  std::sort(by_tag.begin(), by_tag.end(), [&](size_t a, size_t b) { return entries[a].tag < entries[b].tag; });
  uint16_t n = (uint16_t)entries.size();
  uint16_t pow2 = 1, log2 = 0;
  while ((uint32_t)pow2 * 2 <= n) {
    pow2 *= 2;
    ++log2;
  }
  size_t dir = 12 + 16 * (size_t)n;
  size_t total = dir;
  for (const Entry& e : entries) total += round4(e.len);
  if (total > 0xffffffffu) fail(Err::OutputInvalid, "the font would be %zu bytes", total);
  Bytes out(total, 0);
  put32(&out, 0, s.version);
  put16(&out, 4, n);
  put16(&out, 6, (uint16_t)(pow2 * 16));
  put16(&out, 8, log2);
  put16(&out, 10, (uint16_t)(n * 16 - pow2 * 16));
  std::vector<size_t> offsets(entries.size());
  size_t at = dir;
  for (size_t i = 0; i < entries.size(); ++i) {
    offsets[i] = at;
    std::copy(entries[i].data, entries[i].data + entries[i].len, out.begin() + (long)at);
    at += round4(entries[i].len);
  }
  size_t head_at = 0;
  for (size_t k = 0; k < by_tag.size(); ++k) {
    const size_t i = by_tag[k];
    if (entries[i].tag == HBF_TAG('h', 'e', 'a', 'd')) {
      if (entries[i].len < 54) fail(Err::OutputInvalid, "the head table is %zu bytes", entries[i].len);
      head_at = offsets[i];
      put32(&out, head_at + 8, 0);
    }
  }
  for (size_t k = 0; k < by_tag.size(); ++k) {
    const size_t i = by_tag[k];
    const size_t r = 12 + 16 * k;
    put32(&out, r, entries[i].tag);
    put32(&out, r + 4, table_checksum(out.data() + offsets[i], entries[i].len));
    put32(&out, r + 8, (uint32_t)offsets[i]);
    put32(&out, r + 12, (uint32_t)entries[i].len);
  }
  if (head_at) put32(&out, head_at + 8, 0xB1B0AFBAu - table_checksum(out.data(), out.size()));
  return out;
}

}  // namespace hbf
