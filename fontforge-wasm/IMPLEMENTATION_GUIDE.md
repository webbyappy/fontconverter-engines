# fontforge-wasm — Implementation Guide

`ffconv`: FontForge 20230101 as fontconverter.io's in-browser outline converter. TrueType outlines to CFF (ttf →
otf), CFF to TrueType (otf → ttf), either to an SVG font, and SVG fonts to ttf or otf, the way production's FontForge
20190801 does. It refuses the inputs section 4 lists (those FontForge cannot read, or would convert with a loss it
does not report) and never leaves a failed output behind. **GPL-3.0-or-later** (section 9). Plan and results:
`fontconverter-web/docs/audits/P2-FFCONV-PLAN-2026-11-17.md`.

## 1. At a glance

| | |
|---|---|
| Artifact | `output/ffconv.js` + `output/ffconv.wasm` (committed), `output/BUILD-INFO.txt` (flags, pins, patches, sha256) |
| Factory | `FFConv` (MODULARIZE, CommonJS-loadable, no ES6 export) |
| Size | `ffconv.wasm` 3,899,284 bytes (gzip -9 1,864,387, Brotli 11 1,411,059); `ffconv.js` 88,275 (24,214 / 21,483) |
| Interface | a command line through `callMain(argv)`, synchronous, **one conversion per instance**; MEMFS, WORKERFS, NODEFS |
| Memory | 32 MiB initial, **1 GiB maximum with `ABORTING_MALLOC=1`** (an allocation the ceiling refuses aborts the instance; `lastAbort()` says `"oom"`; fontconverter-web P3b plan, P3b-5), 5 MiB stack; no pthreads, no SIMD, no Asyncify; `-sGROWABLE_ARRAYBUFFERS=0` |
| Sources | `src/` (own: `main.c`, `sniff.c`, `no-subprocess.c`, `stable-qsort.c`), `vendor/` (FontForge, libxml2, GNU libiconv, PCRE2; pinned and checked, nine FontForge patches), GLib 2.78.6 from `libmirage-wasm/deps/` with two patches, FreeType and zlib as Emscripten ports. `VENDORING.md` lists every pin, licence and patch |
| Licence | GPL-3.0-or-later as a whole (`LICENSE`); component notices in `vendor/licenses/`; section 9 |

## 2. Layout

```
build-deps.sh            the libffi stub, GLib 2.78.6 (+PCRE2), libxml2, GNU libiconv as static wasm32 libraries in
                         build/wasm/stage (private Emscripten cache build/wasm/emcache, FreeType and zlib ports seeded)
build-ffconv-wasm.sh     FontForge (emcmake, headless) and the own sources; link into a fresh staging folder, glue
                         checks, then copy over output/ (BUILD_DIR, OUT_DIR, LINK_ONLY, EXTRA_LDFLAGS)
build-native.sh          the same FontForge and own sources under clang ASan/UBSan -> build/native/ffconv-asan
emscripten-crossfile.ini.in   meson cross-file template (rendered into build/)
requirements-build.txt   meson 1.10.2, setuptools 80.9.0 (GLib 2.78's gdbus-codegen needs distutils on Python 3.12)
deps/                    libffi-stub/ (the house stub GLib's configure needs; not linked), patches/glib-000{1,2},
                         seed_ports.py, meson_static_targets.py
post.js                  FS/WORKERFS/NODEFS/ENV, guarded callMain, flushStderr, heapBytes, mountFile/mountBlob/unmountFile
src/                     main.c (commands, contract, private folder, FontForge calls, hooks), sniff.c/.h (input and
                         result checks), no-subprocess.c (system() fails), stable-qsort.c (glibc's sort order)
vendor/                  fontforge/, libxml2/, libiconv/, pcre2/, licenses/, patches/, fetch-vendor.sh
test/                    test-ffconv-node.js (N0-N12), lib/, cases/, make-oracle.mjs, sniff-sweep.mjs,
                         test-ffconv-browser.{cjs,html}, test-ffconv-browser-worker.js
output/                  ffconv.js, ffconv.wasm, BUILD-INFO.txt
```

## 3. Building

