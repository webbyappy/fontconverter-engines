#!/usr/bin/env bash
# build-deps.sh -- ffconv's dependencies as static wasm32 libraries (P2 plan, P2-10), into $BUILD_DIR/wasm/stage.
#
#   bash fontforge-wasm/build-deps.sh           (BUILD_DIR overridable; default fontforge-wasm/build)
#
# - Emscripten 6.0.2 only, with a private cache ($BUILD_DIR/wasm/emcache): nothing is written into emsdk. The
#   FreeType and zlib ports are seeded into it from local archives checked against emsdk's own sha512 pins
#   (deps/seed_ports.py; FreeType from build/tarballs, where fetch-vendor.sh keeps it, zlib from emsdk's cache), so
#   nothing is downloaded here.
# - the house libffi stub (deps/libffi-stub), GLib 2.78.6 from libmirage-wasm/deps/glib-2.78.6.tar.xz with
#   deps/patches/glib-* (0001: no res_query check; 0002: no -pthread, ffconv has no threads) and vendor/pcre2 as its
#   PCRE2 subproject (--wrap-mode=nodownload), vendor/libxml2,
#   vendor/libiconv (into its own prefix, seen by FontForge only). Every library is installed under the neutral
#   prefix /usr/local with DESTDIR, and every compile maps local paths away (S1 finding 3).
# - SOURCE_DATE_EPOCH is pinned (FontForge and GLib stamp build times). Nothing is ever deleted: a clean build is a
#   new BUILD_DIR.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(dirname "$HERE")"
BUILD_DIR="$(mkdir -p "${BUILD_DIR:-$HERE/build}" && cd "${BUILD_DIR:-$HERE/build}" && pwd)"
W="$BUILD_DIR/wasm"
SRC="$BUILD_DIR/src"
STAGE="$W/stage"
PREFIX="$STAGE/usr/local"
IPREFIX="$STAGE/usr/local-iconv"
TARBALLS="${FFCONV_TARBALLS:-$HERE/build/tarballs}"
EMSDK_DIR="${EMSDK:?Set EMSDK to an emsdk checkout with Emscripten 6.0.2 (source its emsdk_env.sh)}"
EMSCRIPTEN_WANTED="6.0.2"
MESON="${MESON:?Set MESON to meson 1.10.2 (fontforge-wasm/requirements-build.txt)}"
JOBS="${JOBS:-4}"
GLIB_TARBALL="${GLIB_TARBALL:-$REPO/libmirage-wasm/deps/glib-2.78.6.tar.xz}"
GLIB_SHA256="244854654dd82c7ebcb2f8e246156d2a05eb9cd1ad07ed7a779659b4602c9fae"
FREETYPE_ZIP="${FREETYPE_ZIP:-$TARBALLS/freetype-VER-2-13-3.zip}"
ZLIB_TARBALL="${ZLIB_TARBALL:-$EMSDK_DIR/upstream/emscripten/cache/ports/zlib.3.2.tar.gz}"

if ! command -v emcc >/dev/null 2>&1; then
  set +u
  # shellcheck disable=SC1091
  EMSDK_QUIET=1 source "$EMSDK_DIR/emsdk_env.sh"
  set -u
fi
EMVER="$(emcc --version | head -1)"
case "$EMVER" in *" $EMSCRIPTEN_WANTED "*) ;; *) echo "Error: Emscripten $EMSCRIPTEN_WANTED required, found: $EMVER" >&2; exit 1 ;; esac
[ "$("$MESON" --version)" = "1.10.2" ] || { echo "Error: meson 1.10.2 required at $MESON (requirements-build.txt)" >&2; exit 1; }
"$(dirname "$MESON")/python" -c "import distutils.version" 2>/dev/null || { echo "Error: the meson venv lacks distutils (requirements-build.txt pins setuptools)" >&2; exit 1; }

