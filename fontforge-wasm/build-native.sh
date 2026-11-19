#!/usr/bin/env bash
# build-native.sh -- ffconv natively under clang ASan/UBSan (P2 plan, P2-16): build/native/ffconv-asan.
#
#   bash fontforge-wasm/build-native.sh        (BUILD_DIR as build-ffconv-wasm.sh; JOBS)
#
# The same FontForge (vendor/fontforge with vendor/patches) and own sources as the wasm build, with the same build
# stamp (SOURCE_DATE_EPOCH, empty git version) and -ffp-contract=off everywhere (S1: fused multiply-add changes
# outlines). FontForge is compiled with -fsanitize=address,undefined -fsanitize-recover=address,undefined, so a run
# records every report and goes on (ASAN_OPTIONS=halt_on_error=0, set by test/lib/engine.js); own sources with
# -fno-sanitize-recover=all. Dependencies natively without sanitizers: vendored libxml2 and GNU libiconv; FreeType
# 2.13.3 and zlib 1.3.2 from the archives the wasm build's ports use; GLib from Homebrew (2.88.2, recorded; it brings
# its own PCRE2). Nothing is deleted; a clean build is a new BUILD_DIR.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="$(mkdir -p "${BUILD_DIR:-$HERE/build}" && cd "${BUILD_DIR:-$HERE/build}" && pwd)"
N="$BUILD_DIR/native"
SRC="$N/src"
STAGE="$N/stage"
JOBS="${JOBS:-4}"
EMSDK_DIR="${EMSDK:?Set EMSDK to an emsdk checkout with Emscripten 6.0.2 (source its emsdk_env.sh)}"
FREETYPE_ZIP="${FFCONV_TARBALLS:-$HERE/build/tarballs}/freetype-VER-2-13-3.zip"
ZLIB_TARBALL="$EMSDK_DIR/upstream/emscripten/cache/ports/zlib.3.2.tar.gz"
GLIB_WANTED="2.88.2"
export SOURCE_DATE_EPOCH=1672531200
export PKG_CONFIG_PATH="/opt/homebrew/opt/glib/lib/pkgconfig:/opt/homebrew/opt/pcre2/lib/pkgconfig:/opt/homebrew/lib/pkgconfig"

[ "$(pkg-config --modversion glib-2.0)" = "$GLIB_WANTED" ] || { echo "Error: Homebrew GLib $GLIB_WANTED required" >&2; exit 1; }
MAPS="-ffile-prefix-map=$HERE=fontforge-wasm -ffile-prefix-map=$BUILD_DIR=build"
DEP_CFLAGS="-O2 -ffp-contract=off $MAPS"
SAN="-fsanitize=address,undefined -fno-omit-frame-pointer"
FF_CFLAGS="-O1 -g -ffp-contract=off $SAN -fsanitize-recover=address,undefined $MAPS"
OWN_CFLAGS="-O1 -g -ffp-contract=off $SAN -fno-sanitize-recover=all -std=c11 -Wall -Wextra -Werror $MAPS"
mkdir -p "$SRC" "$STAGE"

# ---- sources: FreeType and zlib from the ports' archives (sha512 checked by deps/seed_ports.py's pins) ----
if [ ! -d "$SRC/freetype-VER-2-13-3" ]; then
  python3 -I "$HERE/deps/seed_ports.py" "$N/portcheck" "$FREETYPE_ZIP" "$ZLIB_TARBALL"
  cp -R "$N/portcheck/ports/freetype/freetype-VER-2-13-3" "$SRC/"
  cp -R "$N/portcheck/ports/zlib/zlib-1.3.2" "$SRC/"
fi

# ---- zlib, FreeType (no optional libraries), GNU libiconv, libxml2: static, no sanitizers ----
if [ ! -f "$STAGE/lib/libz.a" ]; then
  cmake -S "$SRC/zlib-1.3.2" -B "$N/zlib" -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_C_FLAGS="$DEP_CFLAGS" \
    -DCMAKE_INSTALL_PREFIX="$STAGE" -DZLIB_BUILD_SHARED=OFF -DZLIB_BUILD_TESTING=OFF > "$N/zlib.log"
  ninja -C "$N/zlib" -j "$JOBS" install >> "$N/zlib.log"
