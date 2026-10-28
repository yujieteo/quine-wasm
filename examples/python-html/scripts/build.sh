#!/usr/bin/env bash
# Build build/python.html: CPython for wasm32-emscripten, linked by quine-wasm.
# Run inside `nix develop` (Node.js, Python, pkg-config). The build fetches the
# pinned emsdk itself, because Pyodide's packages need the same Emscripten.
# BUILD_DIR holds all intermediate output (default: ./build).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
BUILD_DIR=${BUILD_DIR:-$ROOT/build}
mkdir -p "$BUILD_DIR/dl"
BUILD_DIR=$(cd "$BUILD_DIR" && pwd)
DL=$BUILD_DIR/dl

PY_VERSION=3.14.10
PY_SHA=9e4996c19ae5a3df31f10c37723661f71d3455d73bd005f79df7098e5cc13192
# Pyodide 314.0.7 uses Emscripten 5.0.3. Its packages load only into a Python
# that is linked by the same Emscripten.
EMSDK_COMMIT=d7b4130688bfa348392b921ab04015aa15c4f154
EMSCRIPTEN_VERSION=5.0.3
XZ_VERSION=5.8.1
XZ_SHA=507825b599356c10dca1cd720c9d0d0c9d5400b9de300af00e4d1ea150795543
# Side modules (Pyodide's packages) use wasm exceptions and wasm setjmp. The
# main module must use the same, so that it defines their tags.
WASM_EH="-fwasm-exceptions -sSUPPORT_LONGJMP=wasm"

SRC=$BUILD_DIR/Python-$PY_VERSION
CROSS=$SRC/cross-build
HOST=$CROSS/wasm32-emscripten/build/python
PREFIX=$CROSS/wasm32-emscripten/prefix
STAGE=$BUILD_DIR/stage
PYODIDE_CDN=https://cdn.jsdelivr.net/pyodide/v314.0.7/full

fetch() { # fetch URL FILE SHA256
  [ -f "$2" ] || curl -fsSL "$1" -o "$2"
  echo "$3  $2" | shasum -a 256 -c - >/dev/null
}

emsdk() {
  if [ ! -d "$BUILD_DIR/emsdk" ]; then
    git clone -q https://github.com/emscripten-core/emsdk.git "$BUILD_DIR/emsdk"
    git -C "$BUILD_DIR/emsdk" checkout -q "$EMSDK_COMMIT"
  fi
  if [ ! -x "$BUILD_DIR/emsdk/upstream/emscripten/emcc" ]; then
    "$BUILD_DIR/emsdk/emsdk" install "$EMSCRIPTEN_VERSION"
    "$BUILD_DIR/emsdk/emsdk" activate "$EMSCRIPTEN_VERSION" >/dev/null
  fi
  # shellcheck disable=SC1091
  EMSDK_QUIET=1 source "$BUILD_DIR/emsdk/emsdk_env.sh"
}

cpython_src() {
  [ -d "$SRC" ] && return
  fetch "https://www.python.org/ftp/python/$PY_VERSION/Python-$PY_VERSION.tgz" "$DL/Python-$PY_VERSION.tgz" "$PY_SHA"
  tar -xzf "$DL/Python-$PY_VERSION.tgz" -C "$BUILD_DIR"
  for p in "$ROOT"/patches/cpython-*.patch; do patch -d "$SRC" -p1 -s < "$p"; done
}

# platform STEP [ARGS...]: one step of CPython's own Emscripten build.
platform() { (cd "$SRC" && python3 Platforms/emscripten "$@" --quiet); }

native() {
  [ -x "$CROSS/build/python.exe" ] || [ -x "$CROSS/build/python" ] && return
  # The host C compiler: on macOS a Nix gcc cannot compile CPython's os_log calls.
  platform configure-build-python -- CC="${BUILD_CC:-cc}"
  platform make-build-python
}

deps() {
  platform make-dependencies
  [ -f "$PREFIX/lib/liblzma.a" ] && return
  fetch "https://github.com/tukaani-project/xz/releases/download/v$XZ_VERSION/xz-$XZ_VERSION.tar.gz" \
    "$DL/xz-$XZ_VERSION.tar.gz" "$XZ_SHA"
  rm -rf "$BUILD_DIR/xz-$XZ_VERSION"
  tar -xzf "$DL/xz-$XZ_VERSION.tar.gz" -C "$BUILD_DIR"
  (cd "$BUILD_DIR/xz-$XZ_VERSION" &&
    emconfigure ./configure CFLAGS="-O2 -fPIC $WASM_EH" --prefix="$PREFIX" --disable-shared \
      --disable-threads --disable-nls --disable-xz --disable-xzdec --disable-lzmadec \
      --disable-lzmainfo --disable-lzma-links --disable-scripts --disable-doc >/dev/null &&
    emmake make -j"$(getconf _NPROCESSORS_ONLN)" install >/dev/null)
}