export EM_CACHE="$W/emcache"
export SOURCE_DATE_EPOCH=1672531200   # 2023-01-01T00:00:00Z, FontForge 20230101's release (S1)
export PYTHONDONTWRITEBYTECODE=1
export PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig:$EM_CACHE/sysroot/lib/pkgconfig"
unset PKG_CONFIG_PATH || true
MAPS="-ffile-prefix-map=$HERE=fontforge-wasm -ffile-prefix-map=$BUILD_DIR=build -ffile-prefix-map=$EM_CACHE=emcache"
HOUSE_CFLAGS="-O2 -fexceptions $MAPS"
mkdir -p "$SRC" "$W" "$PREFIX/lib/pkgconfig" "$PREFIX/include" "$IPREFIX/include"

# --- the sources that are not vendored ------------------------------------------------------------------------
[ "$(shasum -a 256 "$GLIB_TARBALL" | cut -d' ' -f1)" = "$GLIB_SHA256" ] || { echo "Error: $GLIB_TARBALL sha256" >&2; exit 1; }
GLIB_PATCHES="$(cd "$HERE/deps/patches" && ls glib-*.patch)"
if [ ! -d "$SRC/glib-2.78.6" ]; then
  tar -xf "$GLIB_TARBALL" -C "$SRC"
  for p in $GLIB_PATCHES; do patch -s -p1 -d "$SRC/glib-2.78.6" -i "$HERE/deps/patches/$p"; done
  echo "$GLIB_PATCHES" > "$SRC/glib-2.78.6/.fontforge-wasm-patches"
  cp -R "$HERE/vendor/pcre2" "$SRC/glib-2.78.6/subprojects/pcre2-10.42"
fi
# A tree extracted with another patch set is never reused: a clean build is a new BUILD_DIR.
[ "$(cat "$SRC/glib-2.78.6/.fontforge-wasm-patches" 2>/dev/null)" = "$GLIB_PATCHES" ] || {
  echo "Error: $SRC/glib-2.78.6 was patched with another set than deps/patches; use a fresh BUILD_DIR" >&2; exit 1; }

# --- Emscripten's system libraries and the two ports, in the private cache ----------------------------------------
python3 -I "$HERE/deps/seed_ports.py" "$EM_CACHE" "$FREETYPE_ZIP" "$ZLIB_TARBALL"
embuilder build sysroot libc libc++ libc++abi zlib freetype
ls "$EM_CACHE/sysroot/lib/wasm32-emscripten/libfreetype.a" "$EM_CACHE/sysroot/lib/wasm32-emscripten/libz.a" >/dev/null

# --- the house libffi stub (GLib's configure needs a libffi; nothing of it is linked into ffconv) ------------------
mkdir -p "$W/libffi"
emcc $HOUSE_CFLAGS -I"$HERE/deps/libffi-stub/include" -c "$HERE/deps/libffi-stub/src/ffi.c" -o "$W/libffi/ffi.o"
emar rcs "$PREFIX/lib/libffi.a" "$W/libffi/ffi.o"
cp "$HERE/deps/libffi-stub/include/ffi.h" "$PREFIX/include/ffi.h"
cat > "$PREFIX/lib/pkgconfig/libffi.pc" <<EOF
prefix=$PREFIX
libdir=\${prefix}/lib
includedir=\${prefix}/include

Name: libffi
Description: the house libffi stub (fontforge-wasm/deps/libffi-stub)
Version: 3.4.0
Libs: -L\${libdir} -lffi
Cflags: -I\${includedir}
EOF

