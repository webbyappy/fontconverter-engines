// cff_name.h -- the CFF FontName set to an instance's PostScript name (fontconverter-web P3b plan, section 3.1):
// HarfBuzz's CFF2 downgrade writes "CFF1Font", and a font's PostScript name must agree with its nameID 6.
#ifndef HBFONT_CFF_NAME_H_
#define HBFONT_CFF_NAME_H_

#include <string>

#include "common.h"

namespace hbf {

// The CFF table `cff` with its one FontName replaced by `name` (the old one in *old_name when given); every absolute
// offset shifted, charstrings, subroutines and Private DICTs byte for byte. Exit 1: cff-invalid for a damaged table,
// cff-layout-unsupported for a layout HarfBuzz does not write (several fonts, an offset that is not a 5-byte integer).
Bytes cff_with_font_name(const Bytes& cff, const std::string& name, std::string* old_name);

}  // namespace hbf

#endif  // HBFONT_CFF_NAME_H_
