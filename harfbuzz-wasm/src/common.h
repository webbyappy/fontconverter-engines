// common.h -- shared helpers for hbfont: errors and their ids, limits, files, JSON quoting.
// (fontconverter-web docs/audits/P3b-VARIABLE-COLOUR-PLAN-2026-11-18.md, section 3.1)
//
// hbfont runs one command per module instance in the app (a disposable worker per step, P3b-1), but nothing here
// depends on that: main() keeps no state between runs.
#ifndef HBFONT_COMMON_H_
#define HBFONT_COMMON_H_

#include <cstdarg>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <stdexcept>
#include <string>
#include <vector>

namespace hbf {

typedef std::vector<uint8_t> Bytes;

// P3b-7: every failure carries one id from this fixed list; main() prints it in a JSON line on stdout
// ({"ok":false,"v":1,"command":...,"error":"<id>"}) and `hbfont error-ids` lists them all. The human message stays
// on stderr (it may hold text from the font) and never becomes an id.
enum class Err {
  Io, InputEmpty, InputTooLarge, NotAFont, Collection, SfntInvalid, NotVariable, AxisUnknown, AxisMissing,
  AxisOutOfRange, NamedMismatch, InstanceFailed, CffInvalid, CffLayoutUnsupported, NoColour, GlyphMapInvalid,
  GlyphMapMismatch, ColourGlyphUnmapped, SvgInvalid, SvgUnsupportedReference, TransplantFailed, OutputInvalid,
  Internal, OutOfMemory, Usage, Unexpected,
};
inline const char* err_id(Err e) {
  static const char* const kIds[] = {
      "io", "input-empty", "input-too-large", "not-a-font", "collection", "sfnt-invalid", "not-variable",
      "axis-unknown", "axis-missing", "axis-out-of-range", "named-mismatch", "instance-failed", "cff-invalid",
      "cff-layout-unsupported", "no-colour", "glyph-map-invalid", "glyph-map-mismatch", "colour-glyph-unmapped",
      "svg-invalid", "svg-unsupported-reference", "transplant-failed", "output-invalid", "internal", "out-of-memory",
      "usage", "unexpected",
  };
  return kIds[static_cast<int>(e)];
}
const int kErrCount = static_cast<int>(Err::Unexpected) + 1;

// A conversion or input error: "hbfont: error: <msg>" on stderr, exit code 1.
struct Error : std::runtime_error {
  Error(Err i, const std::string& m) : std::runtime_error(m), id(i) {}
  Err id;
};

// A command-line error: "hbfont: usage error: <msg>" and the usage text on stderr, exit code 2.
struct UsageError : std::runtime_error {
  explicit UsageError(const std::string& m) : std::runtime_error(m) {}
};

inline std::string vformat(const char* fmt, va_list ap) {
  char buf[512];
  vsnprintf(buf, sizeof(buf), fmt, ap);
  return std::string(buf);
}

[[noreturn]] inline void fail(Err id, const char* fmt, ...) __attribute__((format(printf, 2, 3)));
[[noreturn]] inline void fail(Err id, const char* fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  std::string m = vformat(fmt, ap);
  va_end(ap);
  throw Error(id, m);
}

// Hard caps, checked before any allocation sized by untrusted input.
const uint64_t MAX_INPUT_BYTES = 64ull * 1024 * 1024;  // bytes: twice the app's 32 MiB try-anyway limit for hbfont

inline uint64_t round4(uint64_t v) { return (v + 3) & ~(uint64_t)3; }

inline uint16_t be16(const uint8_t* p) { return (uint16_t)((p[0] << 8) | p[1]); }
inline uint32_t be32(const uint8_t* p) {
  return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | (uint32_t)p[3];
}

// A JSON string literal, ASCII only (anything else is \uXXXX-escaped from its UTF-8; a malformed sequence is U+FFFD).
inline std::string json_quote(const std::string& s) {
  std::string o = "\"";
  for (size_t i = 0; i < s.size();) {
    unsigned char c = (unsigned char)s[i];
    uint32_t cp = c;
    size_t n = 1;
    if (c >= 0x80) {
      int extra = (c >= 0xf0) ? 3 : (c >= 0xe0) ? 2 : (c >= 0xc0) ? 1 : 0;
      cp = extra ? (c & (0x3f >> extra)) : 0xfffd;
      for (int k = 1; k <= extra && i + k < s.size(); ++k) cp = (cp << 6) | ((unsigned char)s[i + k] & 0x3f);
      n = 1 + extra;
    }
    char buf[16];
    if (cp == '"' || cp == '\\') {
      o += '\\';
      o += (char)cp;
    } else if (cp >= 0x20 && cp < 0x7f) {
      o += (char)cp;
    } else if (cp > 0xffff) {
      cp -= 0x10000;
      snprintf(buf, sizeof(buf), "\\u%04x\\u%04x", 0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
      o += buf;
    } else {
      snprintf(buf, sizeof(buf), "\\u%04x", cp);
      o += buf;
    }
    i += n;
  }
  return o + "\"";
}

}  // namespace hbf

#endif  // HBFONT_COMMON_H_