```
bash fontforge-wasm/vendor/fetch-vendor.sh --check   # VENDOR-CHECK-OK: vendor/ = the pinned archives + vendor/patches
bash fontforge-wasm/build-deps.sh                    # DEPS-BUILD-OK; Emscripten 6.0.2 only; meson 1.10.2 in
                                                     #   ~/.venvs/fontforge-wasm-build (requirements-build.txt)
bash fontforge-wasm/build-ffconv-wasm.sh             # BUILD-OK; refuses any Emscripten but 6.0.2
BUILD_DIR=<dir> OUT_DIR=<dir> bash fontforge-wasm/build-deps.sh && \
  BUILD_DIR=<dir> OUT_DIR=<dir> bash fontforge-wasm/build-ffconv-wasm.sh   # a clean build elsewhere
bash fontforge-wasm/build-native.sh                  # NATIVE-BUILD-OK: the ASan/UBSan binary (Homebrew GLib 2.88.2)
```

Nothing is downloaded during a build: `fetch-vendor.sh` keeps the FreeType port archive in `build/tarballs/`
(emsdk's sha512 pin) and `seed_ports.py` seeds it and emsdk's zlib archive into each fresh cache. FontForge stamps
its configure time and git version into every font (`FFTM`); both are pinned (`SOURCE_DATE_EPOCH=1672531200`,
`-DFONTFORGE_GIT_VERSION=`). Two clean builds (fresh `BUILD_DIR`, fresh cache) gave the same sha256 as the committed
`ffconv.js`, `ffconv.wasm` and `BUILD-INFO.txt` on 2026-11-18. libgobject, libgmodule and libffi are built (GLib's
configure needs them) and not linked: FontForge references none of them.

## 4. How a caller drives it

```
ffconv convert [--allow-lossy] [--glyph-map <map.json>] <input> <output.ttf|output.otf|output.svg>
ffconv version | help | error-ids
```

- **Input:** a TrueType or CFF sfnt, or an SVG font. Refused, each with its own message: empty, WOFF, WOFF2, EOT,
  collections, Type 1, gzip, zip, unknown bytes, a damaged table directory, CFF2 (FontForge 20230101 cannot read it),
  fonts without outlines, inputs over 32 MiB; and, unless `--allow-lossy`, fonts with `fvar`, `COLR`, `CBDT`, `sbix`
  or `SVG ` tables (FontForge would drop what they carry). `fontwrap` (P1) unwraps WOFF, WOFF2 and EOT first.
- **exit 0:** exactly one JSON line on stdout:
  `{"ok":true,"input":{"kind","flavor","numGlyphs"},"output":{"format","bytes"},"cidFlattened":bool}`.
- **exit 1:** one `ffconv: error: …` line, the last on stderr (FontForge's own unprefixed diagnostics may come
  before it); no file at the output path, not even an earlier run's (if an earlier file cannot be removed, for
  example a directory of that name, the run stops there with exit 1 and leaves it).
- **exit 2:** `ffconv: usage error: …`; no file is touched (an unknown extension, input and output naming one file
  under any spelling, a second run on the same instance).
- **the failure line** (exit 1 and 2; fontconverter-web P3b plan, P3b-7): the only stdout line is
  `{"ok":false,"v":1,"command":<"convert" and the like, or null for an unknown command, never echoed>,"error":"<id>"}`,
  the id one of the 20 `ffconv error-ids` prints. The message stays on stderr; a caller shows the id, never the message.
