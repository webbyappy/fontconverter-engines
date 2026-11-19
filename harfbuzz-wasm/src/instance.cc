// instance.cc -- see instance.h.
#include "instance.h"

#include <hb-ot.h>
#include <hb-subset.h>
#include <hb.h>

#include <cerrno>
#include <cmath>
#include <cstdlib>
#include <cstring>

#include "cff.h"
#include "info.h"
#include "sfnt.h"

namespace hbf {

namespace {

const uint32_t VARIATION_TABLES[] = {HBF_TAG('f', 'v', 'a', 'r'), HBF_TAG('g', 'v', 'a', 'r'), HBF_TAG('C', 'F', 'F', '2'),
                                     HBF_TAG('c', 'v', 'a', 'r'), HBF_TAG('H', 'V', 'A', 'R'), HBF_TAG('M', 'V', 'A', 'R'),
                                     HBF_TAG('V', 'V', 'A', 'R'), HBF_TAG('a', 'v', 'a', 'r'), HBF_TAG('D', 'S', 'I', 'G')};

long long fixed16(double v) { return llround(v * 65536.0); }

std::string tag_text(uint32_t tag) {
  std::string s;
  for (int i = 0; i < 4; ++i) {
    char c = (char)(tag >> (24 - 8 * i));
    if (c != ' ' || i == 0) s += c;
  }
  return s;
}

struct HbFace {
  hb_blob_t* blob;
  hb_face_t* face;
  explicit HbFace(const Bytes& b)
      : blob(hb_blob_create((const char*)b.data(), (unsigned)b.size(), HB_MEMORY_MODE_READONLY, nullptr, nullptr)),
        face(hb_face_create(blob, 0)) {}
  ~HbFace() {
    hb_face_destroy(face);
    hb_blob_destroy(blob);
  }
  HbFace(const HbFace&) = delete;
  HbFace& operator=(const HbFace&) = delete;
};

struct SubsetInput {
  hb_subset_input_t* p = hb_subset_input_create_or_fail();
  ~SubsetInput() { hb_subset_input_destroy(p); }
  SubsetInput() = default;
  SubsetInput(const SubsetInput&) = delete;
  SubsetInput& operator=(const SubsetInput&) = delete;
};

}  // namespace

std::vector<AxisValue> parse_at(const std::string& spec) {
  std::vector<AxisValue> out;
  size_t start = 0;
  while (start <= spec.size()) {
    size_t comma = spec.find(',', start);
    std::string item = spec.substr(start, comma == std::string::npos ? std::string::npos : comma - start);
    size_t eq = item.find('=');
    if (eq == std::string::npos || eq == 0 || eq > 4) throw UsageError("--at takes TAG=VALUE,…, not '" + item + "'");
    std::string tag = item.substr(0, eq), value = item.substr(eq + 1);
    for (char c : tag) {
      if (c < 0x21 || c > 0x7e) throw UsageError("--at: an axis tag is printable ASCII");
    }
    char* end = nullptr;
    errno = 0;
    double v = strtod(value.c_str(), &end);
    if (value.empty() || *end != '\0' || errno != 0 || !std::isfinite(v) || std::fabs(v) > 32767.0) {
      throw UsageError("--at: '" + value + "' is not a number from -32767 to 32767");
    }
    while (tag.size() < 4) tag += ' ';
    uint32_t t = HBF_TAG(tag[0], tag[1], tag[2], tag[3]);
    for (const AxisValue& a : out) {
      if (a.tag == t) throw UsageError("--at names " + tag_text(t) + " twice");
    }
    out.push_back({t, v});
    if (comma == std::string::npos) break;
    start = comma + 1;
  }
  return out;
}

InstanceResult instance_font(const Bytes& in, const std::vector<AxisValue>& at, bool downgrade_cff2) {
  Sfnt s = parse_sfnt(in);
  if (!s.find(HBF_TAG('f', 'v', 'a', 'r'))) fail(Err::NotVariable, "the font has no fvar table: it is not variable");
  bool cff2 = s.find(HBF_TAG('C', 'F', 'F', '2')) != nullptr;
  if (downgrade_cff2 && !cff2) fail(Err::InstanceFailed, "--downgrade-cff2: the font has no CFF2 table");
  HbFace f(in);
  unsigned n = hb_ot_var_get_axis_count(f.face);
  std::vector<hb_ot_var_axis_info_t> axes(n);
  unsigned got = n;
  hb_ot_var_get_axis_infos(f.face, 0, &got, axes.data());
  if (n == 0 || got != n) fail(Err::SfntInvalid, "the fvar table lists %u axes, %u read", n, got);
  for (const AxisValue& a : at) {
    bool known = false;
    for (const hb_ot_var_axis_info_t& x : axes) known = known || x.tag == a.tag;
    if (!known) fail(Err::AxisUnknown, "the font has no axis %s", tag_text(a.tag).c_str());
  }
  SubsetInput input;
  if (!input.p) fail(Err::OutOfMemory, "out of memory for HarfBuzz's subset input");
  hb_subset_input_keep_everything(input.p);
  // The instance keeps the variable font's overlapping contours: OVERLAP_SIMPLE / OVERLAP_COMPOUND ask every rasterizer
  // for the non-zero fill (OpenType's advice for a static font with overlaps; fontTools' instancer sets them too). P3b
  // decision of 2026-11-19 with Codex's read-only advice. glyf only; a CFF instance is unchanged.
  unsigned flags = hb_subset_input_get_flags(input.p) | HB_SUBSET_FLAGS_RETAIN_GIDS | HB_SUBSET_FLAGS_SET_OVERLAPS_FLAG;
  if (downgrade_cff2) flags |= HB_SUBSET_FLAGS_DOWNGRADE_CFF2;
  hb_subset_input_set_flags(input.p, flags);
  // P3b-10: CPAL is never subset (palette entries and their indices are addressed from SVG documents and CSS).
  hb_set_add(hb_subset_input_set(input.p, HB_SUBSET_SETS_NO_SUBSET_TABLE_TAG), HB_TAG('C', 'P', 'A', 'L'));
  hb_set_add(hb_subset_input_set(input.p, HB_SUBSET_SETS_DROP_TABLE_TAG), HB_TAG('D', 'S', 'I', 'G'));
  InstanceResult r;
  for (unsigned i = 0; i < n; ++i) {
    const AxisValue* a = nullptr;
    for (const AxisValue& x : at) {
      if (x.tag == axes[i].tag) a = &x;
    }
    if (!a) fail(Err::AxisMissing, "--at does not pin axis %s (every axis is pinned)", tag_text(axes[i].tag).c_str());
    long long v = fixed16(a->value);
    if (v < fixed16(axes[i].min_value) || v > fixed16(axes[i].max_value)) {
      fail(Err::AxisOutOfRange, "axis %s: %g is outside %g to %g", tag_text(axes[i].tag).c_str(), a->value,
           axes[i].min_value, axes[i].max_value);
    }
    double canonical = (double)v / 65536.0;
    if (!hb_subset_input_pin_axis_location(input.p, f.face, axes[i].tag, (float)canonical)) {
      fail(Err::InstanceFailed, "HarfBuzz could not pin axis %s", tag_text(axes[i].tag).c_str());
    }
    r.coords += std::string(i ? "," : "") + json_quote(tag_str(axes[i].tag)) + ":" + fixed_str(canonical);
  }
  hb_face_t* out = hb_subset_or_fail(f.face, input.p);
  if (!out) fail(Err::InstanceFailed, "HarfBuzz could not instance the font");
  hb_blob_t* blob = hb_face_reference_blob(out);
  unsigned len = 0;
  const char* data = hb_blob_get_data(blob, &len);
  r.out.assign((const uint8_t*)data, (const uint8_t*)data + len);
  hb_blob_destroy(blob);
  hb_face_destroy(out);
  if (r.out.empty()) fail(Err::InstanceFailed, "HarfBuzz wrote an empty font");

  Sfnt o = parse_sfnt(r.out);
  for (uint32_t t : VARIATION_TABLES) {
    if (o.find(t)) fail(Err::OutputInvalid, "the instance still has a %s table", tag_str(t).c_str());
  }
  r.flavor = outline_flavor(o);
  if (downgrade_cff2 && r.flavor != "cff") fail(Err::OutputInvalid, "the downgraded instance has no CFF table");
  if (downgrade_cff2) {
    const Table* cff = o.find(HBF_TAG('C', 'F', 'F', ' '));
    cff1_check_stack(Bytes(r.out.begin() + cff->offset, r.out.begin() + cff->offset + cff->length));
  }
  unsigned src_glyphs = be16(in.data() + s.find(HBF_TAG('m', 'a', 'x', 'p'))->offset + 4);
  r.glyphs = be16(r.out.data() + o.find(HBF_TAG('m', 'a', 'x', 'p'))->offset + 4);
  if (r.glyphs != src_glyphs) fail(Err::OutputInvalid, "the instance has %u glyphs, the source %u", r.glyphs, src_glyphs);
  r.downgraded = downgrade_cff2;
  return r;
}

}  // namespace hbf
