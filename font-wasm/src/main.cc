// main.cc -- fontwrap: lossless font container conversions as one command line (P1 plan, P1-1 and P1-2).
//
// Contract (fail closed):
//   exit 0  success; exactly one JSON line on stdout; the output file is complete
//   exit 1  bad input or a failed conversion; one "fontwrap: error: ..." line on stderr; no output file exists
//   exit 2  usage error; "fontwrap: usage error: ..." and the usage on stderr; no file is touched
// On exit 1 and 2 the only stdout line is {"ok":false,"v":1,"command":<command or null>,"error":"<id>"}, the id from
// `fontwrap error-ids` (fontconverter-web P3b plan, P3b-7); the message on stderr never becomes an id.
// The whole conversion happens in memory. A stale file at the output path is removed after the usage checks and
// before the input is read; the output is created only after the conversion succeeded.
//
// No global state and no getopt: main() runs any number of times on one module instance.
#include <zlib.h>

#include <sys/stat.h>

#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <new>
#include <string>
#include <vector>

#include "common.h"
#include "eot.h"
#include "info.h"
#include "sfnt.h"
#include "version.h"
#include "woff1.h"
#include "woff2_wrap.h"

extern "C" int fontwrap_selftest_assert(void);

namespace {

using namespace fw;

const char USAGE[] =
    "usage: fontwrap <command> [options] <input> [<output>]\n"
    "  info          <in>          describe the file as one JSON line\n"
    "  woff-encode   <in> <out>    sfnt -> WOFF 1.0                    [--strict]\n"
    "  woff-decode   <in> <out>    WOFF 1.0 -> sfnt                    [--strict]\n"
    "  woff2-encode  <in> <out>    sfnt or collection -> WOFF 2.0      [--quality=0..11]\n"
    "  woff2-decode  <in> <out>    WOFF 2.0 -> sfnt or collection\n"
    "  eot-encode    <in> <out>    TrueType sfnt -> EOT 0x00020002     [--allow-cff] [--strict]\n"
    "  eot-decode    <in> <out>    EOT (plain, XOR or MTX) -> sfnt     [--strict]\n"
    "  version | help | error-ids\n"
    "  --max-output-bytes=N (decoders) refuses a font that would decode to more than N bytes, before\n"
    "  allocating it where the header says its size (error output-limit).\n"
    "  --strict refuses a font that is not well-formed (a wrong table checksum; for woff-encode also a\n"
    "  non-canonical table layout) instead of warning.\n";

struct Args {
  std::string command;
  std::vector<std::string> paths;
  std::vector<std::string> options;
  int quality = 11;
  bool strict = false;
  bool allow_cff = false;
  uint64_t max_out = MAX_OUTPUT_BYTES;  // bytes: --max-output-bytes, at most MAX_OUTPUT_BYTES
};

struct Result {
  Bytes out;
  std::string flavor;  // of the font inside
  std::string ext;     // the extension the output needs
  std::string extra;   // further JSON members, each starting with ','
};

bool starts_with(const std::string& s, const char* prefix) { return s.compare(0, strlen(prefix), prefix) == 0; }

uint64_t parse_bytes(const std::string& opt, const std::string& value) {
  char* end = nullptr;
  errno = 0;
  unsigned long long v = strtoull(value.c_str(), &end, 10);
  if (value.empty() || value[0] == '-' || *end != '\0' || errno != 0 || v == 0 || v > MAX_OUTPUT_BYTES) {
    throw UsageError(opt + " needs a whole number of bytes from 1 to " + std::to_string(MAX_OUTPUT_BYTES));
  }
  return (uint64_t)v;
}

int parse_int(const std::string& opt, const std::string& value, int lo, int hi) {
  char* end = nullptr;
  errno = 0;
  long v = strtol(value.c_str(), &end, 10);
  if (value.empty() || *end != '\0' || errno != 0 || v < lo || v > hi) {
    throw UsageError(opt + " needs a whole number from " + std::to_string(lo) + " to " + std::to_string(hi));
  }
  return (int)v;
}

Args parse_args(int argc, char** argv) {
  Args a;
  if (argc < 2) throw UsageError("no command given");
  a.command = argv[1];
  bool options_done = false;
  for (int i = 2; i < argc; ++i) {
    std::string s = argv[i];
    if (!options_done && s == "--") {
      options_done = true;
    } else if (!options_done && starts_with(s, "--")) {
      if (starts_with(s, "--quality=")) {
        a.quality = parse_int("--quality", s.substr(10), 0, 11);
        a.options.push_back("--quality");
      } else if (s == "--strict") {
        a.strict = true;
        a.options.push_back(s);
      } else if (s == "--allow-cff") {
        a.allow_cff = true;
        a.options.push_back(s);
      } else if (starts_with(s, "--max-output-bytes=")) {
        a.max_out = parse_bytes("--max-output-bytes", s.substr(19));
        a.options.push_back("--max-output-bytes");
      } else {
        throw UsageError("unknown option " + s);
      }
    } else {
      a.paths.push_back(s);
    }
  }
  return a;
}

// Each command accepts only its own options.
void check_options(const Args& a, const std::vector<std::string>& allowed) {
  for (const std::string& o : a.options) {
    bool ok = false;
    for (const std::string& x : allowed) ok = ok || o == x;
    if (!ok) throw UsageError(o + " does not apply to " + a.command);
  }
}

void read_file(const std::string& path, Bytes* out) {
  FILE* f = fopen(path.c_str(), "rb");
  if (!f) fail(Err::Io, "cannot open input '%s': %s", path.c_str(), strerror(errno));
  struct Closer {
    FILE* f;
    ~Closer() { fclose(f); }
  } closer = {f};
  if (fseeko(f, 0, SEEK_END) != 0) fail(Err::Io, "cannot read input '%s': %s", path.c_str(), strerror(errno));
  off_t size = ftello(f);
  if (size < 0) fail(Err::Io, "cannot read input '%s': %s", path.c_str(), strerror(errno));
  if (size == 0) fail(Err::InputEmpty, "input '%s' is empty (0 bytes)", path.c_str());
  if ((uint64_t)size > MAX_INPUT_BYTES) {
    fail(Err::InputTooLarge, "input '%s' is %lld bytes; the limit is %llu MiB", path.c_str(), (long long)size,
         (unsigned long long)(MAX_INPUT_BYTES >> 20));
  }
  if (fseeko(f, 0, SEEK_SET) != 0) fail(Err::Io, "cannot read input '%s': %s", path.c_str(), strerror(errno));
  out->resize((size_t)size);
  size_t got = fread(out->data(), 1, out->size(), f);
  if (got != out->size()) fail(Err::Io, "short read on input '%s' (%zu of %zu bytes)", path.c_str(), got, out->size());
}

void write_file(const std::string& path, const Bytes& data) {
  FILE* f = fopen(path.c_str(), "wb");
  if (!f) fail(Err::Io, "cannot create output '%s': %s", path.c_str(), strerror(errno));
  size_t put = data.empty() ? 0 : fwrite(data.data(), 1, data.size(), f);
  int close_rc = fclose(f);
  if (put != data.size() || close_rc != 0) {
    remove(path.c_str());  // never leave a partial output behind
    fail(Err::Io, "could not write output '%s' (%zu of %zu bytes)", path.c_str(), put, data.size());
  }
}

// The conversion commands this build implements (each is also a branch of convert()).
const std::vector<std::string> CONVERTERS = {"woff-encode", "woff-decode", "woff2-encode", "woff2-decode",
                                              "eot-encode", "eot-decode"};

std::vector<std::string> allowed_options(const std::string& cmd) {
  if (cmd == "woff-decode" || cmd == "eot-decode") return {"--strict", "--max-output-bytes"};
  if (cmd == "woff-encode") return {"--strict"};
  if (cmd == "woff2-decode") return {"--max-output-bytes"};
  if (cmd == "woff2-encode") return {"--quality"};
  if (cmd == "eot-encode") return {"--allow-cff", "--strict"};
  return {};
}

bool is_converter(const std::string& cmd) {
  for (const std::string& c : CONVERTERS) {
    if (c == cmd) return true;
  }
  return false;
}

// The same file under two spellings ("a.ttf" and "./a.ttf", a hard link): removing the stale output would delete the
// input (review after P1, finding 1).
bool same_file(const std::string& a, const std::string& b) {
  struct stat sa;
  struct stat sb;
  return stat(a.c_str(), &sa) == 0 && stat(b.c_str(), &sb) == 0 && sa.st_dev == sb.st_dev && sa.st_ino == sb.st_ino;
}

// The outline flavour by the tables, as info and font-oracle.json name it ("collection" for a TTC or OTC), and the
// extension a decoded font needs.
std::string font_flavor(const Bytes& font) {
  if (font.size() >= 4 && be32(font.data()) == kFlavorCollection) return "collection";
  return outline_flavor(parse_sfnt(font.data(), font.size(), 0, "font"));
}

std::string font_ext(const std::string& flavor) {
  if (flavor == "collection") return "ttc";
  return flavor == "cff" || flavor == "cff2" ? "otf" : "ttf";
}

void convert(const Args& a, const Bytes& in, Result* r) {
  uint32_t flavor = 0;
  if (a.command == "woff-encode") {
    woff1_encode(in, a.strict, &r->out, &flavor);
    r->ext = "woff";
  } else if (a.command == "woff-decode") {
    woff1_decode(in, a.strict, a.max_out, &r->out, &flavor);
  } else if (a.command == "woff2-encode") {
    woff2_encode(in, a.quality, &r->out, &flavor);
    r->ext = "woff2";
    r->extra = ",\"quality\":" + std::to_string(a.quality);
  } else if (a.command == "woff2-decode") {
    woff2_decode(in, a.max_out, &r->out, &flavor);
  } else if (a.command == "eot-encode") {
    eot_encode(in, a.allow_cff, a.strict, &r->out, &flavor);
    r->ext = "eot";
  } else if (a.command == "eot-decode") {
    EotDecodeReport rep;
    eot_decode(in, a.strict, a.max_out, &r->out, &flavor, &rep);
    r->extra = ",\"compression\":" + json_quote(rep.compression) + ",\"decoder\":" + json_quote(rep.decoder);
  } else {
    fail(Err::Internal, "internal error: no converter for '%s'", a.command.c_str());
  }
  // Encoders name the input's outlines, decoders the font they wrote; the tables decide, not the sfnt version.
  const bool decoder = a.command.size() > 7 && a.command.compare(a.command.size() - 7, 7, "-decode") == 0;
  r->flavor = font_flavor(decoder ? r->out : in);
  if (decoder) r->ext = font_ext(r->flavor);
}

// Commands the failure line names; any other first argument is reported as null (never echoed).
bool is_command(const std::string& cmd) {
  return is_converter(cmd) || cmd == "info" || cmd == "version" || cmd == "help" || cmd == "error-ids" ||
         cmd == "selftest-oom";
}

// Test hook (wasm): allocate 1 MiB blocks until the module's memory ceiling; linked with ABORTING_MALLOC=1 the
// runtime aborts with its out-of-memory message, which post.js records for lastAbort(). Native builds have no
// ceiling, so the hook refuses there instead of exhausting the host.
int selftest_oom() {
#ifdef __EMSCRIPTEN__
  std::vector<void*> blocks;
  for (;;) {
    void* p = malloc(1u << 20);
    if (!p) fail(Err::OutOfMemory, "selftest-oom: malloc returned NULL (ABORTING_MALLOC is off)");
    memset(p, 1, 1u << 20);
    blocks.push_back(p);
  }
#else
  throw UsageError("selftest-oom applies to the wasm build only");
#endif
}

int run(int argc, char** argv, std::string* command) {
  Args a = parse_args(argc, argv);
  const std::string& cmd = a.command;
  if (is_command(cmd)) *command = cmd;
  if (cmd == "version") {
    check_options(a, {});
    printf("{\"ok\":true,\"command\":\"version\",\"fontwrap\":\"%s\",\"brotli\":\"%s\",\"woff2\":\"%s\","
           "\"libeot\":\"%s\",\"zlib\":\"%s\"}\n",
           FONTWRAP_VERSION, FONTWRAP_BROTLI_PIN, FONTWRAP_WOFF2_PIN, FONTWRAP_LIBEOT_PIN, ZLIB_VERSION);
    return 0;
  }
  if (cmd == "help") {
    fputs(USAGE, stdout);
    return 0;
  }
  if (cmd == "error-ids") {
    check_options(a, {});
    std::string ids;
    for (int i = 0; i < kErrCount; ++i) ids += std::string(i ? "," : "") + json_quote(err_id(static_cast<Err>(i)));
    printf("{\"ok\":true,\"v\":1,\"command\":\"error-ids\",\"ids\":[%s]}\n", ids.c_str());
    return 0;
  }
  if (cmd == "selftest-oom") {
    check_options(a, {});
    return selftest_oom();
  }
  if (cmd == "selftest-assert") {  // test hook: a C assert() below a setjmp frame (selftest_assert.c)
    int rc = fontwrap_selftest_assert();
    printf("selftest-assert returned %d: the assert did not fire\n", rc);
    return 3;
  }
  if (cmd == "info") {
    check_options(a, {});
    if (a.paths.size() != 1) throw UsageError("info takes exactly one file");
    Bytes in;
    read_file(a.paths[0], &in);
    printf("%s\n", info_json(in).c_str());
    return 0;
  }
  if (!is_converter(cmd)) throw UsageError("unknown command '" + cmd + "'");
  check_options(a, allowed_options(cmd));
  if (a.paths.size() != 2) throw UsageError(cmd + " takes an input file and an output file");
  const std::string& in_path = a.paths[0];
  const std::string& out_path = a.paths[1];
  if (in_path == out_path || same_file(in_path, out_path)) {
    throw UsageError("input and output must be different files");  // before anything is removed
  }

  remove(out_path.c_str());  // a failed run must leave no output, not even an earlier run's

  Bytes in;
  read_file(in_path, &in);
  Result r;
  convert(a, in, &r);
  if (r.out.empty()) fail(Err::Internal, "internal error: the conversion produced no data");
  if (r.out.size() > a.max_out) fail(Err::OutputLimit, "the result is %zu bytes, over the %llu-byte output limit",
                                      r.out.size(), (unsigned long long)a.max_out);
  write_file(out_path, r.out);
  printf("{\"ok\":true,\"command\":%s,\"flavor\":%s,\"ext\":%s,\"inSize\":%zu,\"outSize\":%zu%s}\n",
         json_quote(cmd).c_str(), json_quote(r.flavor).c_str(), json_quote(r.ext).c_str(), in.size(), r.out.size(),
         r.extra.c_str());
  return 0;
}

[[noreturn]] void assertion_failed(const char* expr, const char* file, int line) {
  const char* base = strrchr(file, '/');
  fail(Err::Corrupt, "corrupt input: a consistency check failed in the decoder (%s, %s:%d)", expr, base ? base + 1 : file, line);
}

}  // namespace