fi
if [ ! -f "$STAGE/lib/libfreetype.a" ]; then
  cmake -S "$SRC/freetype-VER-2-13-3" -B "$N/freetype" -G Ninja -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_C_FLAGS="$DEP_CFLAGS" -DCMAKE_INSTALL_PREFIX="$STAGE" -DBUILD_SHARED_LIBS=OFF -DFT_DISABLE_BZIP2=ON \
    -DFT_DISABLE_PNG=ON -DFT_DISABLE_HARFBUZZ=ON -DFT_DISABLE_BROTLI=ON -DFT_DISABLE_ZLIB=ON > "$N/freetype.log"
  ninja -C "$N/freetype" -j "$JOBS" install >> "$N/freetype.log"
fi
if [ ! -f "$STAGE/iconv/lib/libiconv.a" ]; then
  mkdir -p "$N/libiconv"
  (cd "$N/libiconv" && CFLAGS="$DEP_CFLAGS" "$HERE/vendor/libiconv/configure" --prefix="$STAGE/iconv" \
    --enable-static --disable-shared --disable-nls --enable-extra-encodings=no > "$N/libiconv.log" &&
    make -j "$JOBS" -C lib all >> "$N/libiconv.log" && make -C lib install >> "$N/libiconv.log" &&
    mkdir -p "$STAGE/iconv/include" && cp include/iconv.h.inst "$STAGE/iconv/include/iconv.h")
fi
if [ ! -f "$STAGE/lib/libxml2.a" ]; then
  cmake -S "$HERE/vendor/libxml2" -B "$N/libxml2" -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_C_FLAGS="$DEP_CFLAGS" \
    -DCMAKE_INSTALL_PREFIX="$STAGE" -DBUILD_SHARED_LIBS=OFF -DLIBXML2_WITH_PYTHON=OFF -DLIBXML2_WITH_LZMA=OFF \
    -DLIBXML2_WITH_ZLIB=OFF -DLIBXML2_WITH_THREADS=OFF -DLIBXML2_WITH_HTTP=OFF -DLIBXML2_WITH_FTP=OFF \
    -DLIBXML2_WITH_MODULES=OFF -DLIBXML2_WITH_DEBUG=OFF -DLIBXML2_WITH_PROGRAMS=OFF -DLIBXML2_WITH_TESTS=OFF \
    -DLIBXML2_WITH_CATALOG=OFF -DLIBXML2_WITH_ICONV=ON > "$N/libxml2.log"
  ninja -C "$N/libxml2" -j "$JOBS" >> "$N/libxml2.log"
  cmake --install "$N/libxml2" --component development >> "$N/libxml2.log"
fi

# ---- FontForge with sanitizers (recoverable) ----
# From a copy of vendor/fontforge with an empty osx/ (on macOS FontForge's CMake adds the app bundle, which is not
# vendored: it holds binary icons). The copy records the patch set it was made from; another set is refused.
FF_SRC="$SRC/fontforge"
PATCH_SET="$(cd "$HERE/vendor/patches" && shasum -a 256 ./*.patch)"
if [ ! -d "$FF_SRC" ]; then
  cp -R "$HERE/vendor/fontforge" "$FF_SRC"
  mkdir -p "$FF_SRC/osx"
  echo "# build-native.sh: the macOS app bundle is not built" > "$FF_SRC/osx/CMakeLists.txt"
  echo "$PATCH_SET" > "$FF_SRC/.fontforge-wasm-patches"
fi
[ "$(cat "$FF_SRC/.fontforge-wasm-patches")" = "$PATCH_SET" ] || {
  echo "Error: $FF_SRC was copied with another patch set; use a fresh BUILD_DIR" >&2; exit 1; }
