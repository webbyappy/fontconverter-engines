// cff_namekey.cc -- see cff_namekey.h.
#include "cff_namekey.h"

#include <hb-ot.h>
#include <hb.h>

#include <cstring>
#include <map>
#include <set>

#include "cff.h"
#include "cff_std_strings.h"
#include "sfnt.h"

namespace hbf {

namespace {

const uint32_t kPost = HBF_TAG('p', 'o', 's', 't');

void put16(Bytes* b, uint32_t v) {
  b->push_back((uint8_t)(v >> 8));
  b->push_back((uint8_t)v);
}

void put32(Bytes* b, uint32_t v) {
  for (int k = 24; k >= 0; k -= 8) b->push_back((uint8_t)(v >> k));
}

void int5(Bytes* b, int64_t v) {  // a DICT integer in its 5-byte form, so a DICT's size does not depend on its values
  b->push_back(29);
  put32(b, (uint32_t)(int32_t)v);
}

void op(Bytes* b, int o) {
  if (o >= 1200) b->push_back(12);
  b->push_back((uint8_t)(o >= 1200 ? o - 1200 : o));
}

// An INDEX of the items with the smallest offSize that holds them.
Bytes index_of(const std::vector<Bytes>& items) {
  Bytes b;
  put16(&b, (uint32_t)items.size());
  if (items.empty()) return b;
  size_t data = 1;
  for (const Bytes& x : items) data += x.size();
  uint8_t off = data <= 0xff ? 1 : data <= 0xffff ? 2 : data <= 0xffffff ? 3 : 4;
  b.push_back(off);
  size_t o = 1;
  auto put_off = [&](size_t v) {
    for (int k = off - 1; k >= 0; --k) b.push_back((uint8_t)(v >> (8 * k)));
  };
  put_off(o);
  for (const Bytes& x : items) put_off(o += x.size());
  for (const Bytes& x : items) b.insert(b.end(), x.begin(), x.end());
  return b;
}

bool valid_name(const std::string& s) {
  if (s.empty() || s.size() > 63) return false;
  for (unsigned char ch : s) {
    if (ch < 33 || ch > 126 || strchr("[](){}<>/%", ch)) return false;
  }
  return true;
}

bool is_sid_op(int o) {  // version, Notice, FullName, FamilyName, Weight, Copyright, PostScript, BaseFontName
  return o <= 4 || o == 1200 || o == 1221 || o == 1222;
}

bool is_dropped_op(int o) {  // CID entries, the offsets written afresh, SyntheticBase
  return (o >= 1230 && o <= 1238) || o == 15 || o == 16 || o == 17 || o == 18 || o == 1220;
}

}  // namespace

std::vector<std::string> post_glyph_names(const Bytes& font, std::string* why) {
  Sfnt s = parse_sfnt(font);
  const Table* post = s.find(kPost);
  if (!post || post->length < 32) {
    *why = "no post table";
    return {};
  }
  if (be32(font.data() + post->offset) != 0x00020000) {
    *why = "post is not format 2 (no glyph names)";
    return {};
  }
  hb_blob_t* blob = hb_blob_create((const char*)font.data(), (unsigned)font.size(), HB_MEMORY_MODE_READONLY, nullptr, nullptr);
  hb_face_t* face = hb_face_create(blob, 0);
  hb_font_t* f = hb_font_create(face);
  unsigned n = hb_face_get_glyph_count(face);
  std::vector<std::string> names;
  char buf[256];
  for (unsigned g = 0; g < n; ++g) {
    if (!hb_font_get_glyph_name(f, g, buf, sizeof buf)) {
      *why = "glyph " + std::to_string(g) + " has no name in post";
      names.clear();
      break;
    }
    names.emplace_back(buf);
  }
  hb_font_destroy(f);
  hb_face_destroy(face);
  hb_blob_destroy(blob);
  return names;
}

Bytes cff_name_keyed(const Bytes& c, const std::vector<std::string>& names, const std::string& font_name,
                     std::string* why) {
  auto stays = [&](const std::string& w) {
    *why = w;
    return Bytes();
  };
  std::vector<CffDictEntry> top = cff_top_dict(c);
  CffIndex name_index = cff_read_index(c, c[2]);
  CffIndex top_index = cff_read_index(c, name_index.end);
  CffIndex strings = cff_read_index(c, top_index.end);
  CffIndex gsubrs = cff_read_index(c, strings.end);
  bool ros = false;
  int64_t cs_at = 0, fd_at = 0;
  for (const CffDictEntry& e : top) {
    if (e.op == 1230) ros = true;
    if (e.op == 17 && !e.operands.empty()) cs_at = e.operands.back().value;
    if (e.op == 1236 && !e.operands.empty()) fd_at = e.operands.back().value;
  }
  if (!ros) return stays("not CID-keyed");
  if (gsubrs.count) return stays("global subroutines");
  if (cs_at <= 0 || fd_at <= 0 || (uint64_t)cs_at >= c.size() || (uint64_t)fd_at >= c.size()) {
    fail(Err::CffInvalid, "the CID-keyed CFF lacks its CharStrings or FDArray");
  }
  CffIndex fds = cff_read_index(c, (size_t)fd_at);
  if (fds.count != 1) return stays(std::to_string(fds.count) + " FDs");
  int64_t priv_size = -1, priv_at = -1;
  for (const CffDictEntry& e : cff_read_dict(c, fds.item_start[0], fds.item_start[1])) {
    if (e.op == 18 && e.operands.size() == 2) {
      priv_size = e.operands[0].value;
      priv_at = e.operands[1].value;
    } else if (e.op != 1238) {  // the FD's FontName is dropped; anything else (a FontMatrix) keeps it CID-keyed
      return stays("the FD carries operator " + std::to_string(e.op));
    }
  }
  if (priv_size < 0 || priv_at < 0 || (uint64_t)(priv_at + priv_size) > c.size()) {
    fail(Err::CffInvalid, "the FD's Private DICT is missing or runs past the table");
  }
  for (const CffDictEntry& e : cff_read_dict(c, (size_t)priv_at, (size_t)(priv_at + priv_size))) {
    if (e.op == 19) return stays("local subroutines");
  }
  CffIndex cs = cff_read_index(c, (size_t)cs_at);
  if (names.size() != cs.count) return stays("post names " + std::to_string(names.size()) + " glyphs, CFF " +
                                             std::to_string(cs.count));
  std::set<std::string> seen;
  for (size_t g = 0; g < names.size(); ++g) {
    if (!valid_name(names[g])) return stays("glyph " + std::to_string(g) + "'s name is not a PostScript name");
    if ((g == 0) != (names[g] == ".notdef")) return stays(".notdef is not glyph 0 alone");
    if (!seen.insert(names[g]).second) return stays("two glyphs are named " + names[g]);
  }

  // Strings: the standard ones by their SIDs, the others from 391 in order of first use.
  std::map<std::string, int> standard;
  for (int i = 0; i < kCffStandardStringCount; ++i) standard[kCffStandardStrings[i]] = i;
  std::vector<Bytes> fresh;
  std::map<std::string, int> fresh_sid;
  auto sid_of = [&](const std::string& s) {
    auto it = standard.find(s);
    if (it != standard.end()) return it->second;
    auto f = fresh_sid.find(s);
    if (f != fresh_sid.end()) return f->second;
    int sid = kCffStandardStringCount + (int)fresh.size();
    fresh.emplace_back(s.begin(), s.end());
    fresh_sid[s] = sid;
    return sid;
  };
  auto old_string = [&](int64_t sid) {
    if (sid < kCffStandardStringCount) return std::string(kCffStandardStrings[sid]);
    if ((uint64_t)(sid - kCffStandardStringCount) >= strings.count) fail(Err::CffInvalid, "a SID past the String INDEX");
    size_t k = (size_t)(sid - kCffStandardStringCount);
    return std::string(c.begin() + strings.item_start[k], c.begin() + strings.item_start[k + 1]);
  };

  // The Top DICT without its offsets: kept entries as they are, SID entries renumbered.
  Bytes kept;
  for (const CffDictEntry& e : top) {
    if (is_dropped_op(e.op)) continue;
    if (is_sid_op(e.op)) {
      if (e.operands.size() != 1 || e.operands[0].kind == 30 || e.operands[0].value < 0) {
        fail(Err::CffInvalid, "Top DICT operator %d does not hold one SID", e.op);
      }
      int5(&kept, sid_of(old_string(e.operands[0].value)));
      op(&kept, e.op);
    } else {
      kept.insert(kept.end(), c.begin() + e.from, c.begin() + e.to);
    }
  }
  Bytes charset{0};  // format 0: one SID per glyph after .notdef
  for (size_t g = 1; g < names.size(); ++g) put16(&charset, (uint32_t)sid_of(names[g]));
  Bytes charstrings(c.begin() + cs.start, c.begin() + cs.end);
  Bytes priv(c.begin() + priv_at, c.begin() + priv_at + priv_size);

  // Layout: header, Name, Top DICT, String, Global Subrs (empty), charset, CharStrings, Private.
  auto top_dict = [&](int64_t charset_at, int64_t charstrings_at, int64_t private_at) {
    Bytes t = kept;
    int5(&t, charset_at);
    op(&t, 15);
    int5(&t, charstrings_at);
    op(&t, 17);
    int5(&t, (int64_t)priv.size());
    int5(&t, private_at);
    op(&t, 18);
    return t;
  };
  Bytes head{1, 0, 4, 4};
  Bytes name_idx = index_of({Bytes(font_name.begin(), font_name.end())});
  size_t top_size = index_of({top_dict(0, 0, 0)}).size();
  Bytes string_idx = index_of(fresh);
  Bytes gsubr_idx = index_of({});
  size_t charset_at = head.size() + name_idx.size() + top_size + string_idx.size() + gsubr_idx.size();
  size_t charstrings_at = charset_at + charset.size();
  size_t private_at = charstrings_at + charstrings.size();
  Bytes top_idx = index_of({top_dict((int64_t)charset_at, (int64_t)charstrings_at, (int64_t)private_at)});
  if (top_idx.size() != top_size) fail(Err::OutputInvalid, "the name-keyed Top DICT changed size");
  Bytes out;
  for (const Bytes* part : {&head, &name_idx, &top_idx, &string_idx, &gsubr_idx, &charset, &charstrings, &priv}) {
    out.insert(out.end(), part->begin(), part->end());
  }
  why->clear();
  return out;
}

Bytes post_format3(const Bytes& font) {
  Sfnt s = parse_sfnt(font);
  const Table* post = s.find(kPost);
  if (!post || post->length < 32) fail(Err::OutputInvalid, "the font has no post table");
  Bytes p(font.begin() + post->offset, font.begin() + post->offset + 32);
  p[0] = 0;
  p[1] = 3;
  p[2] = 0;
  p[3] = 0;
  return p;
}

}  // namespace hbf
