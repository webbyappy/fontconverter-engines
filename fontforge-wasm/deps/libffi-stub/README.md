# deps/libffi-stub: the house libffi stub

`src/ffi.c` and `include/ffi.h` are byte-for-byte copies of `libmirage-wasm/deps/libffi-wasm/` at wasm repo commit
`01d5be4a2` (sha256 prefixes `a189847d803a9625` and `e973bccb1f7067da`): the owner's own code, a minimal
`ffi_prep_cif`/`ffi_call` for GObject's generic marshaller under Emscripten.

`ffconv` needs it only because GLib's meson configure requires a libffi. `build-deps.sh` compiles it into
`build/` and writes a `libffi.pc` for that configure. The final link of `ffconv` does not name it, nor libgobject or
libgmodule: FontForge references none of them (S1 measured 0 bytes linked; P2's closing review re-checked that the
wasm is byte-identical without them), so any future reference fails to link.

It is copied rather than referenced so that `fontforge-wasm/` stands alone in the public source repository (D2).

Licence: MIT (`LICENSE`), named by the owner on 2026-11-19 (fontconverter-web P5 plan, O7) before the public source
repository was published. It is not part of `ffconv` (not linked), so the artifact's licence (GPL-3.0-or-later) does not
depend on it.
