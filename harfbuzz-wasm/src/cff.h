// cff.h -- hbfont's own reading of a CFF table (fontconverter-web P3b plan, section 3.1): INDEXes, DICTs and the
// charset. Bounds-checked: a damaged table is cff-invalid.
#ifndef HBFONT_CFF_H_
#define HBFONT_CFF_H_

#include <cstdint>
#include <vector>

#include "common.h"

namespace hbf {

struct CffIndex {
  uint32_t count = 0;
  size_t start = 0, end = 0;       // the INDEX's own bytes
  std::vector<size_t> item_start;  // absolute, count + 1 entries
};

// One DICT operand: where it starts, how it is encoded (28, 29, 30 for a real, 1 or 2 for the short forms) and its
// integer value (0 for a real).
struct CffOperand {
  size_t at;
  int kind;
  int64_t value;
};

struct CffDictEntry {
  int op;  // 0 to 21, or 1200 + an escaped operator
  std::vector<CffOperand> operands;
  size_t from = 0, to = 0;  // the entry's bytes: its operands and its operator
};

CffIndex cff_read_index(const Bytes& c, size_t at);
std::vector<CffDictEntry> cff_read_dict(const Bytes& c, size_t from, size_t to);

// The Top DICT of a one-font CFF table, and where its INDEX ends.
std::vector<CffDictEntry> cff_top_dict(const Bytes& c, size_t* names_end = nullptr);

// For a CID-keyed CFF (Top DICT has ROS), each glyph id's CID from its charset (formats 0 to 2); glyph 0 is CID 0.
// An empty vector for a name-keyed font. cff-invalid for a damaged or predefined charset.
std::vector<uint32_t> cff_glyph_cids(const Bytes& c, uint32_t num_glyphs);

// The output check of a CFF2 font downgraded to CFF (P3b, harfbuzz-wasm patch 2's guard): the deepest operand stack any
// charstring builds, refused (output-invalid) over CFF1's 48, and refused when the table has Global Subrs or a
// charstring calls a subroutine or uses an operator HarfBuzz's downgrade never writes (the walk would not be sound).
size_t cff1_check_stack(const Bytes& c);

}  // namespace hbf

#endif  // HBFONT_CFF_H_
