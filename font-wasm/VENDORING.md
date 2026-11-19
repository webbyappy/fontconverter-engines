# font-wasm: vendored sources

Every third-party source linked into `fontwrap` is pinned by commit and by the sha256 of GitHub's archive of that
commit, and committed here with no `.git`. `vendor/fetch-vendor.sh` made these trees and proves them unchanged:

```
bash font-wasm/vendor/fetch-vendor.sh --check     # VENDOR-CHECK-OK: every file equals the pinned archive's
```

Archives are read from `$FONTWRAP_TARBALLS` (default `font-wasm/build/tarballs/`, not committed) and downloaded
there when missing; the spike's verified copies live in
`/Volumes/External/test-files/sample-font-files/research-2026-11-17/S2/vendor/tarballs/`.

## Pins (fetched 2026-11-17)

| Tree | Upstream | Pin | Archive sha256 | Licence | Taken |
|---|---|---|---|---|---|
| `vendor/brotli/` | https://github.com/google/brotli | tag `v1.2.1` = `db24a98aed38a16de78cc05ca15cdd8dc2a0d92d` | `113b9685dfc14dd2f3360d077283266eec2fbdfb0fe3e5600f11be151da0d68e` | MIT | `c/common`, `c/dec`, `c/enc`, `c/include` |
| `vendor/woff2/` | https://github.com/google/woff2 | master `7b67e12355fe7da148db5c19d4261f0a498a9537` (2026-10-28, v1.0.2 + 15 commits) | `af25f87356507cd541fe02eb52145ce21d0a62b2ef028c058720ecf96ad4d7f8` | MIT | `include`, `src` |
| `vendor/libeot/` | https://github.com/umanwizard/libeot | tag `v0.0.3` = `dfd394c8fbb2c2bc43bb844f058d48a4ef9479e2` | `53f7f2250eff58c8e9b2881d8162cca1a25deba09dd638ea51039257df490f1c` | MPL-2.0 | `inc`, `src` |
| zlib (not vendored) | Emscripten port, `-sUSE_ZLIB=1` | 1.3.2 | (the emsdk cache) | Zlib | the native build compiles the port's own source, `emsdk/upstream/emscripten/cache/ports/zlib/zlib-1.3.2` |

Whole upstream source directories are taken, so a few files are present that the build does not compile (woff2's
command-line tools and fuzzers, libeot's `eot2ttf.c` and `trans_trip.py`, Brotli's `static_init_lazy.cc`). The build
scripts name every compiled file explicitly.

Why woff2 master and not its 2017 tag v1.0.2: master adds the `overlapSimpleBitmap` of the `glyf` transform (keeps
the OVERLAP_SIMPLE flag variable fonts use), a 32-bit wrap-around fix in the bounds checks (wasm is 32-bit), a
monotonicity check on `endPtsOfContours` and the move to Brotli 1.2.1 (spike S2, section 3).

`vendor/licenses/` holds `brotli-LICENSE`, `woff2-LICENSE`, `libeot-LICENSE`, `libeot-PATENTS` (copied from the
archives) and `zlib-LICENSE` (from the emsdk port). libeot is MPL-2.0, a file-level copyleft: whoever ships the wasm
makes the source of these libeot files (and any change to them) available. Its `PATENTS` file relies on the patent
grants of the W3C EOT submission.

## Local changes

Each change to a vendored file is tagged `// font-wasm patch <n>` (so `grep -rn "font-wasm patch"` lists them), kept
as a unified diff in `vendor/patches/` (applied in name order by `fetch-vendor.sh`, so `--check` proves the trees equal
upstream plus exactly these patches) and recorded here with its reason and its test.

| # | File | Change | Why | Test |
|---|---|---|---|---|
| 1 | libeot `src/ctf/parseCTF.c` (`parseCTF`), `patches/libeot-0001-reserve-loca-slot.patch` | Reserves `numTables + 1` table slots instead of `numTables` | When the decompressed font has `glyf` but no `loca`, `parseCTF` adds a `loca` table to a full array; `addTable` reallocates it while `head`, `maxp` and `hmtx` still point into the old one, and `TTFParseHead` reads freed memory. Found by the P1 mutation sweep (2 of 20,623 runs, ASan heap-use-after-free at `parseTTF.c:16`); wasm read the freed block silently. Only `parseCTF` calls `addTable` | N8 "sweep finding (mutant 1/2)": red on the native ASan build before the patch, green after |

## Upstream limits found (recorded, not patched)

From spike S2 (section 4.6) and P1's measurements. P1 patches libeot only for memory safety (above); its limits stay.

| # | Where | What | Effect in fontwrap |
|---|---|---|---|
| 1 | libeot `src/ctf/parseCTF.c`, `populateGlyfAndLoca` | Reserves numGlyphs × worst-case glyph size up front, unchecked | MTX decode of Noto COLRv1 needs 2,789 MiB, more than the 2 GiB wasm heap: exit 1 (a known limit). The largest MTX fixture that decodes needs 92 MiB |
| 2 | libeot `parseCTF` | Skips `hdmx` and `VDMX` ("will be fixed in a future release") | An MTX-decoded font lacks them (a known limit) |
| 3 | libeot `writeFontBuffer` | Does not check its `malloc` | Reached only for MTX; the result must parse as an sfnt before anything is written |
| 4 | libeot LZCOMP / Huffman | `assert()` as error handling | `main.cc` turns `__assert_fail` / `__assert_rtn` into a clean exit 1 |
