// instance_names.h -- the names of a static instance (fontconverter-web P3b plan, section 3.4; the owner's Q4).
#ifndef HBFONT_INSTANCE_NAMES_H_
#define HBFONT_INSTANCE_NAMES_H_

#include <cstdint>
#include <string>
#include <vector>

#include "common.h"

namespace hbf {

// One pinned axis, in fvar's order: its tag and its canonical 16.16 value.
struct Pin {
  uint32_t tag;
  int32_t fixed;
};

struct InstanceNames {
  std::string family;     // F: nameID 16, else 1 (trimmed)
  std::string subfamily;  // S
  std::string legacy_family, legacy_style;  // 1, 2
  std::string full;        // 4
  std::string postscript;  // 6 (also the CFF FontName)
  std::string unique;      // 3
  bool bold = false, italic = false, oblique = false;
  int named = -1;  // the named instance whose coordinates all match, or -1
};

// The names of `source` (a variable font) at `pins`, read from its fvar, STAT and name table; the revision and vendor
// come from `instance` (HarfBuzz keeps head and OS/2).
InstanceNames instance_names(const Bytes& source, const Bytes& instance, const std::vector<Pin>& pins);

// `instance` with its name table, OS/2 fsSelection and head macStyle rewritten for `n` (the CFF FontName is
// cff_name.h's).
Bytes apply_instance_names(const Bytes& source, const Bytes& instance, const InstanceNames& n);

}  // namespace hbf

#endif  // HBFONT_INSTANCE_NAMES_H_