// libeot's LZCOMP/Huffman code guards its invariants with assert(). The stock handler aborts, which in wasm kills
// the module instance. Here a failed assert throws instead: main() reports "fontwrap: error: ..." and returns 1,
// nothing is written, and the instance stays usable. musl (wasm) calls __assert_fail; macOS (the native build)
// calls __assert_rtn (P1 plan, P1-14).
extern "C" [[noreturn]] void __assert_fail(const char* expr, const char* file, int line, const char* func) {
  (void)func;
  assertion_failed(expr, file, line);
}
#ifdef __APPLE__
extern "C" [[noreturn]] void __assert_rtn(const char* func, const char* file, int line, const char* expr) {
  (void)func;
  assertion_failed(expr, file, line);
}
#endif

int main(int argc, char** argv) {
  // Test hook: an unterminated stderr line, then an exception that escapes main() (for post.js and N11).
  if (argc == 2 && strcmp(argv[1], "selftest-throw") == 0) {
    fputs("fontwrap: selftest: unterminated", stderr);
    throw std::runtime_error("fontwrap selftest exception");
  }
  int rc;
  std::string command;
  fw::Err id = fw::Err::Unexpected;
  try {
    rc = run(argc, argv, &command);
  } catch (const fw::UsageError& e) {
    fprintf(stderr, "fontwrap: usage error: %s\n%s", e.what(), USAGE);
    rc = 2;
    id = fw::Err::Usage;
  } catch (const fw::Error& e) {
    fprintf(stderr, "fontwrap: error: %s\n", e.what());
    rc = 1;
    id = e.id;
  } catch (const std::bad_alloc&) {
    fprintf(stderr, "fontwrap: error: out of memory\n");
    rc = 1;
    id = fw::Err::OutOfMemory;
  } catch (const std::exception& e) {
    fprintf(stderr, "fontwrap: error: unexpected failure: %s\n", e.what());
    rc = 1;
  }
  if (rc == 1 || rc == 2) {
    printf("{\"ok\":false,\"v\":1,\"command\":%s,\"error\":\"%s\"}\n",
           command.empty() ? "null" : fw::json_quote(command).c_str(), fw::err_id(id));
  }
  fflush(stdout);
  fflush(stderr);
  return rc;
}