# --- GLib 2.78.6 with PCRE2 10.42 ------------------------------------------------------------------------------
G="$W/glib"
if [ ! -f "$G/build.ninja" ]; then
  mkdir -p "$G"
  quote() { local out="" a; for a in "$@"; do out="$out${out:+, }'$a'"; done; echo "$out"; }
  # shellcheck disable=SC2086
  C_ARGS="$(quote -Wno-incompatible-function-pointer-types -Wno-incompatible-pointer-types -Wno-int-conversion -fexceptions $MAPS)"
  sed -e "s|@C_ARGS@|$C_ARGS|" -e "s|@PKG_CONFIG_LIBDIR@|'$PREFIX/lib/pkgconfig', '$EM_CACHE/sysroot/lib/pkgconfig'|" \
    "$HERE/emscripten-crossfile.ini.in" > "$G.crossfile.ini"
  "$MESON" setup "$G" "$SRC/glib-2.78.6" --cross-file "$G.crossfile.ini" --prefix /usr/local \
    --default-library=static --wrap-mode=nodownload --force-fallback-for=pcre2 \
    -Doptimization=2 -Ddebug=false -Dlibmount=disabled -Dselinux=disabled -Dxattr=false -Dlibelf=disabled \
    -Dtests=false -Ddtrace=false -Dsysprof=disabled -Dnls=disabled -Dglib_assert=false -Dglib_checks=false
fi
# shellcheck disable=SC2046
ninja -C "$G" -j "$JOBS" $(python3 -I "$HERE/deps/meson_static_targets.py" "$G")
DESTDIR="$STAGE" "$MESON" install -C "$G" --no-rebuild --tags devel > "$W/glib-install.log"

# --- libxml2 2.13.9 (FontForge reads and writes SVG with it) ------------------------------------------------------
X="$W/libxml2"
if [ ! -f "$X/build.ninja" ]; then
  emcmake cmake -S "$HERE/vendor/libxml2" -B "$X" -G Ninja -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_C_FLAGS="$HOUSE_CFLAGS" -DCMAKE_C_FLAGS_RELEASE="-DNDEBUG" -DCMAKE_INSTALL_PREFIX=/usr/local \
    -DBUILD_SHARED_LIBS=OFF -DLIBXML2_WITH_PYTHON=OFF -DLIBXML2_WITH_LZMA=OFF -DLIBXML2_WITH_ZLIB=OFF \
    -DLIBXML2_WITH_THREADS=OFF -DLIBXML2_WITH_HTTP=OFF -DLIBXML2_WITH_FTP=OFF -DLIBXML2_WITH_MODULES=OFF \
    -DLIBXML2_WITH_DEBUG=OFF -DLIBXML2_WITH_PROGRAMS=OFF -DLIBXML2_WITH_TESTS=OFF -DLIBXML2_WITH_CATALOG=OFF \
    -DLIBXML2_WITH_ICONV=ON
fi
ninja -C "$X" -j "$JOBS"
# only the library, its headers, libxml-2.0.pc and xml2-config: the man pages are not vendored
DESTDIR="$STAGE" cmake --install "$X" --component development > "$W/libxml2-install.log"

# --- GNU libiconv 1.17, in its own prefix (FontForge only; GLib and libxml2 keep musl's iconv, S1) ---------------
I="$W/libiconv"
mkdir -p "$I"
if [ ! -f "$I/Makefile" ]; then
  (cd "$I" && CFLAGS="$HOUSE_CFLAGS" emconfigure "$HERE/vendor/libiconv/configure" --host=wasm32-unknown-emscripten \
    --prefix=/usr/local-iconv --enable-static --disable-shared --disable-nls --disable-rpath --enable-extra-encodings=no)
fi
(cd "$I" && emmake make -j "$JOBS" lib/localcharset.h && emmake make -j "$JOBS" -C lib all && emmake make -C lib install DESTDIR="$STAGE")
cp "$I/include/iconv.h.inst" "$IPREFIX/include/iconv.h"

ls "$PREFIX/lib/libglib-2.0.a" "$PREFIX/lib/libgio-2.0.a" "$PREFIX/lib/libpcre2-8.a" "$PREFIX/lib/libxml2.a" \
  "$IPREFIX/lib/libiconv.a" >/dev/null
echo "DEPS-BUILD-OK $STAGE"
