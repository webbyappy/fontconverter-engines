// main.cc -- hbfont: HarfBuzz 15's instancer and subsetter as one command line (fontconverter-web P3b plan,
// docs/audits/P3b-VARIABLE-COLOUR-PLAN-2026-11-18.md, section 3.1).
//
// Contract (fail closed), as fontwrap's:
//   exit 0  success; exactly one JSON line on stdout; the output file is complete
//   exit 1  bad input or a failed step; one "hbfont: error: ..." line on stderr; no output file exists
//   exit 2  usage error; "hbfont: usage error: ..." and the usage on stderr; no file is touched
// On exit 1 and 2 the only stdout line is {"ok":false,"v":1,"command":<command or null>,"error":"<id>"}, the id from
// `hbfont error-ids` (P3b-7); the message on stderr never becomes an id.
#include <hb-subset.h>
#include <hb.h>
#include <zlib.h>

#include <sys/stat.h>

#include <cerrno>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <new>
#include <string>
#include <vector>

#include "cff.h"
#include "cff_name.h"
#include "cff_namekey.h"
#include "cff_std_strings.h"
#include "common.h"
#include "info.h"
#include "instance.h"
#include "instance_names.h"
#include "sfnt.h"
#include "sfnt_edit.h"
#include "transplant.h"
#include "version.h"

static_assert(HB_VERSION_MAJOR == 15 && HB_VERSION_MINOR == 0 && HB_VERSION_MICRO == 0,
              "hbfont is pinned to HarfBuzz 15.0.0 (vendor/fetch-vendor.sh)");

namespace {

using namespace hbf;

const char USAGE[] =
    "usage: hbfont <command> [options] ...\n"
    "  info       <in>          axes, named instances, STAT, colour tables (one JSON line)\n"
    "  instance   --at TAG=V,... [--named N] [--downgrade-cff2] <in> <out>\n"
    "                           a static font at that location, named for it\n"
    "  transplant <colour-source> <outline-font> <glyph-map> <out>\n"
    "                           the source's colour tables put back into FontForge's output by ffconv's glyph map\n"
    "  version | help | error-ids\n"
    "  --at pins every axis of the font (the caller completes and clamps); --named N asserts that the location is\n"
    "  named instance N; --downgrade-cff2 writes CFF for a CFF2 font.\n";

struct Args {
  std::string command;
  std::vector<std::string> paths;
  std::vector<std::string> options;
  std::string at;
  long named = -1;
  bool downgrade = false;
};

bool starts_with(const std::string& s, const char* prefix) { return s.compare(0, strlen(prefix), prefix) == 0; }

Args parse_args(int argc, char** argv) {
  Args a;
  if (argc < 2) throw UsageError("no command given");
  a.command = argv[1];
  bool options_done = false;
  for (int i = 2; i < argc; ++i) {
    std::string s = argv[i];
    if (!options_done && s == "--") {
      options_done = true;
    } else if (!options_done && s == "--at") {
      if (i + 1 >= argc) throw UsageError("--at needs TAG=VALUE,...");
      a.at = argv[++i];
      a.options.push_back(s);
    } else if (!options_done && s == "--named") {
      if (i + 1 >= argc) throw UsageError("--named needs an index");
      char* end = nullptr;
      errno = 0;
      long v = strtol(argv[++i], &end, 10);
      if (*argv[i] == '\0' || *end != '\0' || errno != 0 || v < 0 || v > 65535) throw UsageError("--named takes 0 to 65535");
      a.named = v;
      a.options.push_back(s);
    } else if (!options_done && s == "--downgrade-cff2") {
      a.downgrade = true;
      a.options.push_back(s);
    } else if (!options_done && starts_with(s, "--")) {
      throw UsageError("unknown option " + s);
    } else {
      a.paths.push_back(s);
    }
  }
  return a;
}

// Commands the failure line names; any other first argument is reported as null (never echoed).
bool is_command(const std::string& cmd) {
  return cmd == "info" || cmd == "instance" || cmd == "transplant" || cmd == "version" || cmd == "help" || cmd == "error-ids" ||
         cmd == "selftest-oom" || cmd == "selftest-cff-name" || cmd == "selftest-hb-rewrite" ||
         cmd == "selftest-cff-stack" || cmd == "selftest-cff-namekey" || cmd == "selftest-cff-strings";
}


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
  if (fread(out->data(), 1, out->size(), f) != out->size()) fail(Err::Io, "short read on input '%s'", path.c_str());
}

