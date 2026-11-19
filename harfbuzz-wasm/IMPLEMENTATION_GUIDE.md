# harfbuzz-wasm — Implementation Guide

`hbfont`: HarfBuzz 15.0.0's instancer and subsetter as a command line, for fontconverter.io's in-browser converter
(fontconverter-web P3b plan, `docs/audits/P3b-VARIABLE-COLOUR-PLAN-2026-11-18.md`). It makes a variable font static at
the location the user chooses, names the instance, and puts a colour font's colour tables back into FontForge's
output of it. Its own artifact: never linked with the GPL FontForge engine.

## 1. At a glance

| | |
|---|---|
| Artifact | `output/hbfont.js` + `output/hbfont.wasm` (committed), `output/BUILD-INFO.txt` (flags, pin, sha256) |
| Factory | `HBFont` (MODULARIZE, CommonJS-loadable, no ES6 export) |
| Size | `hbfont.wasm` 2,395,123 bytes (brotli 528,085, gzip 737,977), `hbfont.js` 86,293 bytes |
| Interface | a command line through `callMain(argv)`, synchronous; MEMFS, WORKERFS, NODEFS |
| Memory | 64 MiB initial, **1 GiB maximum with `ABORTING_MALLOC=1`** (an allocation the ceiling refuses aborts the instance; `lastAbort()` says `"oom"`), 8 MiB stack; no pthreads, no SIMD, no Asyncify; `-sGROWABLE_ARRAYBUFFERS=0` |
| Licences | own code; HarfBuzz MIT ("Old MIT", `vendor/licenses/harfbuzz-COPYING`); zlib (Emscripten port) Zlib |
| Sources | `src/` (own), `vendor/harfbuzz/` (the 15.0.0 release, a pinned subset with three local patches, `VENDORING.md`) |

## 2. Layout

```
build-hbfont-wasm.sh     Emscripten 6.0.2 only; ninja; links into a fresh staging folder, checks the glue, copies to output/
build-native.sh          the same sources under clang ASan/UBSan (build/native/hbfont-asan, not committed)
post.js                  FS/WORKERFS/NODEFS, guarded callMain, flushStderr, heapBytes, lastAbort, mountFile/mountBlob
src/main.cc              commands, the failure line, test hooks
src/sfnt.cc              the table directory (checked before HarfBuzz sees the bytes), cmap, metrics
src/names.cc             the name table: English names in fontTools' order, the table's parser and writer
src/info.cc              info
src/instance.cc          instance: pins, HarfBuzz's instancer, the output check
src/instance_names.cc    the names of an instance (section 4)
src/cff.cc, cff_name.cc  CFF INDEX, DICT and charset; the FontName rewrite
src/sfnt_edit.cc         tables replaced, checksums recomputed
src/transplant.cc        transplant: the map's checks, HarfBuzz's plan, sbix padding, COLR sorting, CPAL names
src/svg_table.cc         the SVG table renumbered (own code)
vendor/                  HarfBuzz 15.0.0 (fetch-vendor.sh, --check), patches/, licenses/
test/                    the node harness (N0–N12), the browser harness, the mutation sweep, make-oracle.mjs
```

## 3. Building

```
bash harfbuzz-wasm/vendor/fetch-vendor.sh --check     # VENDOR-CHECK-OK
bash harfbuzz-wasm/build-hbfont-wasm.sh               # BUILD-OK
bash harfbuzz-wasm/build-native.sh                    # NATIVE-BUILD-OK
```

HarfBuzz is compiled from its amalgamation `src/harfbuzz-subset.cc` as its release builds compile it (C++11,
`NDEBUG`), plus `HB_NO_MT` and `-fexceptions`; own code C++17 with `-Wall -Wextra -Werror`.

## 4. How a caller drives it

```
hbfont info       <in>                                               one JSON line
hbfont instance   --at TAG=V,... [--named N] [--downgrade-cff2] <in> <out>
hbfont transplant <colour-source> <outline-font> <glyph-map> <out>
hbfont version | help | error-ids
```

- **exit 0:** exactly one JSON line on stdout; the output file is complete.
- **exit 1:** one `hbfont: error: …` line, the last on stderr; no output file (a stale one is removed after the usage
  checks). **exit 2:** usage. On both the only stdout line is `{"ok":false,"v":1,"command":<command or null>,
  "error":"<id>"}`, the id one of `hbfont error-ids`' 26; a caller shows the id, never the message.
- **an abort** (the 1 GiB ceiling): `callMain` throws, `lastAbort()` is `"oom"`; the instance is dead.
- **`info`**: `{flavor, numGlyphs, variable: null | {axes [tag, min, default, max, name, hidden], instances [index,
  name, coordinates, postscriptName], stat}, colour {colr, cpal, svg, sbix, cbdt}}` — metadata only (P3b-13).
