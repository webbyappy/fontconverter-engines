// common.h -- shared helpers for fontwrap: byte order, errors, limits, JSON quoting.
//
// fontwrap has NO mutable global state: callMain() runs many times on one module instance.
#ifndef FONTWRAP_COMMON_H_
#define FONTWRAP_COMMON_H_

#include <cstdarg>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <stdexcept>
#include <string>
#include <vector>

namespace fw {

typedef std::vector<uint8_t> Bytes;

// fontconverter-web P3b (P3b plan, P3b-7): every failure carries one id from this fixed list; main() prints it in a
// JSON line on stdout ({"ok":false,"v":1,"command":...,"error":"<id>"}), `fontwrap error-ids` lists them all. The
// human message stays on stderr (it may hold bytes from the font) and never becomes an id.
enum class Err {
  Io, InputEmpty, InputTooLarge, OutputLimit, Internal, Corrupt, NotAFont, SfntInvalid, CollectionInvalid,
  CollectionNotAllowed, EotInvalid, EotMtxFailed, EotNameTooLong, CffNotAllowed, Type1NotAllowed, Checksum,
  MissingTable, WoffInvalid, Woff2Invalid, Woff2Unaligned, Woff2EncoderRejected, Woff2DecodeFailed, ZlibFailed,
  LayoutNotCanonical, OutOfMemory, Usage, Unexpected,
};
inline const char* err_id(Err e) {
  static const char* const kIds[] = {
      "io", "input-empty", "input-too-large", "output-limit", "internal", "corrupt", "not-a-font", "sfnt-invalid",
      "collection-invalid", "collection-not-allowed", "eot-invalid", "eot-mtx-failed", "eot-name-too-long",
      "cff-not-allowed", "type1-not-allowed", "checksum", "missing-table", "woff-invalid", "woff2-invalid",
      "woff2-unaligned", "woff2-encoder-rejected", "woff2-decode-failed", "zlib-failed", "layout-not-canonical",
      "out-of-memory", "usage", "unexpected",
  };
  return kIds[static_cast<int>(e)];
}
const int kErrCount = static_cast<int>(Err::Unexpected) + 1;

// A conversion or input error: "fontwrap: error: <msg>" on stderr, exit code 1.
struct Error : std::runtime_error {
  Error(Err i, const std::string& m) : std::runtime_error(m), id(i) {}
  Err id;
};

// A command-line error: "fontwrap: usage error: <msg>" and the usage text on stderr, exit code 2.
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

// Diagnostics that do not change the exit code; on stderr so stdout stays machine-readable.
inline void note(const char* fmt, ...) __attribute__((format(printf, 1, 2)));
inline void note(const char* fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  std::string m = vformat(fmt, ap);
  va_end(ap);
  fprintf(stderr, "fontwrap: note: %s\n", m.c_str());
}
inline void warn(const char* fmt, ...) __attribute__((format(printf, 1, 2)));
inline void warn(const char* fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  std::string m = vformat(fmt, ap);
  va_end(ap);
  fprintf(stderr, "fontwrap: warning: %s\n", m.c_str());
}

// Hard caps, checked before any allocation sized by untrusted input (P1 plan, P1-6).
const uint64_t MAX_INPUT_BYTES = 512ull * 1024 * 1024;   // bytes: the largest file read
const uint64_t MAX_OUTPUT_BYTES = 512ull * 1024 * 1024;  // bytes: the largest font written
const uint32_t MAX_TABLES = 4096;                        // tables per font
const uint64_t WOFF_MAX_INFLATE_RATIO = 1032;            // zlib cannot inflate by more than about 1,032:1
const uint64_t WOFF_INFLATE_SLACK_BYTES = 4096;          // bytes allowed above that ratio for tiny tables

inline uint16_t be16(const uint8_t* p) { return (uint16_t)((p[0] << 8) | p[1]); }
inline uint32_t be32(const uint8_t* p) {
  return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | (uint32_t)p[3];
}
inline uint16_t le16(const uint8_t* p) { return (uint16_t)(p[0] | (p[1] << 8)); }
inline uint32_t le32(const uint8_t* p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}
inline void set_be16(uint8_t* p, uint16_t v) {
  p[0] = (uint8_t)(v >> 8);
  p[1] = (uint8_t)v;
}
inline void set_be32(uint8_t* p, uint32_t v) {
  p[0] = (uint8_t)(v >> 24);
  p[1] = (uint8_t)(v >> 16);
  p[2] = (uint8_t)(v >> 8);
  p[3] = (uint8_t)v;
}
inline void put_be16(Bytes& b, uint16_t v) {
  b.push_back((uint8_t)(v >> 8));
  b.push_back((uint8_t)v);
}
inline void put_be32(Bytes& b, uint32_t v) {
  b.push_back((uint8_t)(v >> 24));
  b.push_back((uint8_t)(v >> 16));
  b.push_back((uint8_t)(v >> 8));
  b.push_back((uint8_t)v);
}
inline void put_le16(Bytes& b, uint16_t v) {
  b.push_back((uint8_t)v);
  b.push_back((uint8_t)(v >> 8));
}
inline void put_le32(Bytes& b, uint32_t v) {
  b.push_back((uint8_t)v);
  b.push_back((uint8_t)(v >> 8));
  b.push_back((uint8_t)(v >> 16));
  b.push_back((uint8_t)(v >> 24));
}
inline uint64_t round4(uint64_t v) { return (v + 3) & ~(uint64_t)3; }

#define FW_TAG(a, b, c, d) \
  (((uint32_t)(a) << 24) | ((uint32_t)(b) << 16) | ((uint32_t)(c) << 8) | (uint32_t)(d))

// A tag as printable text for messages: non-printable bytes become '?'.
inline std::string tag_str(uint32_t tag) {
  std::string s(4, '?');
  for (int i = 0; i < 4; ++i) {
    uint8_t c = (uint8_t)(tag >> (24 - 8 * i));
    if (c >= 0x20 && c <= 0x7e) s[i] = (char)c;
  }
  return s;
}

// "0x0001ABCD": the form font-oracle.json and every JSON field of fontwrap use for 32-bit values.
inline std::string hex32(uint32_t v) {
  char buf[16];
  snprintf(buf, sizeof(buf), "0x%08X", v);
  return buf;
}

// A JSON string literal, ASCII only (anything else is \uXXXX-escaped from its UTF-8).
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

}  // namespace fw

#endif  // FONTWRAP_COMMON_H_