void write_file(const std::string& path, const Bytes& data) {
  FILE* f = fopen(path.c_str(), "wb");
  if (!f) fail(Err::Io, "cannot create output '%s': %s", path.c_str(), strerror(errno));
  size_t put = data.empty() ? 0 : fwrite(data.data(), 1, data.size(), f);
  int close_rc = fclose(f);
  if (put != data.size() || close_rc != 0) {
    remove(path.c_str());  // never leave a partial output behind
    fail(Err::Io, "could not write output '%s'", path.c_str());
  }
}

// The same file under two spellings: removing the stale output would delete an input.
bool same_file(const std::string& a, const std::string& b) {
  struct stat sa;
  struct stat sb;
  return a == b ||
         (stat(a.c_str(), &sa) == 0 && stat(b.c_str(), &sb) == 0 && sa.st_dev == sb.st_dev && sa.st_ino == sb.st_ino);
}

// The usage checks of a command writing `out` from `inputs`, then the stale output removed.
void prepare_output(const std::vector<std::string>& inputs, const std::string& out) {
  for (const std::string& in : inputs) {
    if (same_file(in, out)) throw UsageError("an input and the output must be different files");
  }
  remove(out.c_str());  // a failed run must leave no output, not even an earlier run's
}

int cmd_instance(const Args& a) {
  check_options(a, {"--at", "--named", "--downgrade-cff2"});
  if (a.paths.size() != 2) throw UsageError("instance takes an input file and an output file");
  if (a.at.empty()) throw UsageError("instance needs --at");
  std::vector<AxisValue> at = parse_at(a.at);
  prepare_output({a.paths[0]}, a.paths[1]);
  Bytes in;
  read_file(a.paths[0], &in);
  InstanceResult r = instance_font(in, at, a.downgrade);
  // The pins in fvar's order, from the canonical coordinates the instancer used.
  Sfnt s = parse_sfnt(in);
  std::vector<Pin> pins;
  const Table* fvar = s.find(HBF_TAG('f', 'v', 'a', 'r'));
  const uint8_t* fv = in.data() + fvar->offset;
  if (fvar->length < 16) fail(Err::SfntInvalid, "no readable fvar table");
  uint32_t axes_at = be16(fv + 4), n_axes = be16(fv + 8), axis_size = be16(fv + 10);
  if (axis_size < 20 || (uint64_t)axes_at + (uint64_t)n_axes * axis_size > fvar->length) {
    fail(Err::SfntInvalid, "the fvar table's axes run past its end");
  }
  for (uint32_t i = 0; i < n_axes; ++i) {
    uint32_t tag = be32(fv + axes_at + i * axis_size);
    for (const AxisValue& v : at) {
      if (v.tag == tag) pins.push_back({tag, (int32_t)llround(v.value * 65536.0)});
    }
  }
  InstanceNames names = instance_names(in, r.out, pins);
  if (a.named >= 0 && names.named != a.named) {
    fail(Err::NamedMismatch, "--named %ld: the location is %s", a.named,
         names.named < 0 ? "no named instance" : ("named instance " + std::to_string(names.named)).c_str());
  }
  Bytes out = apply_instance_names(in, r.out, names);
  if (r.flavor == "cff") {
    // HarfBuzz's downgrade is CID-keyed: name-keyed with post's names where it can be (cff_namekey.h), else renamed.
    Sfnt o = parse_sfnt(out);
    const Table* cff = o.find(HBF_TAG('C', 'F', 'F', ' '));
    Bytes table(out.begin() + cff->offset, out.begin() + cff->offset + cff->length);
    std::string why;
    std::vector<std::string> glyph_names = post_glyph_names(out, &why);
    Bytes keyed = glyph_names.empty() ? Bytes() : cff_name_keyed(table, glyph_names, names.postscript, &why);
    if (!keyed.empty()) {
      out = replace_tables(out, {{HBF_TAG('C', 'F', 'F', ' '), keyed}, {HBF_TAG('p', 'o', 's', 't'), post_format3(out)}});
    } else {
      out = replace_tables(out, {{HBF_TAG('C', 'F', 'F', ' '), cff_with_font_name(table, names.postscript, nullptr)}});
    }
  }
  write_file(a.paths[1], out);
  printf("{\"ok\":true,\"command\":\"instance\",\"flavor\":%s,\"numGlyphs\":%u,\"coordinates\":{%s},"
         "\"downgraded\":%s,\"inSize\":%zu,\"outSize\":%zu}\n",
         json_quote(r.flavor).c_str(), r.glyphs, r.coords.c_str(), r.downgraded ? "true" : "false", in.size(),
         out.size());
  return 0;
}

