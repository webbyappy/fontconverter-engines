// cff_namekey.h -- a CID-keyed CFF made name-keyed (fontconverter-web P3b, 2026-11-19, with Codex's read-only advice).
// HarfBuzz's CFF2 downgrade always writes a CID-keyed CFF (ROS Adobe-Identity-0, glyphs read as cid00001...). With one
// FD and usable glyph names in post format 2, hbfont writes the font name-keyed instead, as fontTools' instancer does:
// editors then show the names, and FontForge keeps the GDEF mark-attachment classes it lost on the CID-keyed font.
// Charstrings and the Private DICT are copied byte for byte; post becomes format 3 (CFF now carries the names).
#ifndef HBFONT_CFF_NAMEKEY_H_
#define HBFONT_CFF_NAMEKEY_H_

#include <string>
#include <vector>

#include "common.h"

namespace hbf {

// Every glyph's name from the font's post table (format 2, through HarfBuzz's reading of it), or an empty vector with
// *why set: no post table, another format, a glyph without a name.
std::vector<std::string> post_glyph_names(const Bytes& font, std::string* why);

// The name-keyed form of the CID-keyed CFF table `cff`, named `font_name`, its glyphs `names`; or an empty Bytes with
// *why set when it stays CID-keyed: not CID-keyed, global or local subroutines, not one FD, an FD entry other than its
// Private DICT (a FontMatrix included), names not one per glyph, not unique, not valid PostScript names (1 to 63
// characters 33 to 126 without []{}()<>/%) or .notdef elsewhere than glyph 0. Damage is cff-invalid.
Bytes cff_name_keyed(const Bytes& cff, const std::vector<std::string>& names, const std::string& font_name,
                     std::string* why);

// The font's post table as format 3: its 32-byte header, version 3.0.
Bytes post_format3(const Bytes& font);

}  // namespace hbf

#endif  // HBFONT_CFF_NAMEKEY_H_
