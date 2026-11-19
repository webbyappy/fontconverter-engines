// info.h -- `hbfont info`: what the app needs to plan a variable or colour font (P3b plan, section 3.1 and P3b-13).
#ifndef HBFONT_INFO_H_
#define HBFONT_INFO_H_

#include <string>

#include "common.h"

namespace hbf {

// One JSON line: {"ok":true,"command":"info","flavor","numGlyphs","variable":null|{axes,instances,stat},
// "colour":{colr,cpal,svg,sbix,cbdt}}. Reads metadata only (fvar, name, STAT, the colour tables' presence).
std::string info_json(const Bytes& font);

// A 16.16 value as the shortest decimal that reads back to the same 16.16 number ("400", "87.5").
std::string fixed_str(double v);

}  // namespace hbf

#endif  // HBFONT_INFO_H_
