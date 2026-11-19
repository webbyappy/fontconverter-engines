"""Seed Emscripten 6.0.2's FreeType and zlib ports into a private cache from local archives, so a build downloads
nothing (P2 plan, P2-10).

Emscripten fetches a port only when `<cache>/ports/<name>/.emscripten_url` is missing or names another URL
(tools/ports/__init__.py, fetch_project). This does what its unpack step does: check the archive against the port's
own sha512 pin, unpack it into `<name>.tmp`, write the marker, rename. A port already seeded with the right marker is
left alone; one with another marker is an error (nothing is ever deleted here).

    python3 -I deps/seed_ports.py <EM_CACHE> <freetype-VER-2-13-3.zip> <zlib v1.3.2 .tar.gz>
"""
import hashlib
import os
import shutil
import sys

# name -> (the URL emsdk 6.0.2 fetches, its sha512 pin), from tools/ports/freetype.py and tools/ports/zlib.py
PORTS = {
    "freetype": ("https://github.com/freetype/freetype/archive/VER-2-13-3.zip",
                 "ce413487c24e689631d705f53b64725256f89fffe9aade7cf07bbd785a9cd49eb6b8d2297a55554f3fee0a50b17e8af78f"
                 "505cdab565768afab833794f968c2f"),
    "zlib": ("https://github.com/madler/zlib/archive/refs/tags/v1.3.2.tar.gz",
             "16fea4df307a68cf0035858abe2fd550250618a97590e202037acd18a666f57afc10f8836cbbd472d54a0e76539d0e558cb26f"
             "059d53de52ff90634bbf4f47d4"),
}
MARKER = ".emscripten_url"


def seed(cache, name, archive):
    url, pin = PORTS[name]
    target = os.path.join(cache, "ports", name)
    marker = os.path.join(target, MARKER)
    if os.path.exists(marker):
        with open(marker, encoding="utf-8") as fh:
            if fh.read().strip() == url:
                print(f"seed_ports: {name} already seeded")
                return
        sys.exit(f"seed_ports: {target} holds another port version; use a fresh BUILD_DIR")
    if os.path.exists(target):
        sys.exit(f"seed_ports: {target} exists without a marker; use a fresh BUILD_DIR")
    with open(archive, "rb") as fh:
        got = hashlib.sha512(fh.read()).hexdigest()
    if got != pin:
        sys.exit(f"seed_ports: {archive} sha512 {got[:16]}…, emsdk pins {pin[:16]}…")
    tmp = target + ".tmp"
    if os.path.exists(tmp):
        sys.exit(f"seed_ports: {tmp} left from an interrupted run; use a fresh BUILD_DIR")
    os.makedirs(tmp)
    shutil.unpack_archive(filename=archive, extract_dir=tmp)
    with open(os.path.join(tmp, MARKER), "w", encoding="utf-8") as fh:
        fh.write(url + "\n")
    os.replace(tmp, target)
    print(f"seed_ports: {name} seeded from {os.path.basename(archive)}")


def main():
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    cache, freetype, zlib = sys.argv[1:]
    seed(cache, "freetype", freetype)
    seed(cache, "zlib", zlib)


if __name__ == "__main__":
    main()
