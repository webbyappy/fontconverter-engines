#!/usr/bin/env bash
# build-ffconv-wasm.sh -- ffconv (FontForge 20230101 as a font converter) to WebAssembly (P2 plan, P2-8 to P2-11:
# fontconverter-web docs/audits/P2-FFCONV-PLAN-2026-11-17.md). Licence: GPL-3.0-or-later (LICENSE, VENDORING.md).
#
#   bash fontforge-wasm/build-deps.sh          first: the dependencies, into $BUILD_DIR/wasm/stage
#   bash fontforge-wasm/build-ffconv-wasm.sh   FontForge, the own sources, the link; output/ffconv.{js,wasm}
#
#   BUILD_DIR=<dir> OUT_DIR=<dir>    a build somewhere else (both default to fontforge-wasm/build and output)
#   LINK_ONLY=1 EXTRA_LDFLAGS=<flags> OUT_DIR=<dir>    re-link the existing objects with extra flags (C5's planted
#                                    growable-buffer break); refused for the committed output/; the glue checks
#                                    report but do not stop it
#
# Synchronous callMain, MEMFS/WORKERFS/NODEFS, no Asyncify, no pthreads, no SIMD, no closure, no EXPORT_ES6, no
# SINGLE_FILE, no WASMFS. FontForge stamps its configure time and its git version into every font (FFTM): both are
# pinned (SOURCE_DATE_EPOCH, -DFONTFORGE_GIT_VERSION=). Nothing is deleted: every link goes to a fresh staging
# folder, the glue is checked there, and only then is the pair copied over $OUT_DIR.
#
# Tests: node test-nodefs-contract.js fontforge-wasm/output/ffconv.js <dir>;
#        TZ=UTC node --no-maglev fontforge-wasm/test/test-ffconv-node.js
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="$(mkdir -p "${BUILD_DIR:-$HERE/build}" && cd "${BUILD_DIR:-$HERE/build}" && pwd)"
W="$BUILD_DIR/wasm"
DEPS="$W/stage"
PREFIX="$DEPS/usr/local"
IPREFIX="$DEPS/usr/local-iconv"
SYSROOT="$W/emcache/sysroot"
FF_SRC="$HERE/vendor/fontforge"
FF_BUILD="$W/fontforge"
OBJ="$W/ffconv"
OUT="$(mkdir -p "${OUT_DIR:-$HERE/output}" && cd "${OUT_DIR:-$HERE/output}" && pwd)"
LINK_ONLY="${LINK_ONLY:-0}"
EXTRA_LDFLAGS="${EXTRA_LDFLAGS:-}"
EMSDK_DIR="${EMSDK:?Set EMSDK to an emsdk checkout with Emscripten 6.0.2 (source its emsdk_env.sh)}"
EMSCRIPTEN_WANTED="6.0.2"
JOBS="${JOBS:-4}"
PINS="fontforge@20230101 glib@2.78.6 pcre2@10.42 libxml2@2.13.9 libiconv@1.17 freetype@2.13.3 zlib@1.3.2"

if [ "$LINK_ONLY" = "1" ] && [ "$OUT" = "$HERE/output" ]; then
  echo "Error: LINK_ONLY builds a planned break; give it an OUT_DIR outside fontforge-wasm/output" >&2
  exit 1
fi
if ! command -v emcc >/dev/null 2>&1; then
  set +u
  # shellcheck disable=SC1091
  EMSDK_QUIET=1 source "$EMSDK_DIR/emsdk_env.sh"
  set -u
fi
EMVER="$(emcc --version | head -1)"
case "$EMVER" in *" $EMSCRIPTEN_WANTED "*) ;; *) echo "Error: Emscripten $EMSCRIPTEN_WANTED required, found: $EMVER" >&2; exit 1 ;; esac
[ -f "$PREFIX/lib/libglib-2.0.a" ] || { echo "Error: run fontforge-wasm/build-deps.sh first (no $PREFIX)" >&2; exit 1; }

export EM_CACHE="$W/emcache"
export SOURCE_DATE_EPOCH=1672531200   # 2023-01-01T00:00:00Z: FontForge's FFTM build stamp (P2-8)
export PYTHONDONTWRITEBYTECODE=1
MAPS="-ffile-prefix-map=$HERE=fontforge-wasm -ffile-prefix-map=$BUILD_DIR=build -ffile-prefix-map=$EM_CACHE=emcache"
HOUSE_CFLAGS="-O2 -fexceptions $MAPS"

