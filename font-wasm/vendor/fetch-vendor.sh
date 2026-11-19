#!/usr/bin/env bash
# fetch-vendor.sh -- the pinned upstream sources of fontwrap, extracted into font-wasm/vendor/ (first time) or
# checked against their tarballs (--check). See ../VENDORING.md.
#
#   bash font-wasm/vendor/fetch-vendor.sh            extract brotli/, woff2/, libeot/ and licenses/ (refuses to
#                                                    replace a tree that exists)
#   bash font-wasm/vendor/fetch-vendor.sh --check    extract into a scratch folder, apply vendor/patches/*.patch
#                                                    and compare file by file with the committed trees; prints
#                                                    VENDOR-CHECK-OK or VENDOR-CHECK-FAIL
#
# Every tarball is GitHub's archive of a pinned commit, verified by sha256 before anything is extracted. Tarballs
# are looked for in $FONTWRAP_TARBALLS (default font-wasm/build/tarballs/, not committed) and downloaded there when
# missing. Only the subsets listed below are taken. Nothing is ever deleted.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODULE="$(dirname "$HERE")"
TARBALLS="${FONTWRAP_TARBALLS:-$MODULE/build/tarballs}"
EMSDK="${EMSDK:?Set EMSDK to an emsdk checkout with Emscripten 6.0.2 (source its emsdk_env.sh)}"
ZLIB_LICENSE="$EMSDK/upstream/emscripten/cache/ports/zlib/zlib-1.3.2/LICENSE"

MODE=extract
if [ "${1:-}" = "--check" ]; then MODE=check; elif [ -n "${1:-}" ]; then echo "usage: $0 [--check]" >&2; exit 2; fi

#        name    repo                commit                                    sha256 of the archive
PINS=(
  "brotli google/brotli      db24a98aed38a16de78cc05ca15cdd8dc2a0d92d 113b9685dfc14dd2f3360d077283266eec2fbdfb0fe3e5600f11be151da0d68e"
  "woff2  google/woff2       7b67e12355fe7da148db5c19d4261f0a498a9537 af25f87356507cd541fe02eb52145ce21d0a62b2ef028c058720ecf96ad4d7f8"
  "libeot umanwizard/libeot  dfd394c8fbb2c2bc43bb844f058d48a4ef9479e2 53f7f2250eff58c8e9b2881d8162cca1a25deba09dd638ea51039257df490f1c"
)

subset() {  # the upstream paths taken from each archive
  case "$1" in
    brotli) echo "c/common c/dec c/enc c/include" ;;
    woff2)  echo "include src" ;;
    libeot) echo "inc src" ;;
  esac
}

licences() {  # upstream licence and notice files, copied to licenses/<name>-<file>
  case "$1" in
    brotli) echo "LICENSE" ;;
    woff2)  echo "LICENSE" ;;
    libeot) echo "LICENSE PATENTS" ;;
  esac
}

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/fontwrap-vendor.XXXXXX")"
mkdir -p "$TARBALLS" "$STAGE/licenses"

for pin in "${PINS[@]}"; do
  read -r name repo commit want <<<"$pin"
  tarball="$TARBALLS/$name-$commit.tar.gz"
  if [ ! -f "$tarball" ]; then
    echo "download: https://github.com/$repo/archive/$commit.tar.gz"
    curl -sSfL -o "$tarball.part" "https://github.com/$repo/archive/$commit.tar.gz"
    mv "$tarball.part" "$tarball"
  fi
  got="$(shasum -a 256 "$tarball" | cut -d' ' -f1)"
  if [ "$got" != "$want" ]; then
    echo "ERROR: $name: sha256 $got, pinned $want" >&2
    exit 1
  fi
  echo "$name $commit sha256 ok"
  top="$(basename "$repo")-$commit"
  members=()
  for p in $(subset "$name"); do members+=("$top/$p"); done
  for f in $(licences "$name"); do members+=("$top/$f"); done
  mkdir -p "$STAGE/$name.all"
  tar -xzf "$tarball" -C "$STAGE/$name.all" --strip-components=1 "${members[@]}"
  mkdir -p "$STAGE/$name"
  for p in $(subset "$name"); do
    mkdir -p "$STAGE/$name/$(dirname "$p")"
    cp -R "$STAGE/$name.all/$p" "$STAGE/$name/$p"
  done
  for f in $(licences "$name"); do cp "$STAGE/$name.all/$f" "$STAGE/licenses/$name-$f"; done
done
cp "$ZLIB_LICENSE" "$STAGE/licenses/zlib-LICENSE"

# The local patches (VENDORING.md, "Local changes"), applied in name order on top of the pinned sources, in both
# modes: --check proves the committed trees equal upstream plus exactly these patches.
for p in "$HERE"/patches/*.patch; do
  [ -e "$p" ] || continue
  patch -s -p1 -d "$STAGE" -i "$p"
  echo "patch applied: $(basename "$p")"
done

if [ "$MODE" = extract ]; then
  for d in brotli woff2 libeot licenses; do
    if [ -e "$HERE/$d" ]; then echo "ERROR: $HERE/$d exists; use --check to compare it" >&2; exit 1; fi
  done
  for d in brotli woff2 libeot licenses; do cp -R "$STAGE/$d" "$HERE/$d"; done
  echo "VENDOR-EXTRACT-OK (staging left in $STAGE)"
  exit 0
fi

status=0
for d in brotli woff2 libeot licenses; do
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
