// names.cc -- see names.h.
#include "names.h"

#include <algorithm>

namespace hbf {

namespace {

// Mac OS Roman 0x80 to 0xFF, from Python's mac_roman codec (the one fontTools uses for platform 1, encoding 0).
const uint16_t kMacRoman[128] = {
    0x00C4, 0x00C5, 0x00C7, 0x00C9, 0x00D1, 0x00D6, 0x00DC, 0x00E1,
    0x00E0, 0x00E2, 0x00E4, 0x00E3, 0x00E5, 0x00E7, 0x00E9, 0x00E8,
    0x00EA, 0x00EB, 0x00ED, 0x00EC, 0x00EE, 0x00EF, 0x00F1, 0x00F3,
    0x00F2, 0x00F4, 0x00F6, 0x00F5, 0x00FA, 0x00F9, 0x00FB, 0x00FC,
    0x2020, 0x00B0, 0x00A2, 0x00A3, 0x00A7, 0x2022, 0x00B6, 0x00DF,
    0x00AE, 0x00A9, 0x2122, 0x00B4, 0x00A8, 0x2260, 0x00C6, 0x00D8,
    0x221E, 0x00B1, 0x2264, 0x2265, 0x00A5, 0x00B5, 0x2202, 0x2211,
    0x220F, 0x03C0, 0x222B, 0x00AA, 0x00BA, 0x03A9, 0x00E6, 0x00F8,
    0x00BF, 0x00A1, 0x00AC, 0x221A, 0x0192, 0x2248, 0x2206, 0x00AB,
    0x00BB, 0x2026, 0x00A0, 0x00C0, 0x00C3, 0x00D5, 0x0152, 0x0153,
    0x2013, 0x2014, 0x201C, 0x201D, 0x2018, 0x2019, 0x00F7, 0x25CA,
    0x00FF, 0x0178, 0x2044, 0x20AC, 0x2039, 0x203A, 0xFB01, 0xFB02,
    0x2021, 0x00B7, 0x201A, 0x201E, 0x2030, 0x00C2, 0x00CA, 0x00C1,
    0x00CB, 0x00C8, 0x00CD, 0x00CE, 0x00CF, 0x00CC, 0x00D3, 0x00D4,
    0xF8FF, 0x00D2, 0x00DA, 0x00DB, 0x00D9, 0x0131, 0x02C6, 0x02DC,
    0x00AF, 0x02D8, 0x02D9, 0x02DA, 0x00B8, 0x02DD, 0x02DB, 0x02C7
};

struct Record {
  uint16_t platform, encoding, language, id, length, offset;
};

bool unicode_platform(const Record& r) { return r.platform == 0 || (r.platform == 3 && (r.encoding == 1 || r.encoding == 10)); }
bool mac_roman(const Record& r) { return r.platform == 1 && r.encoding == 0; }

std::string decode(const uint8_t* p, uint32_t n, const Record& r) {
  std::string o;
  if (mac_roman(r)) {
    for (uint32_t i = 0; i < n; ++i) put_utf8(&o, p[i] < 0x80 ? p[i] : kMacRoman[p[i] - 0x80]);
    return o;
  }
  for (uint32_t i = 0; i + 1 < n; i += 2) {
    uint32_t u = be16(p + i);
    if (u >= 0xd800 && u < 0xdc00 && i + 3 < n) {
      uint32_t lo = be16(p + i + 2);
      if (lo >= 0xdc00 && lo < 0xe000) {
        put_utf8(&o, 0x10000 + ((u - 0xd800) << 10) + (lo - 0xdc00));
        i += 2;
        continue;
      }
    }
    put_utf8(&o, u);
  }
  return o;
}

}  // namespace

void put_utf8(std::string* o, uint32_t cp) {
  if ((cp >= 0xd800 && cp < 0xe000) || cp > 0x10ffff) cp = 0xfffd;
  if (cp < 0x80) {
    *o += (char)cp;
  } else if (cp < 0x800) {
    *o += (char)(0xc0 | (cp >> 6));
    *o += (char)(0x80 | (cp & 0x3f));
  } else if (cp < 0x10000) {
    *o += (char)(0xe0 | (cp >> 12));
    *o += (char)(0x80 | ((cp >> 6) & 0x3f));
    *o += (char)(0x80 | (cp & 0x3f));
  } else {
    *o += (char)(0xf0 | (cp >> 18));
    *o += (char)(0x80 | ((cp >> 12) & 0x3f));
    *o += (char)(0x80 | ((cp >> 6) & 0x3f));
    *o += (char)(0x80 | (cp & 0x3f));
  }
}

bool english_name(const Bytes& font, const Sfnt& s, uint16_t id, std::string* out) {
  const Table* t = s.find(HBF_TAG('n', 'a', 'm', 'e'));
  if (!t) return false;
  if (t->length < 6) fail(Err::SfntInvalid, "the name table is %u bytes", t->length);
  const uint8_t* base = font.data() + t->offset;
  uint32_t count = be16(base + 2), strings = be16(base + 4);
  if (6ull + 12ull * count > t->length) fail(Err::SfntInvalid, "the name table's records run past its end");
  Record best = {};
  int best_rank = 99;  // 99: no record found
  for (uint32_t i = 0; i < count; ++i) {
    const uint8_t* r = base + 6 + 12 * i;
    Record rec = {be16(r), be16(r + 2), be16(r + 4), be16(r + 6), be16(r + 8), be16(r + 10)};
    if (rec.id != id) continue;
    if ((uint64_t)strings + rec.offset + rec.length > t->length) {
      fail(Err::SfntInvalid, "name record %u runs past the name table", i);
    }
    int rank = (rec.platform == 3 && rec.encoding == 1 && rec.language == 0x409) ? 0
               : (rec.platform == 1 && rec.encoding == 0 && rec.language == 0)    ? 1
               : (rec.platform == 0 && rec.encoding == 3 && rec.language == 0)    ? 2
               : (rec.platform == 0 && rec.encoding == 4 && rec.language == 0)    ? 3
               : (unicode_platform(rec) || mac_roman(rec))                        ? 4
                                                                                  : 99;
    if (rank < best_rank) {
      best_rank = rank;
      best = rec;
    }
  }
  if (best_rank == 99) return false;
  *out = decode(base + strings + best.offset, best.length, best);
  return true;
}

NameTable read_name_table(const Bytes& font, const Sfnt& s) {
  NameTable t;
  const Table* nt = s.find(HBF_TAG('n', 'a', 'm', 'e'));
  if (!nt) return t;
  if (nt->length < 6) fail(Err::SfntInvalid, "the name table is %u bytes", nt->length);
  const uint8_t* base = font.data() + nt->offset;
  t.format = be16(base);
  uint32_t count = be16(base + 2), strings = be16(base + 4);
  if (t.format > 1) fail(Err::SfntInvalid, "name table format %u", t.format);
  if (6ull + 12ull * count > nt->length) fail(Err::SfntInvalid, "the name table's records run past its end");
  for (uint32_t i = 0; i < count; ++i) {
    const uint8_t* r = base + 6 + 12 * i;
    uint32_t len = be16(r + 8), off = be16(r + 10);
    if ((uint64_t)strings + off + len > nt->length) fail(Err::SfntInvalid, "name record %u runs past the name table", i);
    t.records.push_back({be16(r), be16(r + 2), be16(r + 4), be16(r + 6),
                         Bytes(base + strings + off, base + strings + off + len)});
  }
  if (t.format == 1) {
    uint64_t at = 6ull + 12ull * count;
    if (at + 2 > nt->length) fail(Err::SfntInvalid, "the name table's language tags run past its end");
    uint32_t tags = be16(base + at);
    if (at + 2 + 4ull * tags > nt->length) fail(Err::SfntInvalid, "the name table's language tags run past its end");
    for (uint32_t i = 0; i < tags; ++i) {
      const uint8_t* r = base + at + 2 + 4 * i;
      uint32_t len = be16(r), off = be16(r + 2);
      if ((uint64_t)strings + off + len > nt->length) fail(Err::SfntInvalid, "a language tag runs past the name table");
      t.lang_tags.push_back(Bytes(base + strings + off, base + strings + off + len));
    }
  }
  return t;
}

bool record_text(const NameRecord& r, std::string* out) {
  Record rec = {r.platform, r.encoding, r.language, r.id, (uint16_t)r.bytes.size(), 0};
  if (!unicode_platform(rec) && !mac_roman(rec)) return false;
  *out = decode(r.bytes.data(), (uint32_t)r.bytes.size(), rec);
  return true;
}

namespace {

// The code points of a UTF-8 string (hbfont makes every string it encodes, so a malformed byte is U+FFFD).
std::vector<uint32_t> code_points(const std::string& s) {
  std::vector<uint32_t> out;
  for (size_t i = 0; i < s.size();) {
    unsigned char c = (unsigned char)s[i];
    int extra = c < 0x80 ? 0 : c >= 0xf0 ? 3 : c >= 0xe0 ? 2 : c >= 0xc0 ? 1 : -1;
    if (extra < 0 || (extra > 0 && i + extra >= s.size())) {
      out.push_back(0xfffd);
      ++i;
      continue;
    }
    uint32_t cp = extra ? (c & (0x3f >> extra)) : c;
    for (int k = 1; k <= extra; ++k) cp = (cp << 6) | ((unsigned char)s[i + k] & 0x3f);
    out.push_back(cp);
    i += 1 + extra;
  }
  return out;
}

}  // namespace

Bytes utf16be(const std::string& utf8) {
  Bytes b;
  for (uint32_t cp : code_points(utf8)) {
    if (cp >= 0x10000) {
      uint32_t v = cp - 0x10000, hi = 0xd800 + (v >> 10), lo = 0xdc00 + (v & 0x3ff);
      b.push_back((uint8_t)(hi >> 8));
      b.push_back((uint8_t)hi);
      b.push_back((uint8_t)(lo >> 8));
      b.push_back((uint8_t)lo);
    } else {
      b.push_back((uint8_t)(cp >> 8));
      b.push_back((uint8_t)cp);
    }
  }
  return b;
}

bool mac_roman(const std::string& utf8, Bytes* out) {
  out->clear();
  for (uint32_t cp : code_points(utf8)) {
    if (cp < 0x80) {
      out->push_back((uint8_t)cp);
      continue;
    }
    int found = -1;
    for (int k = 0; k < 128 && found < 0; ++k) {
      if (kMacRoman[k] == cp) found = k;
    }
    if (found < 0) return false;
    out->push_back((uint8_t)(0x80 + found));
  }
  return true;
}

Bytes write_name_table(const NameTable& t) {
  std::vector<NameRecord> recs = t.records;
  std::stable_sort(recs.begin(), recs.end(), [](const NameRecord& a, const NameRecord& b) {
    if (a.platform != b.platform) return a.platform < b.platform;
    if (a.encoding != b.encoding) return a.encoding < b.encoding;
    if (a.language != b.language) return a.language < b.language;
    return a.id < b.id;
  });
  if (recs.size() > 0xffff || t.lang_tags.size() > 0xffff) fail(Err::OutputInvalid, "too many name records");
  Bytes strings;
  std::vector<std::pair<uint16_t, uint16_t>> placed;  // offset, length per record, then per language tag
  auto place = [&](const Bytes& b) {
    for (size_t at = 0; at + b.size() <= strings.size() && !b.empty(); ++at) {
      if (std::equal(b.begin(), b.end(), strings.begin() + (long)at)) return std::make_pair((uint16_t)at, (uint16_t)b.size());
    }
    if (strings.size() + b.size() > 0xffff) fail(Err::OutputInvalid, "the name table's strings exceed 64 KiB");
    uint16_t at = (uint16_t)strings.size();
    strings.insert(strings.end(), b.begin(), b.end());
    return std::make_pair(at, (uint16_t)b.size());
  };
  for (const NameRecord& r : recs) placed.push_back(place(r.bytes));
  for (const Bytes& tag : t.lang_tags) placed.push_back(place(tag));
  size_t head = 6 + 12 * recs.size() + (t.format == 1 ? 2 + 4 * t.lang_tags.size() : 0);
  if (head > 0xffff) fail(Err::OutputInvalid, "the name table's header exceeds 64 KiB");
  Bytes out;
  auto put16 = [&](uint32_t v) {
    out.push_back((uint8_t)(v >> 8));
    out.push_back((uint8_t)v);
  };
  put16(t.format);
  put16((uint32_t)recs.size());
  put16((uint32_t)head);
  for (size_t i = 0; i < recs.size(); ++i) {
    put16(recs[i].platform);
    put16(recs[i].encoding);
    put16(recs[i].language);
    put16(recs[i].id);
    put16(placed[i].second);
    put16(placed[i].first);
  }
  if (t.format == 1) {
    put16((uint32_t)t.lang_tags.size());
    for (size_t i = 0; i < t.lang_tags.size(); ++i) {
      put16(placed[recs.size() + i].second);
      put16(placed[recs.size() + i].first);
    }
  }
  out.insert(out.end(), strings.begin(), strings.end());
  return out;
}

}  // namespace hbf