# ---- FontForge 20230101 (S1's 06-build-fontforge.sh, CONFIG=full, with WOFF2 off and the build stamp pinned) ----
if [ "$LINK_ONLY" != "1" ]; then
  if [ ! -f "$FF_BUILD/build.ninja" ]; then
    emcmake cmake -S "$FF_SRC" -B "$FF_BUILD" -G Ninja \
      -DCMAKE_BUILD_TYPE=Release -DCMAKE_C_FLAGS="$HOUSE_CFLAGS" -DCMAKE_CXX_FLAGS="$HOUSE_CFLAGS" \
      -DCMAKE_C_FLAGS_RELEASE="-DNDEBUG" -DCMAKE_CXX_FLAGS_RELEASE="-DNDEBUG" -DCMAKE_INSTALL_PREFIX=/usr/local \
      -DCMAKE_FIND_ROOT_PATH="$PREFIX" -DCMAKE_PREFIX_PATH="$PREFIX" \
      -DBUILD_SHARED_LIBS=OFF -DBUILD_TESTING=OFF -DENABLE_GUI=OFF -DENABLE_X11=OFF -DENABLE_NATIVE_SCRIPTING=ON \
      -DENABLE_PYTHON_SCRIPTING=OFF -DENABLE_PYTHON_EXTENSION=OFF -DENABLE_LIBSPIRO=OFF -DENABLE_LIBGIF=OFF \
      -DENABLE_LIBJPEG=OFF -DENABLE_LIBPNG=OFF -DENABLE_LIBREADLINE=OFF -DENABLE_LIBTIFF=OFF -DENABLE_WOFF2=OFF \
      -DENABLE_DOCS=OFF -DENABLE_FONTFORGE_EXTRAS=OFF -DENABLE_MAINTAINER_TOOLS=OFF -DREAL_TYPE=double \
      -DFONTFORGE_GIT_VERSION= \
      -DGLIB_INCLUDE_DIR="$PREFIX/include/glib-2.0" -DGLIBCONFIG_INCLUDE_DIR="$PREFIX/lib/glib-2.0/include" \
      -DGLIB_LIBRARIES="$PREFIX/lib/libglib-2.0.a" -DGLIB_GIO_LIBRARIES="$PREFIX/lib/libgio-2.0.a" \
      -DGLIB_GOBJECT_LIBRARIES="$PREFIX/lib/libgobject-2.0.a" \
      -DLIBXML2_INCLUDE_DIR="$PREFIX/include/libxml2" -DLIBXML2_LIBRARY="$PREFIX/lib/libxml2.a" \
      -DFREETYPE_INCLUDE_DIR_ft2build="$SYSROOT/include/freetype2" \
      -DFREETYPE_INCLUDE_DIR_freetype2="$SYSROOT/include/freetype2" \
      -DFREETYPE_LIBRARY="$SYSROOT/lib/wasm32-emscripten/libfreetype.a" \
      -DZLIB_INCLUDE_DIR="$SYSROOT/include" -DZLIB_LIBRARY="$SYSROOT/lib/wasm32-emscripten/libz.a" \
      -DIconv_IS_BUILT_IN=FALSE -DIconv_INCLUDE_DIR="$IPREFIX/include" -DIconv_LIBRARY="$IPREFIX/lib/libiconv.a"
  fi
  ninja -C "$FF_BUILD" -j "$JOBS" lib/libfontforge.a
fi

# ---- own sources ----
OWN_SRC="main.c sniff.c no-subprocess.c stable-qsort.c"
OWN_FLAGS="$HOUSE_CFLAGS -std=c11 -Wall -Wextra -Werror -I$HERE/src -I$OBJ \
-isystem $FF_BUILD/inc -isystem $FF_SRC/inc -isystem $FF_SRC/fontforge \
-isystem $PREFIX/include/glib-2.0 -isystem $PREFIX/lib/glib-2.0/include -isystem $PREFIX/include/libxml2 \
-isystem $IPREFIX/include -isystem $SYSROOT/include/freetype2"
if [ "$LINK_ONLY" != "1" ]; then
  mkdir -p "$OBJ"
  PCRE2_VERSION="$(sed -n 's/^Version: //p' "$PREFIX/lib/pkgconfig/libpcre2-8.pc")"
  PATCH_NAMES=""
  for p in "$HERE"/vendor/patches/*.patch "$HERE"/deps/patches/*.patch; do
    n="$(basename "$p" .patch)"
    PATCH_NAMES="$PATCH_NAMES${PATCH_NAMES:+,}\\\"$n\\\""
  done
  printf '%s\n' "/* written by build-ffconv-wasm.sh */" \
    "#define FFCONV_PATCHES \"$PATCH_NAMES\"" "#define FFCONV_PCRE2_VERSION \"$PCRE2_VERSION\"" > "$OBJ/ffconv-build.h.tmp"
  mv -f "$OBJ/ffconv-build.h.tmp" "$OBJ/ffconv-build.h"
  for f in $OWN_SRC; do
    # shellcheck disable=SC2086
    emcc $OWN_FLAGS -c "$HERE/src/$f" -o "$OBJ/${f%.c}.o"
  done
fi

