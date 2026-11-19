// names.h -- hbfont's own reading of the name table (P3b plan, section 3.4): the English string of a name id, chosen
// as fontTools chooses it, so `hbfont info` and the judges name the same thing.
#ifndef HBFONT_NAMES_H_
#define HBFONT_NAMES_H_

#include <cstdint>
#include <string>
#include <vector>

#include "common.h"
#include "sfnt.h"

namespace hbf {

// The UTF-8 string of name id `id`: the first record of (3,1,0x409), then (1,0,0) (Mac Roman), (0,3,0), (0,4,0),
// then the first record with that id in another Unicode or Mac Roman encoding. False when none exists. A name table
// that runs past its own end is sfnt-invalid.
bool english_name(const Bytes& font, const Sfnt& s, uint16_t id, std::string* out);

// UTF-8 of one code point (a surrogate or a value past U+10FFFF becomes U+FFFD).
void put_utf8(std::string* o, uint32_t cp);

// The whole name table: format, its records (raw bytes) and, for format 1, its language-tag records.
struct NameRecord {
  uint16_t platform, encoding, language, id;
  Bytes bytes;
};
struct NameTable {
  uint16_t format = 0;
  std::vector<NameRecord> records;
  std::vector<Bytes> lang_tags;  // format 1 only, each the raw UTF-16BE tag
};

// The font's name table (an empty format-0 table when it has none); sfnt-invalid when it runs past its end.
NameTable read_name_table(const Bytes& font, const Sfnt& s);

// The decoded text of a record: UTF-16BE for platform 0 and Windows encodings 1 and 10, Mac Roman for (1,0); false
// for any other encoding.
bool record_text(const NameRecord& r, std::string* out);

// The UTF-8 string as UTF-16BE; as Mac Roman (false when a character has no Mac Roman form).
Bytes utf16be(const std::string& utf8);
bool mac_roman(const std::string& utf8, Bytes* out);

// The table's bytes: records sorted by platform, encoding, language and id; strings stored once each.
Bytes write_name_table(const NameTable& t);

}  // namespace hbf

#endif  // HBFONT_NAMES_H_
