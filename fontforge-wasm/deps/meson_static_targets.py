"""Print the ninja outputs of every installed static library of a meson build directory, one per line, relative to
it (build-deps.sh builds only these, then `meson install --tags devel --no-rebuild`: GLib's command line tools do not
link under Emscripten and are never needed). After spike S1's glib_devel_targets.py.

    python3 -I deps/meson_static_targets.py <meson build dir>
"""
import json
import os
import sys

build = os.path.abspath(sys.argv[1])
with open(os.path.join(build, "meson-info", "intro-targets.json"), encoding="utf-8") as fh:
    for target in json.load(fh):
        if target.get("installed") and target.get("type") == "static library":
            for name in target.get("filename", []):
                print(os.path.relpath(name, build))
