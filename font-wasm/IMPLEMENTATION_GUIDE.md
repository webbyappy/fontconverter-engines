# font-wasm — Implementation Guide

`fontwrap`: lossless font container conversions for fontconverter.io's in-browser converter. TTF/OTF to and from
WOFF 1.0 and WOFF 2.0, TTF to EOT and EOT back, without changing the font's data; it fails closed on bad input. Plan
and results: `fontconverter-web/docs/audits/P1-FONTWRAP-PLAN-2026-11-17.md`.

## 1. At a glance

| | |
|---|---|
| Artifact | `output/fontwrap.js` + `output/fontwrap.wasm` (committed), `output/BUILD-INFO.txt` (flags, pins, sha256) |
| Factory | `FontWrap` (MODULARIZE, CommonJS-loadable, no ES6 export) |
| Size | `fontwrap.wasm` 842,073 bytes (gzip -9 298,400, Brotli 11 222,247); `fontwrap.js` 81,202 (21,947 / 19,430) |
| Interface | a command line through `callMain(argv)`, synchronous; MEMFS, WORKERFS, NODEFS |
| Memory | 64 MiB initial, **1 GiB maximum with `ABORTING_MALLOC=1`** (an allocation the ceiling refuses aborts the instance; `lastAbort()` says `"oom"`; fontconverter-web P3b plan, P3b-5), 8 MiB stack; no pthreads, no SIMD, no Asyncify |
| Licences | own code; Brotli and google/woff2 MIT; libeot MPL-2.0 (its source, with `vendor/patches/`, must be made available with the wasm); zlib (Emscripten port) Zlib. Texts in `vendor/licenses/`. Its own artifact, never linked with the GPL FontForge engine |
| Sources | `src/` (own), `vendor/` (pinned and checked; one local libeot patch, see `VENDORING.md`) |

## 2. Layout

```
build-font-wasm.sh   wasm build (Emscripten 6.0.2 only; fresh staging folder per link; glue checks; no rm)
build-native.sh      the same sources under clang ASan/UBSan -> build/native/fontwrap-asan (not committed)
post.js              FS/WORKERFS/NODEFS, guarded callMain, flushStderr, heapBytes, mountFile/mountBlob/unmountFile
src/                 main.cc (command line, result contract), sfnt.*, woff1.*, woff2_wrap.*, eot.*, info.*,
                     common.h, version.h, selftest_assert.c (test hook)
vendor/              brotli/, woff2/, libeot/, licenses/, patches/, fetch-vendor.sh
test/                test-font-node.js (N0-N12), lib/, cases/, make-oracle.mjs, mutation-sweep.mjs,
                     test-font-browser.{cjs,html}, test-font-browser-worker.js
output/              fontwrap.js, fontwrap.wasm, BUILD-INFO.txt
```

## 3. Building

```
bash font-wasm/build-font-wasm.sh                 # sources emsdk if needed; refuses any Emscripten but 6.0.2
BUILD_DIR=<dir> OUT_DIR=<dir> bash font-wasm/build-font-wasm.sh    # a clean build elsewhere (reproducibility)
bash font-wasm/build-native.sh                    # the ASan/UBSan binary
bash font-wasm/vendor/fetch-vendor.sh --check     # VENDOR-CHECK-OK: vendor/ equals the pinned archives plus vendor/patches
```

Two clean builds give the same sha256 for both files and for `BUILD-INFO.txt` (`-ffile-prefix-map`, no dates or
absolute paths in `BUILD-INFO.txt`, which also lists the vendored pins and patches); checked on 2026-11-17 against the
committed output.

## 4. How a caller drives it

```
fontwrap info          <in>                one JSON line: container, flavour, numGlyphs, tables, EOT header fields
fontwrap woff-encode   <in> <out>          sfnt -> WOFF 1.0 (zlib 9)            [--strict]
fontwrap woff-decode   <in> <out>          WOFF 1.0 -> sfnt                     [--strict]
fontwrap woff2-encode  <in> <out>          sfnt or collection -> WOFF 2.0       [--quality=0..11] (default 11)
fontwrap woff2-decode  <in> <out>          WOFF 2.0 -> sfnt or collection
fontwrap eot-encode    <in> <out>          TrueType sfnt -> EOT 0x00020002      [--allow-cff] [--strict]
fontwrap eot-decode    <in> <out>          EOT (plain, XOR or MTX) -> sfnt      [--strict]
fontwrap version | help | error-ids
```