- **`instance`**: every fvar axis pinned (`not-variable`, `axis-unknown`, `axis-missing`, `axis-out-of-range`), values
  canonicalised to 16.16; HarfBuzz's instancer with everything kept, glyph ids retained, CPAL never subset, every
  GSUB/GPOS language system kept (patch 3), the overlap flags set on every outline glyph (OVERLAP_SIMPLE on a simple
  glyph's first point, OVERLAP_COMPOUND on a composite's first component: the instance keeps the variable font's
  overlapping contours), DSIG dropped; CFF2 downgraded to CFF with `--downgrade-cff2` (a font without CFF2 then fails,
  `instance-failed`), every charstring then within CFF1's 48 operands (patch 2; own check `cff1_check_stack`, else
  `output-invalid`; stem hints are not split, so a CFF2 stem operator over 48 operands is refused) and made
  name-keyed (HarfBuzz writes CID-keyed CFF; with one FD holding only its Private DICT, no subroutines and valid,
  unique post format 2 names, `cff_namekey.cc` writes the Top DICT without its CID entries, a String INDEX with the
  standard strings by their SIDs, charset format 0, CharStrings and the Private DICT byte for byte, and post format
  3; otherwise it stays CID-keyed and only its FontName changes). Then
  the names (§3.4 of the plan): F = nameID 16 else 1; S = the matching named instance's subfamily, else STAT (an exact
  nominal value first, else the first format-2 range holding the coordinate, bounds included; elidable values left
  out), else "<axis name> <value>" per axis off its default; nameIDs 1/2 (only Bold and Italic style-linked), 3, 4, 6
  (the instance's own PostScript name, else Adobe TN 5902's form, capped at 63 with an FNV-1a suffix), 16, 17, on
  Windows English and, where the font has them, Mac Roman and Unicode records, each other language of 1/16 rebuilt;
  fsSelection and macStyle; for CFF the FontName (only HarfBuzz's 5-byte offset operands are shifted;
  `cff-layout-unsupported` otherwise).
