#!/usr/bin/env bash
# Rebuild the three engines from this folder into their output/ folders, with a fresh Emscripten cache seeded from
# archives/: nothing is downloaded and no other cache is read. Then check the result against the shipped files:
#
#   EMSDK=/path/to/emsdk MESON=/path/to/meson bash build-all.sh
#   shasum -a 256 -c SHA256SUMS
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${EMSDK:?Set EMSDK to an emsdk checkout with Emscripten 6.0.2}"
: "${MESON:?Set MESON to meson 1.10.2 (fontforge-wasm/requirements-build.txt)}"
# emsdk_env.sh clears EM_CACHE, so it is sourced here first and the private cache set after it: the engine scripts then
# find emcc on PATH, do not source it again, and build into the private cache.
set +u
# shellcheck disable=SC1091
source "$EMSDK/emsdk_env.sh" >/dev/null 2>&1
set -u
export GLIB_TARBALL="$ROOT/archives/glib-2.78.6.tar.xz"
export FREETYPE_ZIP="$ROOT/archives/freetype-VER-2-13-3.zip"
export ZLIB_TARBALL="$ROOT/archives/zlib.3.2.tar.gz"
export EM_CACHE="$ROOT/build-cache/emcache"
mkdir -p "$EM_CACHE"
python3 -I "$ROOT/fontforge-wasm/deps/seed_ports.py" "$EM_CACHE" "$FREETYPE_ZIP" "$ZLIB_TARBALL"
bash "$ROOT/font-wasm/build-font-wasm.sh"
bash "$ROOT/harfbuzz-wasm/build-hbfont-wasm.sh"
bash "$ROOT/fontforge-wasm/build-deps.sh"
bash "$ROOT/fontforge-wasm/build-ffconv-wasm.sh"
# The two engines that use EM_CACHE must have built their system libraries and zlib into it, not read another cache.
if ! find "$EM_CACHE/sysroot" -name 'libz.a' 2>/dev/null | grep -q .; then
  echo "Error: no libraries were built into $EM_CACHE: another Emscripten cache was used" >&2
  exit 1
fi
echo "built. Now: shasum -a 256 -c SHA256SUMS"
