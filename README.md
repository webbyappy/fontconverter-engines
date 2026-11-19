# fontconverter.io engines: complete source

fontconverter.io converts fonts in the visitor's browser with three WebAssembly engines, built with Emscripten
6.0.2:

- **fontwrap** (`font-wasm/`): WOFF, WOFF2 and EOT in and out. Brotli, google/woff2 and zlib (MIT, Zlib) and libeot
  (MPL-2.0, with one change, listed in `font-wasm/VENDORING.md`).
- **ffconv** (`fontforge-wasm/`): FontForge 20230101 with its changes, GLib, libxml2, GNU libiconv, PCRE2, FreeType and
  zlib. **GPL-3.0-or-later**; GLib and libiconv are LGPL-2.1-or-later. Every change is a patch in
  `fontforge-wasm/vendor/patches/` or `fontforge-wasm/deps/patches/`, listed in `fontforge-wasm/VENDORING.md`.
- **hbfont** (`harfbuzz-wasm/`): HarfBuzz 15.0.0 with its changes and zlib (MIT, Zlib).

This repository is their complete corresponding source: each engine's folder as built (sources, vendored components,
patches, build and test scripts, licence texts) and the archives the build reads. Each folder's `VENDORING.md` and
licence files say what each part is and under which licence.

**Licences.** The top-level `LICENSE` (MIT) covers only this repository's own top-level files (`README.md`,
`build-all.sh`, `SHA256SUMS`). Every engine folder keeps its components' own licences: **ffconv** as a whole is
GPL-3.0-or-later (`fontforge-wasm/LICENSE`), GLib and libiconv LGPL-2.1-or-later, libeot MPL-2.0, the rest MIT, BSD or
Zlib as each folder's `licenses/` and `VENDORING.md` say. The archives keep the licences inside them.

## Building

Needs Emscripten 6.0.2 (an emsdk checkout), python3, ninja, meson 1.10.2
(`fontforge-wasm/requirements-build.txt`), bash and shasum.

```
EMSDK=/path/to/emsdk MESON=/path/to/meson bash build-all.sh
shasum -a 256 -c SHA256SUMS
```

`build-all.sh` builds into a fresh Emscripten cache inside this folder, seeded from `archives/`, so nothing is
downloaded and no other cache is read.

| Archive | sha256 |
|---|---|
| `archives/glib-2.78.6.tar.xz` | `244854654dd82c7ebcb2f8e246156d2a05eb9cd1ad07ed7a779659b4602c9fae` |
| `archives/freetype-VER-2-13-3.zip` | `a7165cb405dfce349ae64d6f59efb2567565ca8edbacbeff2a8d0e4cfa779cf5` |
| `archives/zlib.3.2.tar.gz` | `b99a0b86c0ba9360ec7e78c4f1e43b1cbdf1e6936c8fa0f6835c0cd694a495a1` |
