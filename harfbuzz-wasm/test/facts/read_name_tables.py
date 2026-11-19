#!/usr/bin/env python3
"""fontTools' two predefined glyph-name tables, which the harness reads glyph names with: CFF's 391 standard strings
(SIDs 0 to 390, Adobe Technical Note 5176, appendix A) and the 258 standard Macintosh glyph names of a `post` format 2
table. hbfont's own copy of the standard strings (src/cff_std_strings.h) is compared with them (N0). Run by hand
(never by a test), with the web repo's pinned tools:

    ~/.venvs/fontconverter-tools/bin/python -I harfbuzz-wasm/test/facts/read_name_tables.py > harfbuzz-wasm/test/facts/name-tables.json
"""
import json
import sys

import fontTools
from fontTools.cffLib import cffStandardStrings
from fontTools.ttLib.standardGlyphOrder import standardGlyphOrder


def main():
    assert len(cffStandardStrings) == 391 and len(standardGlyphOrder) == 258
    json.dump({"fonttools": fontTools.version, "cffStandardStrings": list(cffStandardStrings),
               "macGlyphNames": list(standardGlyphOrder)}, sys.stdout, indent=0)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