`--max-output-bytes=N` (1 to 536,870,912) on the three decoders refuses a font that would decode to more than N bytes
with the id `output-limit`: before allocating, where the header states the size (WOFF `totalSfntSize`, WOFF2's
declared total, a plain or XOR EOT's `FontDataSize`; WOFF2's output sink is also capped at N), and after the decode
for an MTX EOT (libeot's own reservation is bounded by the ceiling). The app passes its ask threshold or its
try-anyway limit (fontconverter-web P3b plan, P3b-8).

- **exit 0**: exactly one JSON line on stdout, `{"ok":true,"command":…,"flavor":…,"ext":…,"inSize":…,"outSize":…}`;
  `woff2-encode` adds `quality`; `eot-decode` adds `compression` (`none|xor|mtx`) and `decoder` (`fontwrap|libeot`).
  `ext` is the extension the output needs (an EOT or WOFF does not say). `info` prints its object with `"ok":true`.
- **exit 1**: bad input or a failed conversion; one `fontwrap: error: …` line on stderr; no output file, not even an
  earlier run's (a stale file at the output path is removed after the usage checks).
- **exit 2**: usage error (`fontwrap: usage error: …` and the usage); no file is touched. Input and output naming
  the same file is a usage error under any spelling (`a.ttf` and `./a.ttf`, a hard link): the files are compared by
  device and inode before anything is removed.
- **the failure line** (exit 1 and 2; fontconverter-web P3b plan, P3b-7): the only stdout line is
  `{"ok":false,"v":1,"command":<the command, or null for an unknown one, never echoed>,"error":"<id>"}`. The id is
  one of the 27 `fontwrap error-ids` prints (`{"ok":true,"v":1,"command":"error-ids","ids":[…]}`); the message stays
  on stderr and may hold bytes from the font, so a caller shows the id, never the message.
- **an abort** (the 1 GiB ceiling reached): `callMain` throws, `lastAbort()` is `"oom"` (`"abort"` for any other
  abort), and the instance is dead; the caller makes a fresh one. `fontwrap selftest-oom` (wasm only) proves the path.
- `flavor` names the outlines by the tables, as `info` does (`truetype`, `cff`, `cff2`, `collection`); a decoded
  font's `ext` follows it (`otf` for CFF and CFF2), whatever the sfnt version word says.
- Warnings (`fontwrap: warning: …`) never change the exit code: a wrong table checksum or a non-canonical layout is
  converted losslessly with a warning; `--strict` refuses instead. One stderr line is not fontwrap's: an MTX decode
  that drops `hdmx` or `VDMX` prints libeot's own `Ignoring hdmx/VDMX table -- will be fixed in a future release.`
  (exit 0).

A classic worker (the shape P3 uses):

```js
importScripts('/assets/fontwrap/fontwrap.js');          // a classic worker: no top-level await
self.onmessage = async (e) => {
  const out = [];
  const err = [];
  const M = await FontWrap({ locateFile: (p) => '/assets/fontwrap/' + p, print: (s) => out.push(s),
    printErr: (s) => err.push(s) });
  M.FS.mkdir('/out');
  const input = M.mountFile(e.data.file, '/in');         // WORKERFS: the upload is read, never copied whole
  const rc = M.callMain(['woff2-encode', '--quality=11', input, '/out/font.woff2']);
  M.flushStderr();
  const bytes = rc === 0 ? M.FS.readFile('/out/font.woff2') : null;
  M.unmountFile('/in');
  self.postMessage({ rc, out, err, bytes });
};
```

One instance serves many conversions (N10: 140 calls, identical bytes, stable heap); memory never shrinks, so after a
large WOFF2 encode a fresh instance is cheaper to keep around. WOFF2 quality by size (roadmap 4.6): 11 up to 2 MiB,
10 up to 8 MiB, 9 above. Measured in node on the first build (`2d762218`; the WOFF2 path is unchanged since and
every output byte-identical): NotoSansCJKjp-Regular.otf (16.5 MB) encodes in
64.1 s at quality 11 (11,440,352 bytes, heap 170 MiB) and in 4.3 s at quality 9 (12,551,576 bytes, 9.7 % larger,
heap 141 MiB).

## 5. post.js surface

| Symbol | What |
|---|---|
| `FS`, `WORKERFS`, `NODEFS` | live filesystem objects (`node test-nodefs-contract.js` proves them) |
| `callMain(args)` | synchronous; a C++ exception escaping main becomes `Error('C++ Exception [<type>]: <message>')` with `.cppType`; any other error is rethrown as the same object |
| `flushStderr()` | delivers a pending unterminated stderr line |
| `heapBytes()` | current linear memory size |
| `lastAbort()` | `null`, or why the runtime aborted: `"oom"` (it could not grow past the 1 GiB ceiling; Emscripten's message is exactly `OOM`), else `"abort"`. A caller's own `Module.onAbort` still runs |
| `mountFile(file, dir)`, `mountBlob(name, blob, dir)`, `unmountFile(dir)` | WORKERFS input (worker only) |

## 6. Testing

| Command | Passes when |
|---|---|
| `node test-nodefs-contract.js font-wasm/output/fontwrap.js <dir>` | `OK: output/fontwrap.js — FS/WORKERFS/NODEFS all live; …` |
| `node --no-maglev font-wasm/test/test-font-node.js` | `FONTWRAP-NODE-OK <n> passed, 0 failed, 2 known limits` |
| `FONTWRAP_ENGINE=native:font-wasm/build/native/fontwrap-asan node --no-maglev font-wasm/test/test-font-node.js` | `FONTWRAP-NATIVE-OK … 2 known limits`, no sanitizer report |
| `node font-wasm/test/mutation-sweep.mjs font-wasm/build/native/fontwrap-asan` | `FONTWRAP-SWEEP-OK 20623 runs, 0 findings` |
| `node font-wasm/test/test-font-browser.cjs chromium\|firefox\|webkit\|chrome` (one at a time) | `FONTWRAP-BROWSER-OK <browser> n/n` |
| `node font-wasm/test/make-oracle.mjs` (by hand, after an engine change) | writes `fontwrap-oracle.json` or `.next.json` for review |

Cases: N0 the harness's own readers (against fontTools and sfntly), N1 contract, N2 `info` for all 187 fixtures, N3
WOFF, N4 WOFF2, N5 decoding other tools' WOFF/WOFF2, N6 EOT, N7 production parity, N8 bad input, N9 variable, colour,
CJK and collections, N10 instance reuse and file names, N11 glue guards and hooks, N12 the 201 recorded outputs and
their independent verdicts, N13 the P3b contract (failure ids, bounded decodes, the memory ceiling). Fixtures: `/Volumes/External/test-files/sample-font-files` (override `FONT_FIXTURES`); a
missing fixture fails loudly. Node only: one Playwright browser at a time; never beside a build, the sweep or the
oracle generator.

Results on 2026-11-18 (the committed build `bb415c6e…`, fontconverter-web P3b; oracle definitions
`P3b-2026-11-18-R8`): `FONTWRAP-NODE-OK 1480 passed, 0 failed, 2 known limits`; `FONTWRAP-NATIVE-OK 1452 passed, 0
failed, 2 known limits, 7 n/a` (no sanitizer report); `FONTWRAP-SWEEP-OK 20623 runs, 0 findings`;
`FONTWRAP-BROWSER-OK` 33/33 in Chromium 149, Chrome 157, Firefox 151 and WebKit 26.5 (the three memory rows red on
P3's engine, 31/33). The re-made `fontwrap-oracle.json` keeps the 183 earlier outputs byte for byte with no verdict
changed and adds 18 (Nabla, Bungee Color's sbix and SVG builds, and their fontTools wrappings); OTS rejects Bungee
Color's SVG build itself (`GSUB`: a `DFLT` script without `DefaultLangSys`), so its six wraps inherit that verdict.

Results on 2026-11-17 (the committed build `b46b3f88…`): `FONTWRAP-NODE-OK 1312 passed, 0 failed, 3 known limits`;
`FONTWRAP-NATIVE-OK 1288 passed, 0 failed, 2 known limits, 6 n/a` (no sanitizer report; the native build reproduces all
183 recorded wasm outputs byte for byte); `FONTWRAP-SWEEP-OK 20623 runs, 0 findings`; `FONTWRAP-BROWSER-OK` 30/30 in
Chromium 149, Chrome 157, Firefox 151 and WebKit 26.5 (a planted `-sGROWABLE_ARRAYBUFFERS=1` glue fails in all four).

Known limits (asserted as such; a change in behaviour fails as "limit changed"): wasm 2, native 2 (from P3b; wasm 3 before).

| Limit | Where | Behaviour |
|---|---|---|
| A WOFF2 damaged inside its Brotli stream can decode with a wrong glyph | WOFF2 has no checksum | 16 flipped bytes in OpenSans' WOFF2: exit 0, exactly glyph `uni0482` differs (N8) |
| MTX EOT loses `hdmx` and `VDMX` | libeot `parseCTF` skips them | `with-hdmx.mtx.eot`: every other table equal, exit 0, and libeot's unprefixed stderr line is the only signal (N6) |

Not a known limit since P3b, but pinned: **MTX EOT of Noto COLRv1 aborts in wasm.** libeot reserves numGlyphs × the
worst-case glyph size (2,789 MiB), past the 1 GiB ceiling: the instance aborts with `lastAbort()` `"oom"` and a fresh
instance converts (N6, N13; the app reports `engine-out-of-memory`); the native build decodes it. Before P3b (2 GiB, no
`ABORTING_MALLOC`) it was an exit 1 known limit.

## 7. What is verified, per format

"Judges": fontTools/OTS/FreeType/HarfBuzz through the web repo's scorer (recorded in `fontwrap-oracle.json`, N12), the
harness's own readers (N0-proven), and independent writers (sfntly's EOTs, production's goldens).

| Conversion | Verified | By | Not tested / known limits |
|---|---|---|---|
| sfnt → WOFF → sfnt | bit-identical round trip for every canonical font (26 of 27); the non-canonical one keeps every table | N3; fontTools reads every WOFF fontwrap writes (strict pass) | — |
| WOFF → sfnt (other tools' files) | decodes fontTools', production's and two third-party WOFFs to the tables fontTools reads | N5, N12 | WOFF metadata and private blocks are dropped (noted on stderr); no file in the corpus has one |
| sfnt → WOFF2 → sfnt | every table byte for byte except glyf/loca (every glyph equal), head (checksum, flags bit 11), DSIG (removed); production's WOFF2 of OpenSans byte for byte | N4, N7, N12 (fontTools decodes every WOFF2 fontwrap writes) | google/woff2 switches a short loca to long when 4-byte glyph padding pushes glyf past 128 KiB (one corpus font, `SourceSans3VF-Upright.ttf`): glyphs equal, head.indexToLocFormat and loca's encoding change; a font with a table off a 4-byte boundary is refused for WOFF2 with the table named (`wqy-microhei.ttc`) |
| WOFF2 → sfnt (other tools' files) | fontTools' WOFF2 (with and without the hmtx transform), production's | N5, N12 | **WOFF2 has no checksum: a file damaged inside its Brotli stream can decode with a wrong glyph** (asserted: 16 flipped bytes change exactly one glyph). fontTools itself misreads the transformed `hmtx` of three of its own files (slick, Vera, Twemoji: rebuilt 2 bytes short, then unreadable); those three are judged against their source font instead, every table byte for byte (N5) and every scorer verdict but strict (N12) |
| collections ↔ WOFF2 | round trip face by face for the two well-formed corpus collections | N4 | no independent decoder reads WOFF2 collections (fontTools cannot): round trip proven, interoperability not |
| TrueType → EOT → TrueType | the EOT is the file predicted from sfntly's header rules (N0 proves the rules against 8 sfntly files); production's header byte for byte for OpenSans; payload is the input | N6, N12 (EOT structure check) | not tested in Internet Explorer. The header's names come from the (3,1,0x409) records in every corpus font; the fallback order for fonts without them (other Windows languages, Unicode, Mac Roman) is fontwrap's own and has no independent judge (the harness's predictor shares its design). A name too long for the header's 16-bit size is refused |
| EOT plain / XOR → sfnt | decoded by fontwrap's own code; payload sliced independently, bit for bit | N6, N12 | XOR files made by XOR-ing sfntly's, not from another producer |
| EOT MTX → sfnt | libeot (with `font-wasm patch 1`: a use after free on a font with `glyf` but no `loca`, found by the sweep); every table but glyf/loca/head equal to the source, every glyph equal (leading PUSH re-packing allowed) | N6, N8, N12, the native sweep | libeot drops `hdmx` and `VDMX`; it reserves numGlyphs × the worst-case glyph size up front, so Noto COLRv1 (2,789 MiB) aborts at the 1 GiB ceiling as out of memory (decodes natively); MTX from Microsoft's encoder and MTX of a glyf-less font not tested |
| CFF → EOT | refused unless `--allow-cff`; with it, a bit-identical round trip | N6 | — |
| bitmap-only font (NotoColorEmoji) | every table byte for byte through WOFF and EOT; through WOFF2 every table but `head`'s allowed fields (checkSumAdjustment, flags bit 11), `CBDT`/`CBLC`/`cmap` included | N3, N4, N6, N9 | the scorer cannot render it: its cmap/outline/parses verdicts are recorded, not gated (N12 gates strict and sanitizer only) |
| bad input | empty, truncated, random, zip, damaged directories and headers (an EOT's embedded font too, by `info`), unaligned tables, non-zero WOFF padding, a 2,000:1 WOFF inflate claim (refused before allocating), a WOFF2 declaring more than 512 MiB of table data (refused before google/woff2 reserves it), usage errors: exit 1 or 2, one error line, no output | N8, the native sweep | a WOFF2 can still make the decoder reserve up to 512 MiB before its Brotli stream is found bad (google/woff2 allows 100 times the file size); wasm memory never shrinks, so a caller drops the instance after a failed large job |

## 8. Troubleshooting

- `FONTWRAP-NODE-FAIL … N12 …` after a rebuild: an output changed. Run `make-oracle.mjs`, review
  `fontwrap-oracle.next.json`, move the old file to `fontwrap-oracle.<date>.json`, the new one into place.
- A browser fails with "The provided ArrayBuffer value must not be resizable": the glue was linked without
  `-sGROWABLE_ARRAYBUFFERS=0`. The build script and N11 refuse such glue.
- One harness run hung inside node 23 (a Maglev deadlock, spike S2): run with `--no-maglev`.
