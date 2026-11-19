// info.cc -- see info.h. Reads headers and directories; never inflates or decodes table data.
#include "info.h"

#include <cinttypes>

#include "eot.h"
#include "sfnt.h"
#include "woff1.h"
#include "woff2_wrap.h"

namespace fw {

namespace {

const uint32_t WOFF_SIGNATURE = FW_TAG('w', 'O', 'F', 'F');
const uint32_t WOFF2_SIGNATURE = FW_TAG('w', 'O', 'F', '2');

// A tiny JSON writer; commas are inserted automatically.
class JW {
 public:
  void obj_begin() { comma(); s_ += '{'; first_ = true; }
  void obj_end() { s_ += '}'; first_ = false; }
  void arr_begin() { comma(); s_ += '['; first_ = true; }
  void arr_end() { s_ += ']'; first_ = false; }
  void key(const char* k) { comma(); s_ += '"'; s_ += k; s_ += "\":"; first_ = true; }
  void str(const std::string& v) { comma(); s_ += json_quote(v); first_ = false; }
  void raw(const std::string& v) { comma(); s_ += v; first_ = false; }
  void num(uint64_t v) {
    char buf[32];
    snprintf(buf, sizeof(buf), "%" PRIu64, v);
    raw(buf);
  }
  void kstr(const char* k, const std::string& v) { key(k); str(v); }
  void knum(const char* k, uint64_t v) { key(k); num(v); }
  void kbool(const char* k, bool v) { key(k); raw(v ? "true" : "false"); }
  void khex(const char* k, uint32_t v) { key(k); raw("\"" + hex32(v) + "\""); }
  void knull(const char* k) { key(k); raw("null"); }
  // A UTF-16LE byte string as a JSON string (non-ASCII as \uXXXX, so the output stays ASCII).
  void kutf16le(const char* k, const Bytes& b) {
    key(k);
    std::string q = "\"";
    char buf[8];
    for (size_t i = 0; i + 1 < b.size(); i += 2) {
      uint32_t u = le16(&b[i]);
      if (u == '"' || u == '\\') {
        q += '\\';
        q += (char)u;
      } else if (u >= 0x20 && u < 0x7F) {
        q += (char)u;
      } else {
        snprintf(buf, sizeof(buf), "\\u%04X", (unsigned)u);
        q += buf;
      }
    }
    raw(q + "\"");
  }
  const std::string& text() const { return s_; }

