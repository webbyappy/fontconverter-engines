#!/usr/bin/env bash
# fetch-vendor.sh -- the pinned HarfBuzz release source of hbfont, extracted into harfbuzz-wasm/vendor/ (first time)
# or checked against its tarball (--check). See ../VENDORING.md.
#
#   bash harfbuzz-wasm/vendor/fetch-vendor.sh            extract harfbuzz/ and licenses/ (refuses to replace a tree
#                                                        that exists)
#   bash harfbuzz-wasm/vendor/fetch-vendor.sh --check    extract into a scratch folder, apply vendor/patches/*.patch
#                                                        and compare file by file with the committed trees; prints
#                                                        VENDOR-CHECK-OK or VENDOR-CHECK-FAIL
#
# The tarball is HarfBuzz's own release archive (meson dist of the 15.0.0 tag), verified by sha256 before anything is
# extracted. It is looked for in $HBFONT_TARBALLS (default harfbuzz-wasm/build/tarballs/, not committed) and
# downloaded there when missing. Only the subset below is taken: the C++ sources and headers of src/ (top level, OT/,
# graph/); no test font, no binary, no Rust or wasm-shaper tree. Nothing is ever deleted.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODULE="$(dirname "$HERE")"
TARBALLS="${HBFONT_TARBALLS:-$MODULE/build/tarballs}"
EMSDK="${EMSDK:?Set EMSDK to an emsdk checkout with Emscripten 6.0.2 (source its emsdk_env.sh)}"
ZLIB_LICENSE="$EMSDK/upstream/emscripten/cache/ports/zlib/zlib-1.3.2/LICENSE"

VERSION=15.0.0
URL="https://github.com/harfbuzz/harfbuzz/releases/download/$VERSION/harfbuzz-$VERSION.tar.xz"
WANT=968536e9abd782f07f7954044c0c4020199fcdd39b41d221ec42d2a3be4a44df

MODE=extract
if [ "${1:-}" = "--check" ]; then MODE=check; elif [ -n "${1:-}" ]; then echo "usage: $0 [--check]" >&2; exit 2; fi

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/hbfont-vendor.XXXXXX")"
mkdir -p "$TARBALLS" "$STAGE/licenses" "$STAGE/all" "$STAGE/harfbuzz/src"

tarball="$TARBALLS/harfbuzz-$VERSION.tar.xz"
if [ ! -f "$tarball" ]; then
  echo "download: $URL"
  curl -sSfL -o "$tarball.part" "$URL"
  mv "$tarball.part" "$tarball"
fi
got="$(shasum -a 256 "$tarball" | cut -d' ' -f1)"
if [ "$got" != "$WANT" ]; then
  echo "ERROR: harfbuzz: sha256 $got, pinned $WANT" >&2
  exit 1
fi
echo "harfbuzz $VERSION sha256 ok"
tar -xJf "$tarball" -C "$STAGE/all" --strip-components=1 "harfbuzz-$VERSION/src" "harfbuzz-$VERSION/COPYING"

# The subset: src/*.cc, src/*.hh, src/*.h (top level), src/OT/ and src/graph/ whole.
for f in "$STAGE/all/src"/*.cc "$STAGE/all/src"/*.hh "$STAGE/all/src"/*.h; do cp "$f" "$STAGE/harfbuzz/src/"; done
cp -R "$STAGE/all/src/OT" "$STAGE/harfbuzz/src/OT"
cp -R "$STAGE/all/src/graph" "$STAGE/harfbuzz/src/graph"
cp "$STAGE/all/COPYING" "$STAGE/licenses/harfbuzz-COPYING"
cp "$ZLIB_LICENSE" "$STAGE/licenses/zlib-LICENSE"

# No binary file enters the subset (the release's only one in src/ is wasm/sample/c/test.ttf, outside it).
if find "$STAGE/harfbuzz" -type f -print0 | xargs -0 file | grep -v -E ':.*(text|empty)' | grep -q .; then
  echo "ERROR: a file in the subset is not text:" >&2
  find "$STAGE/harfbuzz" -type f -print0 | xargs -0 file | grep -v -E ':.*(text|empty)' >&2
  exit 1
fi

# The local patches (VENDORING.md, "Local changes"), applied in name order, in both modes.
for p in "$HERE"/patches/*.patch; do
  [ -e "$p" ] || continue
  patch -s -p1 -d "$STAGE" -i "$p"
  echo "patch applied: $(basename "$p")"
done

if [ "$MODE" = extract ]; then
  for d in harfbuzz licenses; do
    if [ -e "$HERE/$d" ]; then echo "ERROR: $HERE/$d exists; use --check to compare it" >&2; exit 1; fi
  done
  for d in harfbuzz licenses; do cp -R "$STAGE/$d" "$HERE/$d"; done
  echo "VENDOR-EXTRACT-OK (staging left in $STAGE)"
  exit 0
fi

status=0
for d in harfbuzz licenses; do
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
