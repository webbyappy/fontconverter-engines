#!/usr/bin/env python3
"""fontTools' reading of the fixtures hbfont's N2 checks `hbfont info` against: outline flavour, glyph count, axes,
named instances (English names), STAT, colour tables. Run by hand (never by a test), with the web repo's pinned tools:

    ~/.venvs/fontconverter-tools/bin/python -I harfbuzz-wasm/test/facts/read_info_facts.py > harfbuzz-wasm/test/facts/info-facts.json

The output names the fontTools version; N2 refuses a facts file for another fixture set.
"""
import json
import os
import sys

import fontTools

from fontTools.ttLib import TTFont

ROOT = os.environ["FONT_FIXTURES"] + "/"  # the font fixture corpus; required
FIXTURES = [
    "real/var-ttf/OpenSans-VF.ttf", "real/sourcesans-vf/SourceSans3VF-Upright.ttf",
    "real/sourcesans-vf/SourceSans3VF-Upright.otf", "real/var-cjk-ttf/NotoSansSC-VF.ttf",
    "generated/variable/slick-vf-nostat.ttf", "generated/variable/OpenSans-VF-long-name.ttf",
    "real/var-colr/Nabla[EDPT,EHLT].ttf", "generated/colour/Twemoji-cff2-vf.otf",
    "generated/variable/SourceSans3-static.cff2.otf", "samples/slick.ttf", "real/twemoji/Twemoji.Mozilla.ttf",
    "real/color-colr/Noto-COLRv1.ttf", "real/color-cbdt/NotoColorEmoji.ttf", "generated/special/slick-sbix.ttf",
    "generated/special/slick-svg-table.ttf", "generated/colour/Twemoji-cff.otf",
]


def english(font, nid):
    if nid is None or nid == 0xFFFF:
        return None
    name = font["name"]
    for pid, eid, lid in ((3, 1, 0x409), (1, 0, 0), (0, 3, 0), (0, 4, 0)):
        r = name.getName(nid, pid, eid, lid)
        if r is not None:
            return r.toUnicode()
    for r in name.names:
        if r.nameID == nid:
            return r.toUnicode()
    return None


def num(v):
    f = round(v * 65536) / 65536
    return int(f) if f == int(f) else f


out = {}
for rel in FIXTURES:
    f = TTFont(ROOT + rel, lazy=True)
    flavor = "truetype" if "glyf" in f else "cff2" if "CFF2" in f else "cff" if "CFF " in f else "none"
    e = {"flavor": flavor, "numGlyphs": f["maxp"].numGlyphs, "variable": None}
    if "fvar" in f:
        fv = f["fvar"]
        v = e["variable"] = {}
        v["axes"] = [{"tag": a.axisTag, "min": num(a.minValue), "default": num(a.defaultValue), "max": num(a.maxValue),
                      "name": english(f, a.axisNameID), "hidden": bool(a.flags & 1)} for a in fv.axes]
        v["instances"] = [{"index": i, "name": english(f, inst.subfamilyNameID),
                           "coordinates": {k: num(v) for k, v in inst.coordinates.items()},
                           "postscriptName": english(f, inst.postscriptNameID)}
                          for i, inst in enumerate(fv.instances)]
        v["stat"] = "STAT" in f
    e["colour"] = {"colr": f["COLR"].version if "COLR" in f else None, "cpal": "CPAL" in f, "svg": "SVG " in f,
                   "sbix": "sbix" in f, "cbdt": "CBDT" in f}
    out[rel] = e
json.dump({"reader": "fontTools %s" % fontTools.version, "fixtures": out}, sys.stdout, ensure_ascii=False, indent=1)
sys.stdout.write("\n")
