# harfbuzz-wasm: vendored sources

`hbfont` links one third-party library, HarfBuzz, pinned to the 15.0.0 release archive by its sha256 and committed
here as a subset with no `.git` and no binary file. `vendor/fetch-vendor.sh` made the tree and proves it unchanged:

```
bash harfbuzz-wasm/vendor/fetch-vendor.sh --check     # VENDOR-CHECK-OK: every file equals the pinned archive's
```

The archive is read from `$HBFONT_TARBALLS` (default `harfbuzz-wasm/build/tarballs/`, not committed) and downloaded
there when missing.

## Pin (fetched 2026-11-18)

| Tree | Upstream | Pin | Archive sha256 | Licence | Taken |
|---|---|---|---|---|---|
| `vendor/harfbuzz/` | https://github.com/harfbuzz/harfbuzz | release `15.0.0`, `https://github.com/harfbuzz/harfbuzz/releases/download/15.0.0/harfbuzz-15.0.0.tar.xz` | `968536e9abd782f07f7954044c0c4020199fcdd39b41d221ec42d2a3be4a44df` | MIT ("Old MIT", `COPYING`) | `src/*.cc`, `src/*.hh`, `src/*.h` (top level), `src/OT/`, `src/graph/` |
| zlib (not vendored) | Emscripten port, `-sUSE_ZLIB=1` | 1.3.2 | (the emsdk cache) | Zlib | the native build compiles the port's own source, `emsdk/upstream/emscripten/cache/ports/zlib/zlib-1.3.2` |

The release archive is HarfBuzz's own `meson dist` of the 15.0.0 tag, so it carries the generated `hb-version.h`
that a GitHub source archive lacks. The build compiles one file of the subset, HarfBuzz's amalgamation
`src/harfbuzz-subset.cc` (the core, the shaper and hb-subset, which `#include`s the rest); the other top-level
sources (HarfBuzz's test programs, its optional backends) are present but not compiled. Left out of the subset:
`src/wasm/` (HarfBuzz's wasm shaper and its sample, which holds the archive's only binary file under `src/`,
`wasm/sample/c/test.ttf`), `src/rust/`, `src/ms-use/` (data the table generators read), the generator scripts,
`meson.build` and the `.pc.in`/`.cmake.in` templates, and everything outside `src/` (tests, test fonts, docs,
utilities). `fetch-vendor.sh` refuses a subset holding any file that `file` does not call text.

HarfBuzz is compiled as its release builds compile it, C++11 with `NDEBUG`, plus `HB_NO_MT` (no threads in this
build) and `-fexceptions` (own code's exceptions may cross its frames; the house rule). Both build scripts name the
compiled files explicitly.

`vendor/licenses/` holds `harfbuzz-COPYING` (from the archive) and `zlib-LICENSE` (from the emsdk port).

## Local changes

Each change to a vendored file is tagged `harfbuzz-wasm patch <n>` (so `grep -rn "harfbuzz-wasm patch"` lists them),
kept as a unified diff in `vendor/patches/` (applied in name order by `fetch-vendor.sh`, so `--check` proves the tree
equals upstream plus exactly these patches) and recorded here with its reason and its test.

| # | File | Change | Why | Test |
|---|---|---|---|---|
| 1 | `src/hb-serialize.hh` (`check_assign`), `patches/harfbuzz-0001-check-assign-float-range.patch` | A floating-point value is checked against `int`'s range before it is converted, then assigned as an integer and compared as before | `check_assign` detected overflow by assigning and comparing afterwards; converting a float outside the destination's range is undefined behaviour. The instancer met one adding an MVAR delta to an OS/2 field at 32767 (found by the mutation sweep, 2026-11-19: 1 of 5,400 runs, UBSan at `hb-serialize.hh:278`). Wasm happened to wrap the value; natively it was undefined | N6 "instance of SourceSans3VF with sxHeight 32767": red on the native UBSan build before the patch, green after (exit 1, `instance-failed`) |
| 2 | `src/hb-cff-specializer.hh` (`generalize_commands`), `patches/harfbuzz-0002-cff1-operand-stack.patch` | `rcurveline`, `rlinecurve`, `hhcurveto`, `vvcurveto`, `hvcurveto` and `vhcurveto` are broken into single `rlineto`/`rrcurveto` segments, as fontTools' `generalizeCommands` does, so the combining passes join them within CFF1's 48-operand stack | The CFF2-to-CFF1 downgrade kept those operators as the CFF2 charstring had them (CFF2 allows 513 operands): Twemoji-cff2-vf's instances carried a 56-operand `rcurveline`, which OTS (and so browsers) refuse ("Failed validating CharStrings INDEX"; found by `judge_instance`, 2026-11-19). Every outline is unchanged (SourceSans3VF 400 and 700, Twemoji-cff2-vf 400 and 700: 2,853 glyphs drawn equal to the unpatched output, all six operators exercised); the CFF grows about 5 % (the operators are not re-formed). Stem hints are not split: a stem operator over 48 operands stays, and hbfont's own output check refuses the font | N3 "every charstring within CFF1's 48-operand stack": red (deepest 56) before, green after; the own check (`cff1_check_stack`, N3's `selftest-cff-stack` rows at 48 and 49 operands) refuses what the patch does not cover |
| 3 | `src/hb-ot-layout-common.hh` (`hb_prune_langsys_context_t`, `Script::prune_langsys`), `src/hb-ot-layout-gsubgpos.hh` (`GSUBGPOS::prune_langsys`), `src/hb-subset-plan-layout.cc`, `patches/harfbuzz-0003-instance-keeps-language-systems.patch` | When every axis is pinned (an instance; `plan->all_axes_pinned`, false for any other subset, so `transplant` is unchanged), a LangSys equal to its script's DefaultLangSys is kept instead of pruned | The subsetter prunes such records (no flag turns it off). Shaping is the same (a missing LangSys falls back to the default), but an application that lists a font's language systems loses them, and fontTools' instancer keeps them: SourceSans3VF lost 16 of 38 records, NotoSansSC-VF 5 of 22 (found by `judge_instance`, 2026-11-19). Decided with Codex's read-only advice (keep the records; instancing only; the judge unchanged) | N3 "every GSUB and GPOS language system of the source, with its features" (`test/lib/layout.js`, independent of the engine): red on 6 specs before, green on all after; `judge_instance` on SourceSans3VF at 400 passes |
