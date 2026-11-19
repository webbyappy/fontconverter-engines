#!/usr/bin/env bash
# fetch-vendor.sh -- the pinned upstream sources of ffconv, extracted into fontforge-wasm/vendor/ (first time) or
# checked against their archives (--check). See ../VENDORING.md.
#
#   bash fontforge-wasm/vendor/fetch-vendor.sh            extract fontforge/, libxml2/, libiconv/, pcre2/ and
#                                                         licenses/ (refuses to replace a tree that exists)
#   bash fontforge-wasm/vendor/fetch-vendor.sh --check    extract into a scratch folder, apply vendor/patches/*.patch
#                                                         and compare file by file with the committed trees; prints
#                                                         VENDOR-CHECK-OK or VENDOR-CHECK-FAIL
#
# Every archive is an upstream release, verified by its pinned hash before anything is extracted. Archives are looked
# for in $FFCONV_TARBALLS (default fontforge-wasm/build/tarballs/, not committed) and downloaded there when missing.
# The same folder seeds the build's private Emscripten cache with the FreeType port archive (build-deps.sh). GLib is
# not vendored here: build-deps.sh builds it from the tarball committed in libmirage-wasm/deps/ (P2-10). Only the
# subsets listed below are taken. Nothing is ever deleted.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODULE="$(dirname "$HERE")"
REPO="$(dirname "$MODULE")"
TARBALLS="${FFCONV_TARBALLS:-$MODULE/build/tarballs}"
EMSDK="${EMSDK:?Set EMSDK to an emsdk checkout with Emscripten 6.0.2 (source its emsdk_env.sh)}"
ZLIB_LICENSE="$EMSDK/upstream/emscripten/cache/ports/zlib/zlib-1.3.2/LICENSE"
GLIB_TARBALL="${GLIB_TARBALL:-$REPO/libmirage-wasm/deps/glib-2.78.6.tar.xz}"
GLIB_SHA256="244854654dd82c7ebcb2f8e246156d2a05eb9cd1ad07ed7a779659b4602c9fae"

MODE=extract
if [ "${1:-}" = "--check" ]; then MODE=check; elif [ -n "${1:-}" ]; then echo "usage: $0 [--check]" >&2; exit 2; fi

# name|archive file|url|hash algorithm|hash|top folder
ARCHIVES=(
  "fontforge|fontforge-20230101.tar.xz|https://github.com/fontforge/fontforge/releases/download/20230101/fontforge-20230101.tar.xz|256|ca82ec4c060c4dda70ace5478a41b5e7b95eb035fe1c4cf85c48f996d35c60f8|fontforge-20230101"
  "libxml2|libxml2-2.13.9.tar.xz|https://download.gnome.org/sources/libxml2/2.13/libxml2-2.13.9.tar.xz|256|a2c9ae7b770da34860050c309f903221c67830c86e4a7e760692b803df95143a|libxml2-2.13.9"
  "libiconv|libiconv-1.17.tar.gz|https://ftp.gnu.org/pub/gnu/libiconv/libiconv-1.17.tar.gz|256|8f74213b56238c85a50a5329f77e06198771e70dd9a739779f4c02f65d971313|libiconv-1.17"
  "pcre2|pcre2-10.42.tar.bz2|https://github.com/PhilipHazel/pcre2/releases/download/pcre2-10.42/pcre2-10.42.tar.bz2|256|8d36cd8cb6ea2a4c2bb358ff6411b0c788633a2a45dabbf1aeb4b701d1b5e840|pcre2-10.42"
  "pcre2-wrap|pcre2_10.42-2_patch.zip|https://wrapdb.mesonbuild.com/v2/pcre2_10.42-2/get_patch|256|350dc342b81a1611af43e5cc23f1b10453c7df51d5bb60ab9ee247daf03802bc|pcre2-10.42"
  "freetype|freetype-VER-2-13-3.zip|https://github.com/freetype/freetype/archive/VER-2-13-3.zip|512|ce413487c24e689631d705f53b64725256f89fffe9aade7cf07bbd785a9cd49eb6b8d2297a55554f3fee0a50b17e8af78f505cdab565768afab833794f968c2f|freetype-VER-2-13-3"
)

subset() {  # upstream paths taken into vendor/<name>/ (TOPFILES = every regular file at the top of the archive)
  case "$1" in
    fontforge)  echo "TOPFILES cmake inc Unicode gutils fontforge fontforgeexe contrib/CMakeLists.txt contrib/cidmap desktop po share" ;;
    libxml2)    echo "TOPFILES include" ;;
    libiconv)   echo "TOPFILES build-aux lib libcharset include srclib srcm4 m4 po src man doc tests/Makefile.in" ;;
    pcre2)      echo "TOPFILES src cmake" ;;
    pcre2-wrap) echo "ALL" ;;  # meson's wrap patch: overlays meson.build files onto pcre2/
    freetype)   echo "" ;;     # the Emscripten port; built from the archive, nothing vendored
  esac
}
target() { case "$1" in pcre2-wrap) echo pcre2 ;; *) echo "$1" ;; esac; }