int cmd_transplant(const Args& a) {
  check_options(a, {});
  if (a.paths.size() != 4) throw UsageError("transplant takes a colour source, an outline font, a glyph map and an output");
  prepare_output({a.paths[0], a.paths[1], a.paths[2]}, a.paths[3]);
  Bytes src, outline, map;
  read_file(a.paths[0], &src);
  read_file(a.paths[1], &outline);
  read_file(a.paths[2], &map);
  TransplantResult r = transplant(src, outline, map);
  write_file(a.paths[3], r.out);
  std::string tables;
  for (const std::string& t : r.tables) tables += std::string(tables.empty() ? "" : ",") + json_quote(t);
  printf("{\"ok\":true,\"command\":\"transplant\",\"tables\":[%s],\"numGlyphs\":%u,\"outSize\":%zu}\n",
         tables.c_str(), r.glyphs, r.out.size());
  return 0;
}

// Test hook (wasm): 1 MiB blocks until the module's 1 GiB ceiling; linked with ABORTING_MALLOC=1 the runtime aborts
// with its out-of-memory message, which post.js records for lastAbort(). Native builds have no ceiling, so the hook
// refuses there instead of exhausting the host.
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

void no_paths(const Args& a) {
  if (!a.paths.empty()) throw UsageError(a.command + " takes no file");
  if (!a.options.empty()) throw UsageError(a.options[0] + " does not apply to " + a.command);
}