host() {
  [ -f "$HOST/Makefile" ] || platform configure-host --host-runner node -- \
    "CFLAGS=-DPY_CALL_TRAMPOLINE -sUSE_BZIP2 $WASM_EH" "LDFLAGS=$WASM_EH" --disable-test-modules
  platform make-host
}

# The read-only runtime block of a page, unpacked at /usr/local: the standard
# library as a zip of .pyc files, the packages, python-html's modules and the licences.
# runtime PAGE: PAGE is python (the "all" packages) or python-sci (all packages).
runtime() {
  local rt=$STAGE/$1 sp
  sp=$rt/lib/python3.14/site-packages
  rm -rf "$rt"
  mkdir -p "$rt/lib/python3.14/lib-dynload" "$sp" "$rt/share/licenses"
  "$BUILD_PYTHON" "$ROOT/scripts/stdlib_zip.py" "$SRC/Lib" \
    "$(ls "$HOST"/build/lib.emscripten-*/_sysconfigdata_*.py)" "$rt/lib/python314.zip"
  : > "$rt/lib/python3.14/lib-dynload/.empty"
  cp "$ROOT"/src/python/*.py "$sp/"
  local file sha page
  grep -v '^#' "$ROOT/config/packages.txt" | while read -r file sha page; do
    [ "$page" = all ] || [ "$1" = python-sci ] || continue
    fetch "$PYODIDE_CDN/$file" "$DL/$file" "$sha"
    unzip -qo "$DL/$file" -d "$sp"
  done
  # Tests and type stubs are not needed to run the packages. Each package keeps
  # its licence files in its .dist-info folder.
  find "$sp" -type d -name tests -prune -exec rm -rf {} +
  find "$sp" -name '*.pyi' -delete
  # Bytecode only, as in the standard library zip: a package imports 3 to 6 times
  # faster when Python does not compile it at each start. unchecked-hash: the
  # files get a new mtime at each start, so Python must not compare it.
  "$BUILD_PYTHON" -m compileall -q -b -j0 --invalidation-mode unchecked-hash \
    -s "$sp" -p /usr/local/lib/python3.14/site-packages "$sp" >/dev/null
  find "$sp" -name '*.py' | while read -r f; do [ ! -f "${f}c" ] || rm "$f"; done
  cp "$SRC/LICENSE" "$rt/share/licenses/cpython.txt"
  # The notices of the code that CPython bundles: expat, mpdecimal, HACL*, libb2 and others.
  cp "$SRC/Doc/license.rst" "$rt/share/licenses/cpython-bundled.rst"
  cp "$BUILD_DIR/xz-$XZ_VERSION/COPYING" "$rt/share/licenses/xz.txt"
  cp "$ROOT/node_modules/@xterm/xterm/LICENSE" "$rt/share/licenses/xterm.js.txt"
  cp "$ROOT/node_modules/quine-wasm/LICENSE" "$rt/share/licenses/quine-wasm.txt"
}

# link PAGE TITLE: link the engine with quine-wasm into build/PAGE.html.
link() {
  local objs
  objs=$(printf 'pyhtml-print:\n\t@echo $(LINK_PYTHON_OBJS) $(LIBS) $(MODLIBS) $(SYSLIBS)\n' |
    make -s -C "$HOST" -f Makefile -f - pyhtml-print)
  objs=$(echo "$objs" | tr ' ' '\n' | grep -v '^Programs/python.o$' | sed "s#^\([A-Za-z_]*/\)#$HOST/\1#" | tr '\n' ' ')
  emcc -O2 $WASM_EH -I"$HOST" -I"$SRC/Include" -c "$ROOT/src/pyhtml.c" -o "$BUILD_DIR/pyhtml.o"
  # shellcheck disable=SC2086
  node "$ROOT/node_modules/quine-wasm/bin/quine-wasm.js" -o "$BUILD_DIR/$1.html" \
    --title "$2" --args "python" --seed "$ROOT/home" --runtime "$STAGE/$1:/usr/local" -- \
    -O2 $WASM_EH -sWASM_BIGINT -sMAIN_MODULE -sSTACK_SIZE=5MB -sINITIAL_MEMORY=33554432 \
    -sTEXTDECODER=2 --js-library "$ROOT/src/lib_pyhtml.js" "$BUILD_DIR/pyhtml.o" $objs
  node "$ROOT/scripts/add-notebook.mjs" "$BUILD_DIR/$1.html"
}

emsdk
cpython_src
native
deps
host
BUILD_PYTHON=$CROSS/build/python.exe # macOS names it python.exe
[ -f "$BUILD_PYTHON" ] || BUILD_PYTHON=$CROSS/build/python
for page in ${PAGES:-python python-sci}; do
  runtime "$page"
  case $page in
    python) link python "Python" ;;
    python-sci) link python-sci "Python with numpy, scipy, pandas and matplotlib" ;;
  esac
done