# Upstream files never extracted: binaries a headless build without NLS does not use (the GUI's pixmaps and fonts, the
# desktop icons, libiconv's compiled translations). Their folders' CMakeLists.txt stay (they only install them).
excludes() {
  case "$1" in
    fontforge) echo "fontforge-20230101/fontforgeexe/pixmaps/*.png fontforge-20230101/fontforgeexe/pixmaps/*.ttf
                     fontforge-20230101/desktop/*.png fontforge-20230101/desktop/*.gif" ;;
    libiconv)  echo "libiconv-1.17/po/*.gmo" ;;
    *)         echo "" ;;
  esac
}

licences() {  # upstream licence and notice files, copied to licenses/<name>-<file>
  case "$1" in
    fontforge) echo "LICENSE COPYING.gplv3 AUTHORS" ;;
    libxml2)   echo "Copyright" ;;
    libiconv)  echo "COPYING.LIB" ;;
    pcre2)     echo "LICENCE" ;;
    freetype)  echo "LICENSE.TXT docs/FTL.TXT" ;;
    *)         echo "" ;;
  esac
}

hash_of() { shasum -a "$1" "$2" | cut -d' ' -f1; }

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/ffconv-vendor.XXXXXX")"
mkdir -p "$TARBALLS" "$STAGE/licenses"
TREES="fontforge libxml2 libiconv pcre2 licenses"

for spec in "${ARCHIVES[@]}"; do
  IFS='|' read -r name file url algo want top <<<"$spec"
  archive="$TARBALLS/$file"
  if [ ! -f "$archive" ]; then
    echo "download: $url"
    curl -sSfL -o "$archive.part" "$url"
    mv "$archive.part" "$archive"
  fi
  got="$(hash_of "$algo" "$archive")"
  if [ "$got" != "$want" ]; then
    echo "ERROR: $name: sha$algo $got, pinned $want" >&2
    exit 1
  fi
  echo "$name $file sha$algo ok"
  all="$STAGE/$name.all"
  mkdir -p "$all"
  ex=()
  for x in $(excludes "$name"); do ex+=(--exclude "$x"); done
  tar -xf "$archive" -C "$all" ${ex[@]+"${ex[@]}"}
  all="$all/$top"
  dest="$STAGE/$(target "$name")"
  mkdir -p "$dest"
  for p in $(subset "$name"); do
    if [ "$p" = TOPFILES ]; then
      find "$all" -maxdepth 1 -type f -exec cp {} "$dest/" \;
    elif [ "$p" = ALL ]; then
      cp -R "$all/." "$dest/"
    else
      mkdir -p "$dest/$(dirname "$p")"
      cp -R "$all/$p" "$dest/$p"
    fi
  done
  for f in $(licences "$name"); do cp "$all/$f" "$STAGE/licenses/$name-$(basename "$f")"; done
done
if [ "$(hash_of 256 "$GLIB_TARBALL")" != "$GLIB_SHA256" ]; then
  echo "ERROR: $GLIB_TARBALL does not have the pinned sha256" >&2
  exit 1
fi
tar -xf "$GLIB_TARBALL" -C "$STAGE" glib-2.78.6/LICENSES/LGPL-2.1-or-later.txt
cp "$STAGE/glib-2.78.6/LICENSES/LGPL-2.1-or-later.txt" "$STAGE/licenses/glib-LGPL-2.1-or-later.txt"
cp "$ZLIB_LICENSE" "$STAGE/licenses/zlib-LICENSE"
# The toolchain's runtime linked into every module (VENDORING.md): Emscripten's JS runtime and system libraries
# (MIT/NCSA), musl (MIT), compiler-rt, libc++abi and libc++ (Apache-2.0 WITH LLVM-exception), from the pinned emsdk.
# dlmalloc is CC0 (its header) and has no licence file.
E_SYS="$EMSDK/upstream/emscripten"
cp "$E_SYS/LICENSE" "$STAGE/licenses/emscripten-LICENSE"
cp "$E_SYS/system/lib/libc/musl/COPYRIGHT" "$STAGE/licenses/musl-COPYRIGHT"
cp "$E_SYS/system/lib/compiler-rt/LICENSE.TXT" "$STAGE/licenses/compiler-rt-LICENSE.TXT"
cp "$E_SYS/system/lib/libcxxabi/LICENSE.TXT" "$STAGE/licenses/libcxxabi-LICENSE.TXT"
cp "$E_SYS/system/lib/libcxx/LICENSE.TXT" "$STAGE/licenses/libcxx-LICENSE.TXT"

# The local patches (VENDORING.md, "Local changes"), applied in name order on top of the pinned sources, in both
# modes: --check proves the committed trees equal upstream plus exactly these patches.
for p in "$HERE"/patches/*.patch; do
  [ -e "$p" ] || continue
  patch -s -p1 -d "$STAGE" -i "$p"
  echo "patch applied: $(basename "$p")"
done

if [ "$MODE" = extract ]; then
  for d in $TREES; do
    if [ -e "$HERE/$d" ]; then echo "ERROR: $HERE/$d exists; use --check to compare it" >&2; exit 1; fi
  done
  for d in $TREES; do cp -R "$STAGE/$d" "$HERE/$d"; done
  echo "VENDOR-EXTRACT-OK (staging left in $STAGE)"
  exit 0
fi

status=0
for d in $TREES; do
  if diff -r "$STAGE/$d" "$HERE/$d" >/dev/null; then
    echo "$d: identical to the pinned source plus vendor/patches"
  else
    echo "$d: DIFFERS from the pinned source plus vendor/patches:" >&2
    diff -rq "$STAGE/$d" "$HERE/$d" >&2 || true
    status=1
  fi
done
if [ "$status" = 0 ]; then echo "VENDOR-CHECK-OK"; else echo "VENDOR-CHECK-FAIL"; fi
exit "$status"
