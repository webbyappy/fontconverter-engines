// transplant.h -- `hbfont transplant`: a source font's colour tables put back into FontForge's output of it, by
// ffconv's glyph map (fontconverter-web P3b plan, P3b-9 to P3b-11).
#ifndef HBFONT_TRANSPLANT_H_
#define HBFONT_TRANSPLANT_H_

#include <string>
#include <vector>

#include "common.h"

namespace hbf {

struct TransplantResult {
  Bytes out;
  std::vector<std::string> tables;  // the colour tables put back
  uint32_t glyphs = 0;
};

TransplantResult transplant(const Bytes& src, const Bytes& outline, const Bytes& map_json);

}  // namespace hbf

#endif  // HBFONT_TRANSPLANT_H_