FF_BUILD="$N/fontforge"
if [ ! -f "$FF_BUILD/build.ninja" ]; then
  cmake -S "$FF_SRC" -B "$FF_BUILD" -G Ninja -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_C_FLAGS="$FF_CFLAGS" -DCMAKE_C_FLAGS_RELEASE="-DNDEBUG" -DBUILD_SHARED_LIBS=OFF -DBUILD_TESTING=OFF \
    -DENABLE_GUI=OFF -DENABLE_X11=OFF -DENABLE_NATIVE_SCRIPTING=ON -DENABLE_PYTHON_SCRIPTING=OFF \
    -DENABLE_PYTHON_EXTENSION=OFF -DENABLE_LIBSPIRO=OFF -DENABLE_LIBGIF=OFF -DENABLE_LIBJPEG=OFF -DENABLE_LIBPNG=OFF \
    -DENABLE_LIBREADLINE=OFF -DENABLE_LIBTIFF=OFF -DENABLE_WOFF2=OFF -DENABLE_DOCS=OFF \
    -DENABLE_FONTFORGE_EXTRAS=OFF -DENABLE_MAINTAINER_TOOLS=OFF -DREAL_TYPE=double -DFONTFORGE_GIT_VERSION= \
    -DLIBXML2_INCLUDE_DIR="$STAGE/include/libxml2" -DLIBXML2_LIBRARY="$STAGE/lib/libxml2.a" \
    -DFREETYPE_INCLUDE_DIR_ft2build="$STAGE/include/freetype2" -DFREETYPE_INCLUDE_DIR_freetype2="$STAGE/include/freetype2" \
    -DFREETYPE_LIBRARY="$STAGE/lib/libfreetype.a" -DZLIB_INCLUDE_DIR="$STAGE/include" -DZLIB_LIBRARY="$STAGE/lib/libz.a" \
    -DIconv_IS_BUILT_IN=FALSE -DIconv_INCLUDE_DIR="$STAGE/iconv/include" -DIconv_LIBRARY="$STAGE/iconv/lib/libiconv.a" \
    > "$N/fontforge-configure.log"
fi
ninja -C "$FF_BUILD" -j "$JOBS" lib/libfontforge.a > "$N/fontforge-build.log"

# ---- own sources with sanitizers (not recoverable), and the link ----
O="$N/ffconv"
mkdir -p "$O"
PCRE2_VERSION="$(pkg-config --modversion libpcre2-8)"
PATCH_NAMES=""
for p in "$HERE"/vendor/patches/*.patch; do  # deps/patches are GLib's, and GLib here is Homebrew's
  PATCH_NAMES="$PATCH_NAMES${PATCH_NAMES:+,}\\\"$(basename "$p" .patch)\\\""
done
printf '%s\n' "/* written by build-native.sh */" "#define FFCONV_PATCHES \"$PATCH_NAMES\"" \
  "#define FFCONV_PCRE2_VERSION \"$PCRE2_VERSION\"" > "$O/ffconv-build.h"
GLIB_CFLAGS="$(pkg-config --cflags glib-2.0 gio-2.0 | sed 's/-I/-isystem /g')"
for f in main.c sniff.c no-subprocess.c stable-qsort.c; do
  # shellcheck disable=SC2086
  clang $OWN_CFLAGS -I"$HERE/src" -I"$O" -isystem "$FF_BUILD/inc" -isystem "$FF_SRC/inc" \
    -isystem "$FF_SRC/fontforge" $GLIB_CFLAGS -isystem "$STAGE/include/libxml2" \
    -isystem "$STAGE/iconv/include" -isystem "$STAGE/include/freetype2" -isystem "$STAGE/include" \
    -c "$HERE/src/$f" -o "$O/${f%.c}.o"
done
# shellcheck disable=SC2046
clang $SAN -o "$N/ffconv-asan" "$O/main.o" "$O/sniff.o" "$O/no-subprocess.o" "$O/stable-qsort.o" "$FF_BUILD/lib/libfontforge.a" \
  "$STAGE/iconv/lib/libiconv.a" "$STAGE/lib/libxml2.a" "$STAGE/lib/libfreetype.a" "$STAGE/lib/libz.a" \
  $(pkg-config --libs glib-2.0 gio-2.0 gobject-2.0) -framework CoreServices -framework CoreFoundation -liconv -lm
# -liconv: the system's iconv for libxml2 (as musl's in the wasm build); FontForge uses GNU libiconv's libiconv_*
{
  echo "ffconv native ASan/UBSan build (fontforge-wasm/build-native.sh)"
  echo "clang:             $(clang --version | head -1)"
  echo "glib (Homebrew):   $(pkg-config --modversion glib-2.0); pcre2 $PCRE2_VERSION"
  echo "pins:              fontforge@20230101 glib@$(pkg-config --modversion glib-2.0) pcre2@$PCRE2_VERSION libxml2@2.13.9 libiconv@1.17 freetype@2.13.3 zlib@1.3.2"
  echo "patches:           $(cd "$HERE" && ls vendor/patches/*.patch | tr '\n' ' ')"
  echo "fontforge cflags:  ${FF_CFLAGS//$HERE/<fontforge-wasm dir>}"
  echo "own cflags:        ${OWN_CFLAGS//$HERE/<fontforge-wasm dir>}"
} > "$N/BUILD-INFO.native.txt"
"$N/ffconv-asan" version
echo "NATIVE-BUILD-OK $N/ffconv-asan"
