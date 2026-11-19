// info.cc -- see info.h.
#include "info.h"

#include <hb-ot.h>
#include <hb.h>

#include <cmath>
#include <cstdlib>
#include <cstdio>
#include <vector>

#include "names.h"
#include "sfnt.h"

namespace hbf {

std::string fixed_str(double v) {
  long long f = llround(v * 65536.0);
  for (int digits = 0; digits <= 5; ++digits) {
    char buf[48];
    snprintf(buf, sizeof(buf), "%.*f", digits, (double)f / 65536.0);
    if (llround(strtod(buf, nullptr) * 65536.0) == f) {
      std::string s = buf;
      return s == "-0" ? "0" : s;
    }
  }
  char buf[48];
  snprintf(buf, sizeof(buf), "%.6f", (double)f / 65536.0);
  return buf;
}

namespace {

std::string name_or_null(const Bytes& font, const Sfnt& s, unsigned id) {
  std::string n;
  if (id == HB_OT_NAME_ID_INVALID || id > 0xffff || !english_name(font, s, (uint16_t)id, &n)) return "null";
  return json_quote(n);
}

struct Face {
  hb_blob_t* blob;
  hb_face_t* face;
  explicit Face(const Bytes& b)
      : blob(hb_blob_create((const char*)b.data(), (unsigned)b.size(), HB_MEMORY_MODE_READONLY, nullptr, nullptr)),
        face(hb_face_create(blob, 0)) {}
  ~Face() {
    hb_face_destroy(face);
    hb_blob_destroy(blob);
  }
  Face(const Face&) = delete;
  Face& operator=(const Face&) = delete;
};

std::string variable_json(const Bytes& font, const Sfnt& s, hb_face_t* face) {
  if (!s.find(HBF_TAG('f', 'v', 'a', 'r'))) return "null";
  if (!hb_ot_var_has_data(face)) fail(Err::SfntInvalid, "the fvar table cannot be read");
  unsigned n_axes = hb_ot_var_get_axis_count(face);
  std::vector<hb_ot_var_axis_info_t> axes(n_axes);
  unsigned got = n_axes;
  hb_ot_var_get_axis_infos(face, 0, &got, axes.data());
  if (got != n_axes || n_axes == 0) fail(Err::SfntInvalid, "the fvar table lists %u axes, %u read", n_axes, got);
  std::string o = "{\"axes\":[";
  for (unsigned i = 0; i < n_axes; ++i) {
    const hb_ot_var_axis_info_t& a = axes[i];
    char tag[5];
    hb_tag_to_string(a.tag, tag);
    tag[4] = '\0';
    o += std::string(i ? "," : "") + "{\"tag\":" + json_quote(tag) + ",\"min\":" + fixed_str(a.min_value) +
         ",\"default\":" + fixed_str(a.default_value) + ",\"max\":" + fixed_str(a.max_value) + ",\"name\":" +
         name_or_null(font, s, a.name_id) + ",\"hidden\":" +
         ((a.flags & HB_OT_VAR_AXIS_FLAG_HIDDEN) ? "true" : "false") + "}";
  }
  o += "],\"instances\":[";
  unsigned n_inst = hb_ot_var_get_named_instance_count(face);
  std::vector<float> coords(n_axes);
  for (unsigned i = 0; i < n_inst; ++i) {
    unsigned len = n_axes;
    hb_ot_var_named_instance_get_design_coords(face, i, &len, coords.data());
    if (len != n_axes) fail(Err::SfntInvalid, "named instance %u has %u coordinates for %u axes", i, len, n_axes);
    std::string c;
    for (unsigned k = 0; k < n_axes; ++k) {
      char tag[5];
      hb_tag_to_string(axes[k].tag, tag);
      tag[4] = '\0';
      c += std::string(k ? "," : "") + json_quote(tag) + ":" + fixed_str(coords[k]);
    }
    o += std::string(i ? "," : "") + "{\"index\":" + std::to_string(i) + ",\"name\":" +
         name_or_null(font, s, hb_ot_var_named_instance_get_subfamily_name_id(face, i)) + ",\"coordinates\":{" + c +
         "},\"postscriptName\":" + name_or_null(font, s, hb_ot_var_named_instance_get_postscript_name_id(face, i)) +
         "}";
  }
  o += std::string("],\"stat\":") + (s.find(HBF_TAG('S', 'T', 'A', 'T')) ? "true" : "false") + "}";
  return o;
}

std::string colour_json(const Bytes& font, const Sfnt& s) {
  const Table* colr = s.find(HBF_TAG('C', 'O', 'L', 'R'));
  std::string v = "null";
  if (colr) {
    if (colr->length < 2) fail(Err::SfntInvalid, "the COLR table is %u bytes", colr->length);
    v = std::to_string(be16(font.data() + colr->offset));
  }
  auto has = [&](uint32_t tag) { return s.find(tag) ? "true" : "false"; };
  return "{\"colr\":" + v + ",\"cpal\":" + has(HBF_TAG('C', 'P', 'A', 'L')) + ",\"svg\":" +
         has(HBF_TAG('S', 'V', 'G', ' ')) + ",\"sbix\":" + has(HBF_TAG('s', 'b', 'i', 'x')) + ",\"cbdt\":" +
         has(HBF_TAG('C', 'B', 'D', 'T')) + "}";
}

}  // namespace

std::string info_json(const Bytes& font) {
  Sfnt s = parse_sfnt(font);
  const Table* maxp = s.find(HBF_TAG('m', 'a', 'x', 'p'));
  unsigned glyphs = be16(font.data() + maxp->offset + 4);
  Face f(font);
  return "{\"ok\":true,\"command\":\"info\",\"flavor\":" + json_quote(outline_flavor(s)) +
         ",\"numGlyphs\":" + std::to_string(glyphs) + ",\"variable\":" + variable_json(font, s, f.face) +
         ",\"colour\":" + colour_json(font, s) + "}";
}

}  // namespace hbf