int run(int argc, char** argv, std::string* command) {
  if (argc >= 2 && is_command(argv[1])) *command = argv[1];  // named even when its options are wrong
  Args a = parse_args(argc, argv);
  const std::string& cmd = a.command;
  if (cmd == "version") {
    no_paths(a);
    printf("{\"ok\":true,\"command\":\"version\",\"hbfont\":\"%s\",\"harfbuzz\":%s,\"zlib\":\"%s\"}\n",
           HBFONT_VERSION, json_quote(hb_version_string()).c_str(), ZLIB_VERSION);
    return 0;
  }
  if (cmd == "help") {
    no_paths(a);
    fputs(USAGE, stdout);
    return 0;
  }
  if (cmd == "error-ids") {
    no_paths(a);
    std::string ids;
    for (int i = 0; i < kErrCount; ++i) ids += std::string(i ? "," : "") + json_quote(err_id(static_cast<Err>(i)));
    printf("{\"ok\":true,\"v\":1,\"command\":\"error-ids\",\"ids\":[%s]}\n", ids.c_str());
    return 0;
  }
  if (cmd == "selftest-oom") {
    no_paths(a);
    return selftest_oom();
  }
  if (cmd == "info") {
    check_options(a, {});
    if (a.paths.size() != 1) throw UsageError("info takes exactly one file");
    Bytes in;
    read_file(a.paths[0], &in);
    printf("%s\n", info_json(in).c_str());
    return 0;
  }
  if (cmd == "instance") return cmd_instance(a);
  if (cmd == "transplant") return cmd_transplant(a);
  if (cmd == "selftest-hb-rewrite") {  // test hook (N4): the font as HarfBuzz's subsetter writes it, everything kept
    check_options(a, {});
    if (a.paths.size() != 2) throw UsageError("selftest-hb-rewrite takes a font and an output");
    prepare_output({a.paths[0]}, a.paths[1]);
    Bytes in;
    read_file(a.paths[0], &in);
    parse_sfnt(in);
    hb_blob_t* blob = hb_blob_create((const char*)in.data(), (unsigned)in.size(), HB_MEMORY_MODE_READONLY, nullptr, nullptr);
    hb_face_t* face = hb_face_create(blob, 0);
    hb_subset_input_t* input = hb_subset_input_create_or_fail();
    if (!input) fail(Err::OutOfMemory, "out of memory for HarfBuzz's subset input");
    hb_subset_input_keep_everything(input);
    hb_subset_input_set_flags(input, hb_subset_input_get_flags(input) | HB_SUBSET_FLAGS_RETAIN_GIDS);
    hb_face_t* out_face = hb_subset_or_fail(face, input);
    hb_subset_input_destroy(input);
    hb_face_destroy(face);
    hb_blob_destroy(blob);
    if (!out_face) fail(Err::OutputInvalid, "HarfBuzz could not rewrite the font");
    hb_blob_t* ob = hb_face_reference_blob(out_face);
    unsigned len = 0;
    const char* data = hb_blob_get_data(ob, &len);
    Bytes out((const uint8_t*)data, (const uint8_t*)data + len);
    hb_blob_destroy(ob);
    hb_face_destroy(out_face);
    write_file(a.paths[1], out);
    printf("{\"ok\":true,\"command\":\"selftest-hb-rewrite\",\"outSize\":%zu}\n", out.size());
    return 0;
  }
  if (cmd == "selftest-cff-strings") {  // test hook (N3): the 391 CFF standard strings hbfont names glyphs with
    check_options(a, {});
    if (!a.paths.empty()) throw UsageError("selftest-cff-strings takes nothing");
    std::string list;
    for (int i = 0; i < kCffStandardStringCount; ++i) list += (i ? "," : "") + json_quote(kCffStandardStrings[i]);
    printf("{\"ok\":true,\"command\":\"selftest-cff-strings\",\"strings\":[%s]}\n", list.c_str());
    return 0;
  }

  if (cmd == "selftest-cff-namekey") {  // test hook (N3): the name-keying alone, on any CFF font with its post names
    check_options(a, {});
    if (a.paths.size() != 2) throw UsageError("selftest-cff-namekey takes a font and an output");
    prepare_output({a.paths[0]}, a.paths[1]);
    Bytes in;
    read_file(a.paths[0], &in);
    Sfnt s = parse_sfnt(in);
    const Table* cff = s.find(HBF_TAG('C', 'F', 'F', ' '));
    if (!cff) fail(Err::CffInvalid, "the font has no CFF table");
    Bytes table(in.begin() + cff->offset, in.begin() + cff->offset + cff->length);
    CffIndex name_index = cff_read_index(table, table[2]);
    std::string font_name(table.begin() + name_index.item_start[0], table.begin() + name_index.item_start[1]);
    std::string why;
    std::vector<std::string> glyph_names = post_glyph_names(in, &why);
    Bytes keyed = glyph_names.empty() ? Bytes() : cff_name_keyed(table, glyph_names, font_name, &why);
    Bytes out = keyed.empty() ? in
                              : replace_tables(in, {{HBF_TAG('C', 'F', 'F', ' '), keyed},
                                                    {HBF_TAG('p', 'o', 's', 't'), post_format3(in)}});
    write_file(a.paths[1], out);
    printf("{\"ok\":true,\"command\":\"selftest-cff-namekey\",\"keyed\":\"%s\",\"why\":%s}\n",
           keyed.empty() ? "cid" : "name", keyed.empty() ? json_quote(why).c_str() : "null");
    return 0;
  }

  if (cmd == "selftest-cff-stack") {  // test hook (N3): the downgrade's stack check alone, on any CFF font
    check_options(a, {});
    if (a.paths.size() != 1) throw UsageError("selftest-cff-stack takes a font");
    Bytes in;
    read_file(a.paths[0], &in);
    Sfnt s = parse_sfnt(in);
    const Table* cff = s.find(HBF_TAG('C', 'F', 'F', ' '));
    if (!cff) fail(Err::CffInvalid, "the font has no CFF table");
    size_t deepest = cff1_check_stack(Bytes(in.begin() + cff->offset, in.begin() + cff->offset + cff->length));
    printf("{\"ok\":true,\"command\":\"selftest-cff-stack\",\"deepest\":%zu}\n", deepest);
    return 0;
  }

  if (cmd == "selftest-cff-name") {  // test hook (N4): the CFF FontName change instance makes, on any CFF font
    check_options(a, {});
    if (a.paths.size() != 3) throw UsageError("selftest-cff-name takes a font, a name and an output");
    prepare_output({a.paths[0]}, a.paths[2]);
    Bytes in;
    read_file(a.paths[0], &in);
    Sfnt s = parse_sfnt(in);
    const Table* cff = s.find(HBF_TAG('C', 'F', 'F', ' '));
    if (!cff) fail(Err::CffInvalid, "the font has no CFF table");
    Bytes table(in.begin() + cff->offset, in.begin() + cff->offset + cff->length);
    std::string old;
    Bytes out = replace_tables(in, {{HBF_TAG('C', 'F', 'F', ' '), cff_with_font_name(table, a.paths[1], &old)}});
    write_file(a.paths[2], out);
    printf("{\"ok\":true,\"command\":\"selftest-cff-name\",\"was\":%s,\"outSize\":%zu}\n", json_quote(old).c_str(),
           out.size());
    return 0;
  }
  throw UsageError("unknown command (hbfont help lists them)");
}

}  // namespace

