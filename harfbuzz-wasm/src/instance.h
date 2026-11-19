// instance.h -- `hbfont instance`: a static font at one location of a variable font (P3b plan, section 3.1).
#ifndef HBFONT_INSTANCE_H_
#define HBFONT_INSTANCE_H_

#include <cstdint>
#include <string>
#include <vector>

#include "common.h"

namespace hbf {

struct AxisValue {
  uint32_t tag;
  double value;
};

// "wght=400,wdth=87.5": usage error on any other syntax, an empty list, a tag of more than four characters or one
// named twice.
std::vector<AxisValue> parse_at(const std::string& spec);

struct InstanceResult {
  Bytes out;
  std::string flavor;     // of the output: "truetype" or "cff"
  unsigned glyphs = 0;
  std::string coords;     // JSON object members, canonical values in fvar's axis order
  bool downgraded = false;
};

// Every fvar axis pinned at its value (exit 1: not-variable, axis-unknown, axis-missing, axis-out-of-range), values
// canonicalised to 16.16; HarfBuzz's instancer with everything kept, CPAL never subset and DSIG dropped; CFF2
// downgraded to CFF when asked. The output is checked: static, the source's glyph count, CFF after a downgrade.
InstanceResult instance_font(const Bytes& in, const std::vector<AxisValue>& at, bool downgrade_cff2);

}  // namespace hbf

#endif  // HBFONT_INSTANCE_H_