 private:
  void comma() { if (!first_) s_ += ','; }
  std::string s_;
  bool first_ = true;
};

std::string tag_bytes(uint32_t tag) {
  std::string s(4, ' ');
  for (int i = 0; i < 4; ++i) s[i] = (char)(uint8_t)(tag >> (24 - 8 * i));
  return s;
}

// The members of one sfnt (a font, or a face of a collection). `standalone` adds the whole-file checks.
void sfnt_members(JW& j, const uint8_t* data, size_t len, size_t base, bool standalone) {
  Sfnt f = parse_sfnt(data, len, base, "input");
  j.kstr("flavor", outline_flavor(f));
  j.khex("sfntVersion", f.flavor);
  int glyphs = num_glyphs(data, f);
  if (glyphs < 0) j.knull("numGlyphs");
  else j.knum("numGlyphs", (uint64_t)glyphs);
  if (standalone) {
    LayoutReport lr = check_layout(data, len, f);
    j.kbool("canonicalLayout", lr.canonical);
    if (!lr.canonical) j.kstr("layoutNote", lr.reason);
    uint32_t stored = 0, expected = 0;
    if (checksum_adjustment(data, len, f, &stored, &expected)) {
      j.key("checkSumAdjustment");
      j.obj_begin();
      j.khex("stored", stored);
      j.khex("expected", expected);
      j.kbool("ok", stored == expected);
      j.obj_end();
    }
  }
  j.key("tables");
  j.arr_begin();
  for (const Table& t : f.tables) {
    uint32_t sum = table_checksum(data, t);
    j.obj_begin();
    j.kstr("tag", tag_bytes(t.tag));
    j.knum("offset", t.offset);
    j.knum("length", t.length);
    j.khex("checksum", sum);
    j.khex("recordedChecksum", t.checksum);
    j.kbool("checksumOk", sum == t.checksum);
    j.obj_end();
  }
  j.arr_end();
}

void info_sfnt(JW& j, const Bytes& in) {
  j.kstr("container", "sfnt");
  j.knum("size", in.size());
  sfnt_members(j, in.data(), in.size(), 0, true);
}

void info_collection(JW& j, const Bytes& in) {
  TtcHeader h = parse_ttc(in.data(), in.size(), "input");
  j.kstr("container", "collection");
  j.knum("size", in.size());
  j.khex("ttcVersion", h.version);
  j.knum("numFonts", h.offsets.size());
  j.key("fonts");
  j.arr_begin();
  for (uint32_t off : h.offsets) {
    j.obj_begin();
    j.knum("offset", off);
    sfnt_members(j, in.data(), in.size(), off, false);
    j.obj_end();
  }
  j.arr_end();
}

void info_woff(JW& j, const Bytes& in) {
  const WoffLayout L = woff1_layout(in);  // every check the decoder makes before it inflates anything
  std::vector<uint32_t> tags;
  for (const WoffEntry& e : L.entries) tags.push_back(e.tag);
  j.kstr("container", "woff");
  j.knum("size", in.size());
  j.kstr("flavor", outline_flavor(tags, L.flavor));
  j.khex("sfntVersion", L.flavor);
  j.knum("length", L.length);
  j.knum("numTables", L.entries.size());
  j.knum("totalSfntSize", L.totalSfntSize);
  j.knum("majorVersion", L.majorVersion);
  j.knum("minorVersion", L.minorVersion);
  j.knum("metaOffset", L.metaOffset);
  j.knum("metaLength", L.metaLength);
  j.knum("metaOrigLength", L.metaOrigLength);
  j.knum("privOffset", L.privOffset);
  j.knum("privLength", L.privLength);
  j.key("tables");
  j.arr_begin();
  for (const WoffEntry& e : L.entries) {
    j.obj_begin();
    j.kstr("tag", tag_bytes(e.tag));
    j.knum("offset", e.offset);
    j.knum("compLength", e.compLength);
    j.knum("origLength", e.origLength);
    j.khex("origChecksum", e.origChecksum);
    j.obj_end();
  }
  j.arr_end();
}

struct Reader {
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
  uint32_t u255() {
    uint8_t c = u8();
    if (c == 253) {
      uint32_t hi = u8();
      return (hi << 8) | u8();
    }
    if (c == 255) return 253u + u8();
    if (c == 254) return 506u + u8();
    return c;
  }
};

void info_woff2(JW& j, const Bytes& in) {
  woff2_check_header(in);  // the checks woff2-decode makes before the library sees the file
  const uint8_t* d = in.data();
  const uint32_t flavor = be32(d + 4);
  const uint32_t n = be16(d + 12);
  size_t dir_end = 0;
  std::vector<uint32_t> tags;
  JW t;
  t.arr_begin();
  for (const Woff2Table& w : woff2_tables(in, &dir_end)) {
    tags.push_back(w.tag);
    t.obj_begin();
    t.kstr("tag", tag_bytes(w.tag));
    t.knum("origLength", w.orig_length);
    t.kbool("transformed", w.transformed);
    if (w.transformed) t.knum("transformLength", w.transform_length);
    t.obj_end();
  }
  t.arr_end();
  j.kstr("container", "woff2");
  j.knum("size", in.size());
  j.kstr("flavor", flavor == kFlavorCollection ? std::string("collection") : outline_flavor(tags, flavor));
  j.khex("sfntVersion", flavor);
  j.knum("length", be32(d + 8));
  j.knum("numTables", n);
  j.knum("totalSfntSize", be32(d + 16));
  j.knum("totalCompressedSize", be32(d + 20));
  j.knum("majorVersion", be16(d + 24));
  j.knum("minorVersion", be16(d + 26));
  j.knum("metaOffset", be32(d + 28));
  j.knum("metaLength", be32(d + 32));
  j.knum("metaOrigLength", be32(d + 36));
  j.knum("privOffset", be32(d + 40));
  j.knum("privLength", be32(d + 44));
  j.key("tables");
  j.raw(t.text());
  if (flavor == kFlavorCollection) {
    Reader r = {d, in.size(), dir_end};
    j.khex("ttcVersion", r.u32());
    j.knum("numFonts", r.u255());
  }
}

void info_eot(JW& j, const Bytes& in) {
  EotHeader h;
  parse_eot_header(in.data(), in.size(), &h);
  j.kstr("container", "eot");
  j.knum("size", in.size());
  j.khex("version", h.version);
  j.khex("flags", h.flags);
  j.kstr("compression", eot_compression(h.flags));
  j.kbool("subset", (h.flags & kEotFlagSubset) != 0);
  j.knum("eotSize", h.eotSize);
  j.knum("fontDataSize", h.fontDataSize);
  j.knum("fontDataOffset", h.fontDataOffset);
  j.key("panose");
  j.arr_begin();
  for (int i = 0; i < 10; ++i) j.num(h.panose[i]);
  j.arr_end();
  j.knum("charset", h.charset);
  j.knum("italic", h.italic);
  j.knum("weight", h.weight);
  j.knum("fsType", h.fsType);
  j.key("unicodeRange");
  j.arr_begin();
  for (int i = 0; i < 4; ++i) j.raw("\"" + hex32(h.unicodeRange[i]) + "\"");
  j.arr_end();
  j.key("codePageRange");
  j.arr_begin();
  for (int i = 0; i < 2; ++i) j.raw("\"" + hex32(h.codePageRange[i]) + "\"");
  j.arr_end();
  j.khex("checkSumAdjustment", h.checkSumAdjustment);
  j.kutf16le("familyName", h.familyName);
  j.kutf16le("styleName", h.styleName);
  j.kutf16le("versionName", h.versionName);
  j.kutf16le("fullName", h.fullName);
  j.kutf16le("rootString", h.rootString);
  if (h.version == kEotVersion22) {
    j.khex("rootStringCheckSum", h.rootStringCheckSum);
    j.knum("eudcFontSize", h.eudcFontSize);
  }
  // The embedded font's directory, when it can be read without decompressing (plain and XOR files).
  if (h.flags & kEotFlagCompressed) {
    j.knull("font");
    return;
  }
  Bytes font(in.begin() + (ptrdiff_t)h.fontDataOffset, in.begin() + (ptrdiff_t)(h.fontDataOffset + h.fontDataSize));
  if (h.flags & kEotFlagXor) {
    for (uint8_t& b : font) b ^= 0x50;
  }
  JW inner;
  try {
    inner.obj_begin();
    sfnt_members(inner, font.data(), font.size(), 0, true);
    inner.obj_end();
  } catch (const Error& e) {
    fail(Err::EotInvalid, "the font inside the EOT is damaged: %s", e.what());  // eot-decode refuses it too
  }
  j.key("font");
  j.raw(inner.text());
}

}  // namespace

Container detect_container(const Bytes& in) {
  if (in.size() >= 4) {
    uint32_t sig = be32(in.data());
    if (sig == WOFF_SIGNATURE) return kWoff;
    if (sig == WOFF2_SIGNATURE) return kWoff2;
    if (sig == kFlavorCollection) return kCollection;
    if (is_sfnt_flavor(sig)) return kSfnt;
  }
  if (looks_like_eot(in.data(), in.size())) return kEot;
  return kUnknown;
}

std::string info_json(const Bytes& in) {
  JW j;
  j.obj_begin();
  j.kbool("ok", true);
  j.kstr("command", "info");
  switch (detect_container(in)) {
    case kSfnt: info_sfnt(j, in); break;
    case kCollection: info_collection(j, in); break;
    case kWoff: info_woff(j, in); break;
    case kWoff2: info_woff2(j, in); break;
    case kEot: info_eot(j, in); break;
    default: fail(Err::NotAFont, "unrecognised file: not an sfnt (TTF/OTF), font collection, WOFF, WOFF2 or EOT");
  }
  j.obj_end();
  return j.text();
}

}  // namespace fw