int main(int argc, char** argv) {
  // Test hook: an unterminated stderr line, then an exception that escapes main() (for post.js and N11).
  if (argc == 2 && strcmp(argv[1], "selftest-throw") == 0) {
    fputs("hbfont: selftest: unterminated", stderr);
    throw std::runtime_error("hbfont selftest exception");
  }
  int rc;
  std::string command;
  hbf::Err id = hbf::Err::Unexpected;
  try {
    rc = run(argc, argv, &command);
  } catch (const hbf::UsageError& e) {
    fprintf(stderr, "hbfont: usage error: %s\n%s", e.what(), USAGE);
    rc = 2;
    id = hbf::Err::Usage;
  } catch (const hbf::Error& e) {
    fprintf(stderr, "hbfont: error: %s\n", e.what());
    rc = 1;
    id = e.id;
  } catch (const std::bad_alloc&) {
    fprintf(stderr, "hbfont: error: out of memory\n");
    rc = 1;
    id = hbf::Err::OutOfMemory;
  } catch (const std::exception& e) {
    fprintf(stderr, "hbfont: error: unexpected failure: %s\n", e.what());
    rc = 1;
  }
  if (rc == 1 || rc == 2) {
    printf("{\"ok\":false,\"v\":1,\"command\":%s,\"error\":\"%s\"}\n",
           command.empty() ? "null" : hbf::json_quote(command).c_str(), hbf::err_id(id));
  }
  fflush(stdout);
  fflush(stderr);
  return rc;
}