# ---- link into a fresh staging folder ----
OBJS=""
for f in $OWN_SRC; do OBJS="$OBJS $OBJ/${f%.c}.o"; done
# libgobject, libgmodule and libffi are built (GLib's configure needs them) but not linked: FontForge references
# none of them (S1; P2's closing review re-checked: the wasm is byte-identical without them), so naming none here
# turns any future reference into a link error.
LIBS="$FF_BUILD/lib/libfontforge.a $IPREFIX/lib/libiconv.a $PREFIX/lib/libxml2.a $PREFIX/lib/libgio-2.0.a \
$PREFIX/lib/libglib-2.0.a $PREFIX/lib/libpcre2-8.a $SYSROOT/lib/wasm32-emscripten/libfreetype.a \
$SYSROOT/lib/wasm32-emscripten/libz.a"
LDFLAGS="-O2 -fexceptions -sDISABLE_EXCEPTION_CATCHING=0 -sWASM=1 -sMODULARIZE=1 -sEXPORT_NAME=FFConv \
-sENVIRONMENT=web,webview,worker,node -sEXPORTED_FUNCTIONS=_main,_malloc,_free \
-sEXPORTED_RUNTIME_METHODS=FS,WORKERFS,NODEFS,ENV,callMain,getExceptionMessage,HEAPU8 \
-sINITIAL_MEMORY=33554432 -sMAXIMUM_MEMORY=1073741824 -sABORTING_MALLOC=1 -sALLOW_MEMORY_GROWTH=1 -sGROWABLE_ARRAYBUFFERS=0 \
-sSTACK_SIZE=5242880 -sFILESYSTEM=1 -sFORCE_FILESYSTEM=1 -sEXIT_RUNTIME=0 -sINVOKE_RUN=0 -sASSERTIONS=0 \
-lworkerfs.js -lnodefs.js --post-js $HERE/post.js"
mkdir -p "$W/link"
STAGE="$(mktemp -d "$W/link/stage-XXXXXX")"
# shellcheck disable=SC2086
emcc $OBJS $LIBS -o "$STAGE/ffconv.js" $LDFLAGS $EXTRA_LDFLAGS

# ---- glue checks, in node (the glue is one very long line; grep is not reliable on it) ----
GLUE_OK=1
node -e '
  const s = require("fs").readFileSync(process.argv[1], "latin1");
  const bad = ["toResizableBuffer", "_malloc(arg.length", "currentSafariVersion", "requires Safari", "Asyncify",
    "child_process"].filter((b) => s.includes(b));
  if (bad.length) { console.error("GLUE-CHECK-FAIL: the glue contains " + bad.join(", ")); process.exit(1); }
  console.log("OK: glue checks");
' "$STAGE/ffconv.js" || GLUE_OK=0
if [ "$GLUE_OK" != "1" ] && [ "$LINK_ONLY" != "1" ]; then exit 1; fi

cp -f "$STAGE/ffconv.js" "$STAGE/ffconv.wasm" "$OUT/"
rel() {  # flags as used, with no absolute path: the same text for a build in any folder (C3's clean builds)
  local s="$1"
  s="${s//-ffile-prefix-map=$EM_CACHE=/-ffile-prefix-map=<emcache dir>=}"
  s="${s//-ffile-prefix-map=$BUILD_DIR=/-ffile-prefix-map=<build dir>=}"
  s="${s//-ffile-prefix-map=$HERE=/-ffile-prefix-map=<fontforge-wasm dir>=}"
  s="${s//$EM_CACHE/<emcache dir>}"
  s="${s//$BUILD_DIR/<build dir>}"
  s="${s//$HERE/<fontforge-wasm dir>}"
  echo "$s"
}
PATCHES_LINE="$(cd "$HERE" && ls vendor/patches/*.patch deps/patches/*.patch | tr '\n' ' ')"
{
  echo "ffconv build (fontforge-wasm/build-ffconv-wasm.sh)"
  echo "emscripten:          $EMVER"
  echo "pins:                $PINS"
  echo "patches:             $PATCHES_LINE"
  echo "SOURCE_DATE_EPOCH:   $SOURCE_DATE_EPOCH (FontForge build stamp)"
  echo "FONTFORGE_GIT_VERSION: (empty)"
  echo "fontforge cflags:    $(rel "$HOUSE_CFLAGS") -DNDEBUG (cmake Release; ENABLE_WOFF2=OFF, native scripting on)"
  echo "own cflags:          $(rel "$OWN_FLAGS")"
  echo "link libraries:      $(rel "$LIBS")"
  echo "link flags:          $(rel "$LDFLAGS")${EXTRA_LDFLAGS:+ EXTRA: $EXTRA_LDFLAGS}"
  (cd "$OUT" && shasum -a 256 ffconv.js ffconv.wasm)
} > "$OUT/BUILD-INFO.txt"
ls -l "$OUT/ffconv.js" "$OUT/ffconv.wasm"
if [ "$GLUE_OK" = "1" ]; then echo "BUILD-OK"; else echo "BUILD-OK (LINK_ONLY; glue checks failed as reported)"; fi