- **`--glyph-map <map.json>`** (P3b-9; ttf and otf outputs, a usage error with svg): after the result check, the map
  `{"v":1,"keyedBy":"gid"|"cid","sourceGlyphs":N,"outputGlyphs":M,"map":[…]}` is written next to the font: for each
  source glyph (its glyph id, or its CID for a CID-keyed CFF font, FontForge's `orig_pos`) the id FontForge gave it in
  the output (`ttf_glyph`), or -1. It is checked before anything is written: injective, every id inside the output,
  `.notdef` staying 0 (`glyph-map-invalid`); an SVG input has no glyph ids (`glyph-map-unavailable`). Without the flag
  nothing changes: the font is the same bytes either way. `hbfont transplant` (`harfbuzz-wasm/`) reads it to put the
  colour tables `--allow-lossy` drops back into FontForge's output.
- **an abort** (the 1 GiB ceiling reached): `callMain` throws, `lastAbort()` is `"oom"` (`"abort"` for any other abort),
  the instance is dead (as after any run: one conversion per instance). `ffconv selftest-oom` (wasm only) proves it.
- FontForge never sees the caller's paths: it reads a symlink `input.<ttf|otf|svg>` named by the detected kind and
  writes `output.<ext>` in a private folder next to the output; the result is checked (magic, outline tables for the
  target, a complete `<font>` element for SVG; for .otf a bounded structural check of the CFF: every INDEX inside the
  table, and no charstring, global or local subroutine (per FD too) over the Type 2 limit of 65,535 bytes, P3b) and
  renamed into place. A failed check is exit 1, `output-invalid`, with no font and no glyph map.
- **Environment (set it, every time):** `SOURCE_DATE_EPOCH` (FontForge's clock: the `head` and `FFTM` dates it
  writes, and the creation date of a font made from SVG input; production's twin uses `1794873600`), `USER` (the SVG
  metadata's "By" line, and the author FontForge records; never `root`), `LANG=C.UTF-8` (otherwise the glue takes the
  worker's language). The SVG metadata's "Created by … at" line prints the source font's own modification date in
  local time: in wasm the time zone is the worker's (the JS `Date`'s), not `TZ`, and a browser offers no way to pin
  it, so a user outside UTC gets another date there than production's server (the generator line is an allowed
  difference, `svg-metadata-generator`). Observed in the browser harness (rows 18 to 20): slick.ttf → svg differs
  wherever a Tokyo zone reached the worker; slick.svg → ttf in Tokyo is identical; slick.ttf → svg with the worker's
  language German (WebKit only; other browsers' workers kept their own) is identical. No other pair ran outside UTC.

A classic worker (the shape P3 uses; the input goes into MEMFS, roadmap 4.3: FontForge seeks before almost every
read, which through WORKERFS costs seconds on large fonts):

```js
importScripts('/assets/ffconv/ffconv.js');            // a classic worker: no top-level await
let compiled = null;                                  // compile once, instantiate per conversion
self.onmessage = async (e) => {
  compiled = compiled || await WebAssembly.compileStreaming(fetch('/assets/ffconv/ffconv.wasm'));
  const out = [];
  const err = [];
  const M = await FFConv({
    print: (s) => out.push(s), printErr: (s) => err.push(s),
    preRun: [(m) => Object.assign(m.ENV, { SOURCE_DATE_EPOCH: '1794873600', USER: 'fontforge', LANG: 'C.UTF-8' })],
    instantiateWasm: (imports, done) => { WebAssembly.instantiate(compiled, imports).then((i) => done(i, compiled)); return {}; },
  });
  M.FS.mkdir('/in');
  M.FS.mkdir('/out');
  M.FS.writeFile('/in/input.otf', new Uint8Array(await e.data.file.arrayBuffer()));
  const rc = M.callMain(['convert', '/in/input.otf', '/out/output.ttf']);
  M.flushStderr();
  const bytes = rc === 0 ? M.FS.readFile('/out/output.ttf') : null;
  self.postMessage({ rc, result: rc === 0 ? JSON.parse(out[0]) : null, reason: err[err.length - 1] || null, bytes });
};                                                    // the instance is dropped: one conversion each (P2-6)
```

A fresh instance costs about 1 ms from the compiled module (median 1.09 ms over 51 in node). Memory: FontForge needs
25 to 65 times the input (S1 measured up to 55; P2 about 64 on both CJK fonts); the 5 MiB CID font converts to ttf in 1.5 s with a 344 MiB heap (N10).
`NotoSansCJKjp-Regular.otf` (16.5 MB, 65,535 glyphs), measured once in node: → svg in 5.6 s, heap 1,014 MiB, a 56.6 MB
SVG; → ttf fails closed after 3.1 s (heap 879 MiB): FontForge writes an empty file, as for the 65,534-glyph fixture
(N6), where production returns that empty file. Inputs anywhere near this size belong behind the web app's cap (D8).

## 5. post.js surface

| Symbol | What |
|---|---|
| `FS`, `WORKERFS`, `NODEFS`, `ENV` | live filesystem objects (`node test-nodefs-contract.js` proves them) and the environment FontForge reads |
| `callMain(args)` | synchronous; a C++ exception escaping main becomes `Error('C++ Exception [<type>]: <message>')` (ffconv is pure C: defence in depth); any other error is rethrown as the same object |
| `flushStderr()` | delivers a pending unterminated stderr line |
| `heapBytes()` | current linear memory size (it only grows: after a run, the peak) |
| `lastAbort()` | `null`, or why the runtime aborted: `"oom"` (it could not grow past the 1 GiB ceiling; Emscripten's message is exactly `OOM`), else `"abort"`. A caller's own `Module.onAbort` still runs |
| `mountFile(file, dir)`, `mountBlob(name, blob, dir)`, `unmountFile(dir)` | WORKERFS input (worker only) |

Test hooks in the shipped build (the tested build is the shipped build): `selftest-stderr`, `selftest-system`,
`selftest-sort`, `selftest-sniff <input>`, `selftest-check <file> <ttf|otf|svg>`, `selftest-oom` (P3b).

## 6. Testing

| Command | Passes when |
|---|---|
| `node test-nodefs-contract.js fontforge-wasm/output/ffconv.js <dir>` (in the repo root) | `OK: …FS/WORKERFS/NODEFS all live…` |
| `TZ=UTC node --no-maglev fontforge-wasm/test/test-ffconv-node.js` | `FFCONV-NODE-OK <n> passed, 0 failed, 1 known limits` |
| `TZ=UTC FFCONV_ENGINE=native:fontforge-wasm/build/native/ffconv-asan node --no-maglev fontforge-wasm/test/test-ffconv-node.js` | `FFCONV-NATIVE-OK … 1 known limits, 6 n/a`, no AddressSanitizer report, nothing in own sources |
| `node fontforge-wasm/test/sniff-sweep.mjs fontforge-wasm/build/native/ffconv-asan` | `FFCONV-SWEEP-OK 6000 runs, 0 findings` |
| `node fontforge-wasm/test/test-ffconv-browser.cjs chromium\|firefox\|webkit\|chrome` (one at a time) | `FFCONV-BROWSER-OK <browser> 17/17` |
| `TZ=UTC node fontforge-wasm/test/make-oracle.mjs [--out-root=<scratch>]` (by hand, after an engine change) | writes `ffconv-oracle.json`, or `.next.json` for review; refuses on any gate violation, a dirty `test/` or `output/`, or without `TZ=UTC` |

A native build with another patch set needs a fresh `BUILD_DIR` (`build-native.sh` refuses a tree copied with another
set): the build with patches 0001 to 0009 is `build/patches-0009/native/ffconv-asan` (`BUILD_DIR=fontforge-wasm/build/patches-0009`);
`build/native/` still holds the 0001 to 0005 build, `build/patches-0007/` and `build/patches-0008/` the 0001 to
0007 and 0001 to 0008 ones. N11 reads the `BUILD-INFO.native.txt` next to the binary it tests.

The node harness refuses to start unless `TZ=UTC`. Cases: N0 the harness's own readers and the gate's negative rows;
N1 contract; N2 the 68 op-table entries (exit, JSON line, sha256 and size as recorded, the source gate); N3 parity
with production (the recorded twin verdicts and `parity_diff.py` classes, plus live element, OS/2 and kerning rows);
N4 the baselines; N5 CID flattening; N6 fail closed (35 refusals by `convert` and by `selftest-sniff`, the
65,534-glyph font to ttf, `selftest-check`, usage errors, `--allow-lossy` on two variable TrueType fonts keeping
their GDEF glyph classes and mark glyph sets, and Source Sans 3 VF's otf with every GPOS device bit leading to a
device table); N7 no shell; N8 legacy Mac encodings; N9 file names; N10 three
malformed GDEF tables made in memory (converted or failed closed; natively with no AddressSanitizer report),
`generated/layout/slick-gpos-devices.ttf` -> otf keeping its 12 GPOS device tables for their own pairs and glyphs,
memory, time, one run per instance; N11 glue and build guards; N12 the recorded oracle; N13 the P3b contract (the
failure line and `error-ids`, `--glyph-map` on slick, Twemoji, Twemoji-cff and the sparse-CID Twemoji-cid checked
against advances and cmap, the 1 GiB ceiling and `lastAbort()`, the full NotoSansCJKjp to svg converting or aborting
`oom`). Fixtures and the oracle
(`ffconv-oracle.json`) are on `/Volumes/External/test-files/sample-font-files` (override `FONT_FIXTURES`); a missing
fixture fails loudly. The scorer and `parity_diff.py` are the web repo's (`fontconverter-web/tests/tools/`), called
only by `make-oracle.mjs`; the harness never runs Python. One heavy job at a time: never a browser run beside a
build, the native run, the sweep or the generator.

Results on 2026-11-19 (the committed build `828076bf…`, fontconverter-web P3b: the failure line, `--glyph-map`, the
1 GiB ceiling, the result check's CFF length validation; oracle definitions `P3b-2026-11-18-R8`):
`FFCONV-NODE-OK 713 passed, 0 failed, 1 known limits`; `FFCONV-NATIVE-OK 697 passed, 0 failed, 1 known limits, 7 n/a`
(no AddressSanitizer report, nothing in own sources, only section 8's UBSan lines); `FFCONV-SWEEP-OK 6000 runs, 0
findings` (the sweep now requires the failure line on exit 1); `FFCONV-BROWSER-OK 20/20` in Chromium 149, Firefox 151,
WebKit 26.5 and Chrome 157 (rows 21 to 23, the memory rows, red on the `3d4a05a3…` build, 18/20). A clean build in a
new folder reproduced the `c25a4a7b…` build byte for byte (the CFF check, added after it, changes only sniff.c).
The re-made `ffconv-oracle.json` keeps the 68 outputs byte for byte; one verdict changed under the scorer's R7 and was
adopted with `--rebaseline` after review: Font Awesome Solid's otf to ttf fails `layout` because its combining marks
are an empty glyph that HarfBuzz positions by fallback in the source (no GDEF or GPOS) but not in FontForge's ttf (GDEF
and a GPOS with no lookups, as production's): nothing visible, but section 8 records the general effect. The full
NotoSansCJKjp to svg converts under the ceiling at a heap of 1,062,862,848 bytes.

Results on 2026-11-18 (the committed build `3d4a05a3…`, patches 0001 to 0009, against the oracle made for it, whose 68
outputs are byte-identical to the `d8270ec2…` build's, and font-oracle.json with 162 fixtures):
`FFCONV-NODE-OK 663 passed, 0 failed, 1 known limits`; `FFCONV-NATIVE-OK 651 passed, 0 failed, 1 known limits, 6 n/a`
with `build/patches-0009/native/ffconv-asan` (native reproduces every recorded output byte for byte; no
AddressSanitizer report, nothing in own sources, only section 8's UBSan reports); `FFCONV-SWEEP-OK 6000 runs, 0
findings` on that binary; `FFCONV-BROWSER-OK 17/17` in Chromium 149, Firefox 151, WebKit 26.5 and installed Chrome 157.
Node counts by build: `d8270ec2…` 653 and 641; 0006 and 0007 (3 rows in N6, 4 in N10) 660 and 648; 0008 (1 in N6),
0009 (1 in N10) and its fixture (1 in N0) 663 and 651. A planted `-sGROWABLE_ARRAYBUFFERS=1` glue failed 3/17 in all four on the
`d8270ec2…` build (not re-run; `ffconv.js` is unchanged since, sha256 `970e853c…`). Known limit (both builds):
`--allow-lossy` cannot help a CFF2 font (exit 1). The browser harness launches every browser with `TZ=UTC` and
requires a worker that reports UTC: Playwright's `timezoneId` does not reach a Firefox worker.

## 7. What is verified, per pair

**Judges.** The web repo's scorer (fontTools, the OpenType Sanitizer, FreeType, HarfBuzz) against the bytes `ffconv`
was given (N2, N4) and against the production twin's output for the same upload and target (N3); `parity_diff.py`,
which compares two fonts table by table (decoding `cmap`, `OS/2`, `head`, `GDEF`, `GSUB`, `GPOS`, `name`, `post`,
`CFF`) or two SVG fonts element by element, and names each difference (N3); the production twin itself (FontForge
20190801 as production runs it; amd64 is the reference wherever arm64 and amd64 differ, because production runs on
x86-64 (P2-14) and equalled the amd64 twin on the one CFF → ttf conversion D15 measured; 6 entries: 5 CFF → ttf and
`fa-solid-900.ttf` → otf, where arm64 draws one glyph's charstring differently). All of it recorded in `ffconv-oracle.json` (68 entries: 66 judged against production, 2 against their
source only) and reproduced by N2 to N4 and N12.

**Allowed differences from production** on every pair: `FFTM` bytes and the `head` checksum (build and conversion
stamps), `cmap` re-encoded with equal mappings, GSUB/GPOS feature records in another order, the SVG generator line.
Allowed only where the source font backs them (`parity_diff.py --source`; the owner's decisions of 2026-11-18):
`GDEF-class-as-source` (FontForge 20230101 keeps the source's glyph classes; 20190801 invented base and ligature
classes), `cmap-source-alias-kept` and `svg-source-mapping-kept` (an extra mapping the source has to the same glyph: CID
fonts keep every code point the source maps, where 20190801 kept one; the alias fixtures keep their sequence
elements and the elements those carried), `cmap-uvs-default-kept` and `svg-uvs-text-corrected` (variation sequences, below),
`svg-empty-duplicate-omitted` (production writes a second, empty `.notdef` element). On CFF → TrueType also `glyf`,
`loca`, `hmtx`, `maxp` bytes, judged by the scorer's shapes and advances.

| Pair | Entries | Verified | By | Not verified, known limits |
|---|---|---|---|---|
| TrueType → otf | 24 (23 against production) | parses, sanitizer, every outline, advance and mapping as production's (ink box 0); only the allowed differences; native and four browsers give the same bytes | N2, N3, N4, N12; browsers rows 1, 5, 6, 10, 11 | TrueType hinting is not carried into CFF (as in production); a legacy `kern` table becomes GPOS (Vera); production's composite-glyph displacement is inherited (Univers sample: 32 glyphs fail the outline check against the source, 17 by over a pixel; baseline N4); names rewritten. A TrueType font named `.otf` is converted (production returns that upload unchanged: P3's planner decides) |
| TrueType → svg | 24 (all against production) | every element production writes, in the same form, with the same paths and kerning; no repeat production lacks | N2, N3 (live element, kerning and OS/2 rows), N4, N12; rows 3, 7, 9 | **SVG fonts lose what production's lose:** a glyph that is the result of a ligature is written once, under its ligature string, so its own code points get no element (OpenSans and the fonts derived from it: U+FB00-FB04); code points XML 1.0 cannot carry (U+0000, controls) have no element; DejaVu's Arabic forms repeat 117 code points, as production's do. Kerning is written for each glyph's primary code point only (P8). The scorer's SVG reading is limited (section 8) |
| CFF → ttf | 8 (7 against production, the amd64 twin on 5) | shapes, advances and mappings as production's amd64 build; CID-keyed fonts flattened with every glyph | N2, N3, N4, N5, N12; row 2 | the 65,534-glyph font fails closed for ttf, after FontForge has run (its 65,535 limit; production returns an empty file), so P3's planner must refuse it up front: N6. Point data: our `glyf` bytes differ from production's amd64 output on 3 of 7 (the arm64 and amd64 builds differ too, S5 6.5); shapes equal amd64's within the scorer's tolerance. Against the source, production's rounding is inherited (baseline N4): outline failures on Font Awesome desktop 495 glyphs (1 over a pixel), Source Sans 34 and 17, the 5 MiB CID font 42, OpenSans 2. The 5 MiB CID font is judged against its source only (the twin's amd64 emulation limit); it keeps its mark-positioning lookups only because of fontforge-0004 |
| CFF → svg | 8 (all against production) | as TrueType → svg; CID fonts keep the code points production drops | N2, N3, N5, N12; row 8 | as TrueType → svg, where ligature-result glyphs lose the most: Font Awesome desktop 1,947 code points, Source Sans U+FB00, OpenSans.otf U+FB00-FB04 (production's SVGs lack the same). SVG fonts of 65,533 or more glyphs: the scorer cannot load them (ours or production's), so `parity_diff.py` judges alone |
| SVG → ttf, otf | 4 (all against production) | as production, each entry under one of two named exceptions | N2, N3, N12; row 4 (→ ttf only; no browser row converts SVG → otf) | `slick.svg`: OS/2 typo ascender and descender differ from production (S3 5.4); `OpenSans-Regular.svg`: `ulUnicodeRange3` 32 → 40 (20230101 ends Arabic Presentation Forms-B at U+FEFF, as the OpenType spec says). Fonts made from SVG carry the conversion time (`SOURCE_DATE_EPOCH`) |
| Mac-Roman-only fonts | 2 (counted above) | the pinned mappings | N3 (exceptions), N8 | alias code points come from GNU libiconv's MACINTOSH table (production: glibc's): ffconv maps U+00A4 to `currency` where production maps U+E01E to `apple` |
| Variable TrueType → otf (`--allow-lossy`) | none in the oracle (N6: 2 fonts) | a static CFF font of the default master that keeps the source's GDEF glyph classes (counted per class) and mark glyph sets (fontforge-0006; before it, none: HarfBuzz then left a second stacked mark unpositioned), and a GPOS whose device bits all lead to device tables (fontforge-0008; before it, Source Sans 3 VF's otf had 1,708 offsets into unrelated bytes and the OpenType Sanitizer rejected GPOS, as it rejects production's) | N6 | the variations are dropped (what `--allow-lossy` accepts); outlines, advances and mappings are not scored, and nothing is compared with production; CFF2 input cannot be read at all (the known limit) |
| Refused input | 35 inputs | every refusal of section 4 (empty, 12 truncations, random bytes, zip, gzip, WOFF, WOFF2, EOT, collection, Type 1 PFB and PFA, an XML file without `<font>`, CFF2, `fvar`, `COLR`, `CBDT`, `sbix`, `SVG `, over 32 MiB, damaged directories, no outlines), each by `convert` and by `selftest-sniff`, with no output | N6, N7, the sweep, rows 12, 13 | a Mac `typ1` sfnt has no fixture; a font FontForge reads but damages in other ways is not detected (P8) |

**Deliberate departures from production** (in the user's favour, decided by the owner on 2026-11-18): variation
sequences whose base is not the glyph's primary code point are kept (production's FontForge drops them), and an SVG
sequence element is written as base + selector and no longer hides the glyph's ordinary elements (fontforge-0003); CID
fonts keep every code point the source maps (production keeps one); the CID master's anchor classes survive
flattening, so mark positioning is kept (fontforge-0004; production drops it).

## 8. Findings and limits

- **FontForge writes CFF programs over 65,535 bytes for very complex glyphs** (P3b): 114,947 bytes for a glyph of
  Noto-COLRv1 (production's twin output has the same glyph), 182,003 for a 30,000-segment SVG glyph. OTS refuses such
  a font, and so do Chromium's and Firefox's font loaders (WebKit loads it). The result check now refuses it
  (`output-invalid`); splitting such glyphs into subroutines would be the repair (not done).

- **An empty GPOS turns off HarfBuzz's fallback mark positioning** (found by the scorer's R7, P3b). FontForge writes
  GDEF and a GPOS with no lookups for a font that had neither (production's FontForge does too). HarfBuzz positions
  combining marks by their Unicode classes only when a font has no GPOS, so a font relying on that fallback loses it.
  Seen only on Font Awesome Solid, whose marks are an empty glyph (nothing visible); a P8 candidate.

**FontForge patches** (`vendor/patches/`, `VENDORING.md`): 0001 a typed `fputc` callback (the PostScript, EPS and PDF
writers trapped in wasm); 0002 production's `cmap` primary code point (20230101 regressed: repeated SVG elements,
other OS/2 first and last characters, CFF blue zones, generated names, kerning and ligature strings); 0003 SVG
variation sequences (above); 0004 `CIDFlatten` keeps the anchor classes (a heap use-after-free when the flattened font
was written, and lost mark lookups); 0005 the script table's terminator (`ScriptFromUnicode` read past the Arabic
row); 0006 GDEF version 1.3 is read (a variable font's otf kept no glyph class or mark glyph set); 0007 three bounds
checks in the GDEF and ClassDef readers (malformed fonts wrote past a heap array, a trap in wasm, or into `malloc(0)`,
or read past a coverage array; N10 builds each in memory); 0008 GPOS device tables: a VariationIndex table (DeltaFormat
0x8000) is read as none, without an error, and the kerning-pair writer sets a device bit only for a table it writes
(a variable font's otf had device offsets into unrelated bytes, which the OpenType Sanitizer rejects); 0009 GPOS
device tables where OpenType puts them: a PairPosFormat1's device offsets are read and written from the PairSet, not
the subtable (conforming fonts' tables were read at the wrong place and dropped or taken from unrelated bytes, and
the tables FontForge wrote were misread by every other reader), and single positioning writes each glyph's own tables
(it wrote the first glyph's for every glyph, through a NULL pointer when the first had none: native SEGV). A font
FontForge wrote earlier with format-1 pair device tables is now read as OpenType says, not as FontForge wrote it.
GLib: 0001 no `res_query()` check, 0002 no `-pthread` (atomics in a module without threads). Own:
`no-subprocess.c` (`system()` fails with `ENOSYS`), `stable-qsort.c` (glibc 2.31's merge sort: FontForge's
comparators let distinct records tie, and musl, macOS and glibc broke the ties differently, reordering GSUB/GPOS
records and table directories).

**Native ASan/UBSan run** (final engine, every case): no AddressSanitizer report, nothing in own sources. FontForge
UBSan reports, none of which changes an output (native == wasm byte for byte): signed left shifts in `mem.c:90/106`,
`psread.c:3678`, `tottf.c:555/613/3112/3257`; and in `autohint.c:1311/1314` (`SCGuessHintPoints`) a negative
coordinate assigned to `unsigned val` while the 5 MiB CID font's charstrings are read: undefined behaviour that both
builds saturate to 0; PostScript hint instances reach no TrueType or SVG output. Recorded, not fixed (P2-16).

**The scorer's SVG limits** (its revision R6 is proposed for P3 or P8): its structure check refuses legitimate repeated
code points (Arabic forms); its SVG loader keeps only the first element of a glyph name for named kerning, so equal
files can score differently; selection attributes are dropped; it cannot load an SVG font of 65,533 or more glyphs.
For SVG outputs N3 uses the scorer for outlines and advances only and `parity_diff.py` for the rest.

**FontForge's faults inherited from production** (P8 may improve them): the SVG writer's ligature handling and
primary-only kerning (above), composite displacement on fonts whose outlines are not at their left side bearing,
hinting lost on every outline change, names rewritten.

## 9. Licence (GPL)

`ffconv` (`output/ffconv.js` and `output/ffconv.wasm`) is **GPL-3.0-or-later**: it links FontForge, which is
GPL-3.0-or-later as a whole (most of its files BSD-3-Clause), with GLib and GNU libiconv (LGPL-2.1-or-later), PCRE2
(BSD-3-Clause with its exception), libxml2 (MIT), FreeType (FTL) and zlib (Zlib), and the toolchain's runtime: musl
(MIT), compiler-rt and libc++abi (Apache-2.0 with LLVM exception), the Emscripten JS runtime (MIT/NCSA), dlmalloc
(CC0). Notices in `vendor/licenses/` (the site's licences page, D2, must carry them), the GPL text in `LICENSE`. Its corresponding source is this folder (own sources, the vendored trees with their patches,
the build scripts) plus the archives `VENDORING.md` lists (GLib 2.78.6, the FreeType 2.13.3 and zlib 1.3.2 port
archives) and the Emscripten version in `BUILD-INFO.txt`. Whoever distributes the artifact must offer that source:
the owner's public repository (roadmap decision D2: a public GitHub repository, named by the owner) mirrors it before
P5 ships the file. `deps/libffi-stub/` is the owner's own code and is not linked into the artifact. `ffconv` is its own
file, never linked with `fontwrap`.

## 10. Troubleshooting

- `FFCONV-NODE-FAIL … N2/N12 …` after a rebuild: an output changed. Run `make-oracle.mjs`, review
  `ffconv-oracle.next.json`, move the old file to `ffconv-oracle.<date>.json`, the new one into place.
- A browser fails with "The provided ArrayBuffer value must not be resizable": the glue was linked without
  `-sGROWABLE_ARRAYBUFFERS=0`; the build script and N11 refuse such glue.
- Outputs differ between runs: `SOURCE_DATE_EPOCH`, `USER`, `LANG` or the time zone was not pinned (section 4).
- A harness run hangs inside node 23: run with `--no-maglev`.
