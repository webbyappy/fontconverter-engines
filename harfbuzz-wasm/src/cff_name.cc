// cff_name.cc -- see cff_name.h. The CFF table is: header, Name INDEX, Top DICT INDEX, String INDEX, Global Subr
// INDEX, then data the Top DICT and the FDArray's font DICTs address by absolute offset. Writing another FontName
// changes the Name INDEX's length by `delta`, so every such offset moves by `delta`: charset (15, unless a predefined
// 0 to 2), Encoding (16, unless 0 or 1), CharStrings (17), Private (18, its offset operand), FDArray (12 36),
// FDSelect (12 37), and each FDArray DICT's Private (18; not when its size is 0: HarfBuzz writes an empty Private as
// size 0, offset 0, which addresses nothing). HarfBuzz writes every one of them as a 5-byte integer
// (operator 29), so each is rewritten in place and no DICT changes length; any other encoding is refused
// (cff-layout-unsupported) rather than re-encoded. Charstrings, subroutines and Private DICTs are copied untouched.
#include "cff_name.h"

#include <vector>

#include "cff.h"

namespace hbf {

namespace {

void shift(Bytes* out, size_t at_in_old, size_t delta_pos, const CffOperand& o, int64_t delta, const char* what) {
  if (o.kind != 29) fail(Err::CffLayoutUnsupported, "the CFF %s offset is not a 5-byte integer", what);
  int64_t v = o.value + delta;
  if (v < 0 || v > 0x7fffffff) fail(Err::CffInvalid, "the CFF %s offset would be %lld", what, (long long)v);
  size_t at = o.at - at_in_old + delta_pos + 1;
  (*out)[at] = (uint8_t)(v >> 24);
  (*out)[at + 1] = (uint8_t)(v >> 16);
  (*out)[at + 2] = (uint8_t)(v >> 8);
  (*out)[at + 3] = (uint8_t)v;
}

}  // namespace

Bytes cff_with_font_name(const Bytes& cff, const std::string& name, std::string* old_name) {
  std::vector<CffDictEntry> dict = cff_top_dict(cff);  // checks the header and the one-font layout
  size_t hdr = cff[2];
  CffIndex names = cff_read_index(cff, hdr);
  if (old_name) old_name->assign(cff.begin() + (long)names.item_start[0], cff.begin() + (long)names.item_start[1]);
  if (name.empty() || name.size() > 127) fail(Err::Internal, "a FontName of %zu bytes", name.size());

  Bytes index;  // the new Name INDEX: count 1, offSize 1, offsets 1 and 1 + length
  index.push_back(0);
  index.push_back(1);
  index.push_back(1);
  index.push_back(1);
  index.push_back((uint8_t)(1 + name.size()));
  index.insert(index.end(), name.begin(), name.end());
  int64_t delta = (int64_t)index.size() - (int64_t)(names.end - names.start);

  Bytes out(cff.begin(), cff.begin() + (long)hdr);
  out.insert(out.end(), index.begin(), index.end());
  size_t rest = out.size();  // where the old byte at names.end now sits
  out.insert(out.end(), cff.begin() + (long)names.end, cff.end());

  int64_t fdarray = -1;
  for (const CffDictEntry& e : dict) {
    if (e.operands.empty()) continue;
    const CffOperand& last = e.operands.back();
    if (e.op == 15 && last.value > 2) shift(&out, names.end, rest, last, delta, "charset");
    else if (e.op == 16 && last.value > 1) shift(&out, names.end, rest, last, delta, "Encoding");
    else if (e.op == 17) shift(&out, names.end, rest, last, delta, "CharStrings");
    else if (e.op == 18 && e.operands.size() == 2 && e.operands[0].value > 0) {
      shift(&out, names.end, rest, last, delta, "Private");  // an empty Private (size 0, offset 0) addresses nothing
    }
    else if (e.op == 1236) {
      shift(&out, names.end, rest, last, delta, "FDArray");
      fdarray = last.value;
    } else if (e.op == 1237) {
      shift(&out, names.end, rest, last, delta, "FDSelect");
    }
  }
  if (fdarray >= 0) {
    if ((size_t)fdarray >= cff.size()) fail(Err::CffInvalid, "the CFF FDArray offset points past the table");
    CffIndex fds = cff_read_index(cff, (size_t)fdarray);
    for (uint32_t i = 0; i < fds.count; ++i) {
      for (const CffDictEntry& e : cff_read_dict(cff, fds.item_start[i], fds.item_start[i + 1])) {
        if (e.op == 18 && e.operands.size() == 2 && e.operands[0].value > 0) {
          shift(&out, names.end, rest, e.operands.back(), delta, "FD Private");
        }
      }
    }
  }
  return out;
}

}  // namespace hbf
