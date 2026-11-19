// svg_table.h -- the SVG table renumbered by a glyph map (fontconverter-web P3b plan, P3b-11).
#ifndef HBFONT_SVG_TABLE_H_
#define HBFONT_SVG_TABLE_H_

#include <vector>

#include "common.h"

namespace hbf {

// `table` (an SVG table) with every supported glyph reference renumbered by `map` (source glyph id -> output glyph
// id, -1 for none) and its document index rebuilt. Exit 1: svg-invalid, svg-unsupported-reference,
// colour-glyph-unmapped (a document names a glyph the map drops).
Bytes svg_remap(const Bytes& table, const std::vector<int>& map);

}  // namespace hbf

#endif  // HBFONT_SVG_TABLE_H_