- **`transplant`**: the colour source (the font that entered FontForge), FontForge's output and `ffconv
  --glyph-map`'s map. The map is checked (`glyph-map-invalid`) and agrees with the fonts (`glyph-map-mismatch`: units
  per em, advances, cmap); HarfBuzz's plan with exactly the mapped glyphs and the map writes COLR, CPAL (never
  subset), sbix (padded to the outline font's glyph count), CBDT and CBLC; a glyph the colour tables reach that
  FontForge lost is `colour-glyph-unmapped`; the SVG table is renumbered by own code (`svg-unsupported-reference` for
  any glyph reference it does not rewrite); every other table of FontForge's font is kept byte for byte.

## 5. post.js surface

As fontwrap's: `FS`, `WORKERFS`, `NODEFS`, `callMain(args)` (a C++ exception becomes `Error('C++ Exception
[<type>]: <message>')`), `flushStderr()`, `heapBytes()`, `lastAbort()`, `mountFile`/`mountBlob`/`unmountFile`.
Test hooks: `selftest-oom`, `selftest-throw`, `selftest-cff-name <font> <name> <out>`, `selftest-hb-rewrite <font>
<out>`, `selftest-cff-stack <font>` (the downgrade's stack check alone), `selftest-cff-namekey <font> <out>` (the
name-keying alone), `selftest-cff-strings` (the 391 standard strings).

## 6. Testing

```
TZ=UTC node --no-maglev harfbuzz-wasm/test/test-hbfont-node.js            # N0-N6, N10-N12; HBFONT-NODE-OK
TZ=UTC HBFONT_ENGINE=native:harfbuzz-wasm/build/native/hbfont-asan node --no-maglev harfbuzz-wasm/test/test-hbfont-node.js
node harfbuzz-wasm/test/mutation-sweep.mjs harfbuzz-wasm/build/native/hbfont-asan                # HBFONT-SWEEP-OK
TZ=UTC node harfbuzz-wasm/test/test-hbfont-browser.cjs chromium|firefox|webkit|chrome           # one at a time
TZ=UTC node harfbuzz-wasm/test/make-oracle.mjs          # by hand, after an engine change: hbfont-oracle.json
```

- **N0** the harness's readers; **N1** the contract (exit shapes, the failure line, `error-ids`); **N2** `info`
  against fontTools' facts (`test/facts/`); **N3** `instance`: every spec static with the source's glyphs and cmap,
  every language system kept, every TrueType outline glyph flagged, a downgraded CFF within 48 operands and
  name-keyed with the source's post names, the hooks' boundary and fallback rows; **N4** names (pinned strings, the
  CFF FontName rewrite); **N5** `transplant` (structure, refusals); **N6** fail closed; **N10** memory (the ceiling,
  `selftest-oom`, peaks); **N11** glue and build; **N12** every `hbfont-oracle.json` entry reproduced byte for byte.
- **The oracle** (`make-oracle.mjs`, the web repo's judges): `#instance` entries by `judge_instance` (against
  fontTools' instance at the same coordinates: the scorer on copies without overlap bits, the flags and OTS on the
  delivered font, GDEF by glyph identity, shaping against the variable source, names); `#route` entries (FontForge's
  ttf/otf/svg of the instance with the app's argv: geometry against a control, fontTools' instance through the same
  ffconv, because FontForge approximates in every direction; coverage, advances, layout, sanitizer against the
  instance, an svg missing only U+FB00-U+FB06 and the code points XML cannot carry; `judge_layout`; the names after
  FontForge); `#transplant` entries by `judge_colour`.
- **The browser harness** compiles `hbfont.wasm` once per page and posts the module to a disposable worker per
  request; rows compare with node's bytes, prove the module posting and its fallback, abort at the ceiling and convert
  again, and draw seven transplanted fonts beside their sources (at most 3 % of inked pixels differing by more than
  64; a source the browser does not draw is n/a, never a pass), and print the browser-by-table matrix.

Results on 2026-11-19 (the committed build `c38fac72…`, after the web plan's closing review: duplicate table tags,
a colour glyph the map leaves out, an SVG internal DTD subset and a CFF INDEX offset past the table on wasm32 refused;
ffconv `828076bf…`; oracle definitions `P3b-2026-11-18-R8`; the oracle's 56 outputs byte-identical to `3f515cd8`'s):
`HBFONT-NODE-OK 464 passed, 0 failed`; `HBFONT-NATIVE-OK 447 passed, 0 failed, 2 n/a` (no sanitizer report);
`HBFONT-SWEEP-OK 5400 runs, 0 findings`; `HBFONT-BROWSER-OK 22/22` in Chromium 149, Firefox 151, WebKit 26.5 and
Chrome 157; `hbfont-oracle.json` 56 entries (25 instance, 17 route, 14 transplant), every judge passing. Peaks: `info`
on the 31 MiB variable font 64 MiB, its instance 126 MiB, the Bungee Color sbix transplant 92 MiB. A clean build in
a new folder reproduces the engine byte for byte.

Colour in the browsers (the transplanted font drawn beside its source):

| Table | Chromium / Chrome | Firefox | WebKit |
|---|---|---|---|
| COLRv0 (Twemoji; its CID-keyed CFF form) | colour | colour | colour |
| COLRv1 + SVG, variable (Nabla) | colour | colour | colour |
| CBDT (slick-cbdt) | colour | no colour (source too) | no colour (source too) |
| SVG (slick-svg, Bungee Color SVG) | no colour (source too) | colour | colour |
| sbix (slick-sbix) | no colour (source too) | no colour | no colour |
| sbix over CFF (Bungee Color sbix) | known limit: 94 % of inked pixels differ | not drawn | 46 % differ |

Known limits of the refusals: a colour glyph is recognised by HarfBuzz's readers (COLR layers or paint, a PNG in sbix
or CBDT), so a CBDT bitmap in another format than PNG left out of the map is not refused; name-keying a CFF2
instance with more than about 64,600 distinct non-standard glyph names would need string ids past 64,999 (no such
font is in reach to test; refusing them is left for later).

## 7. Findings

- **HarfBuzz's CFF2 downgrade overflowed CFF1's operand stack** (patch 2): curve operators kept CFF2's counts (a
  56-operand `rcurveline`); OTS and so browsers refused the font. Generalized as fontTools does; the own check
  `cff1_check_stack` refuses what remains (a stem operator over 48 operands: not split).
- **HarfBuzz's subsetter prunes a LangSys equal to its script's default** (patch 3, instances only).
- **The downgrade is CID-keyed** (Adobe-Identity-0): FontForge's CID flattening then drops GDEF mark-attachment
  classes and mark sets (all 96 of SourceSans3VF's). hbfont writes the font name-keyed where it can; FontForge's
  `CIDFlatten` itself is not patched (a CID-keyed upload to ttf loses them as production's does; a multi-FD CFF2
  instance stays CID-keyed). Recorded for the next phase.
- **Overlap flags:** an instance keeps overlapping contours, so hbfont sets OVERLAP_SIMPLE/COMPOUND (fontTools'
  default); FreeType 2.13.2 then supersamples, and four complex CJK glyphs of NotoSansSC-VF overflow its raster pool
  at 224 ppem and above. FontForge's TrueType output drops the flags.
- **FontForge approximates in every direction** (rounded cubic control points from quadratics; quadratics fitted to
  cubics), so its output is judged against FontForge's output of an independent instance, never against the
  instance's own outlines.
- **sbix over CFF** draws unlike its source in Chrome and WebKit: the app gives sbix sources no otf and no svg route;
  the engine keeps the capability (N5, the oracle).
- **Noto-COLRv1 has no otf transplant:** FontForge writes a 114,947-byte charstring, which `ffconv`'s result check
  refuses.
