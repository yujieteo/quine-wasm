#!/usr/bin/env bash
# Build nvim.html. Run inside `nix develop`.
# BUILD_DIR holds all intermediate output (default: ./build).
set -euo pipefail
: "${NVIM_SRC:?run inside nix develop}"
ROOT=$(cd "$(dirname "$0")/.." && pwd)
export BUILD_DIR=${BUILD_DIR:-$ROOT/build}
JOBS=$(getconf _NPROCESSORS_ONLN)
SRC=$BUILD_DIR/src
PREFIX=$BUILD_DIR/wasm/usr
OBJ=$BUILD_DIR/wasm/obj
CFLAGS_DEPS=(-O2 -w)

"$ROOT/scripts/fetch-deps.sh" LIBUV LUV LUA LPEG LUA_COMPAT53 UTF8PROC TREESITTER \
  TREESITTER_C TREESITTER_LUA TREESITTER_VIM TREESITTER_VIMDOC TREESITTER_QUERY TREESITTER_MARKDOWN

# compile_lib NAME SRCDIR FILE... [-- FLAGS...]: compile into $PREFIX/lib/libNAME.a.
compile_lib() {
  local name=$1 dir=$2; shift 2
  local files=() flags=()
  while [ $# -gt 0 ] && [ "$1" != -- ]; do files+=("$1"); shift; done
  [ $# -gt 0 ] && shift && flags=("$@")
  [ -f "$PREFIX/lib/lib$name.a" ] && return
  mkdir -p "$OBJ/$name" "$PREFIX/lib"
  local objs=() f o
  for f in "${files[@]}"; do
    o="$OBJ/$name/$(echo "$f" | tr / _).o"
    objs+=("$o")
    emcc "${CFLAGS_DEPS[@]}" "${flags[@]}" -c "$dir/$f" -o "$o" &
    while [ "$(jobs -r | wc -l)" -ge "$JOBS" ]; do wait -n; done
  done
  wait
  emar rcs "$PREFIX/lib/lib$name.a" "${objs[@]}"
}

deps() {
  mkdir -p "$PREFIX/include"

  if [ ! -d "$SRC/libuv-wasm" ]; then
    cp -R "$SRC/LIBUV" "$SRC/libuv-wasm"
    patch -d "$SRC/libuv-wasm" -p1 -s < "$ROOT/patches/libuv.patch"
  fi
  cp -R "$SRC/libuv-wasm/include/." "$PREFIX/include/"
  cp "$ROOT/src/uv-wasm.c" "$SRC/libuv-wasm/src/unix/uv-wasm.c"
  compile_lib uv "$SRC/libuv-wasm/src" \
    fs-poll.c idna.c inet.c random.c strscpy.c strtok.c thread-common.c threadpool.c \
    timer.c uv-common.c uv-data-getter-setters.c version.c \
    unix/async.c unix/core.c unix/dl.c unix/fs.c unix/getaddrinfo.c unix/getnameinfo.c \
    unix/loop-watcher.c unix/loop.c unix/pipe.c unix/poll.c unix/process.c \
    unix/random-devurandom.c unix/signal.c unix/stream.c unix/tcp.c unix/thread.c \
    unix/tty.c unix/udp.c unix/posix-poll.c unix/posix-hrtime.c unix/no-proctitle.c \
    unix/no-fsevents.c unix/uv-wasm.c \
    -- -I"$SRC/libuv-wasm/include" -I"$SRC/libuv-wasm/src" -I"$SRC/libuv-wasm/src/unix" \
    -D_GNU_SOURCE -D_FILE_OFFSET_BITS=64 -D_LARGEFILE_SOURCE

  cp "$SRC"/LUA/src/{lua.h,luaconf.h,lualib.h,lauxlib.h} "$PREFIX/include/"
  compile_lib lua "$SRC/LUA/src" \
    lapi.c lcode.c ldebug.c ldo.c ldump.c lfunc.c lgc.c llex.c lmem.c lobject.c lopcodes.c \
    lparser.c lstate.c lstring.c ltable.c ltm.c lundump.c lvm.c lzio.c lauxlib.c lbaselib.c \
    ldblib.c liolib.c lmathlib.c loslib.c ltablib.c lstrlib.c loadlib.c linit.c \
    -- -DLUA_USE_POSIX

  compile_lib lpeg "$SRC/LPEG" lpcap.c lpcode.c lpcset.c lpprint.c lptree.c lpvm.c \
    -- -I"$PREFIX/include"

  mkdir -p "$PREFIX/include/luv"
  cp "$SRC"/LUV/src/{luv.h,util.h,lhandle.h,lreq.h} "$PREFIX/include/luv/"
  compile_lib luv "$SRC/LUV/src" luv.c \
    -- -I"$PREFIX/include" -I"$SRC/LUA_COMPAT53/c-api" -DLUV_STACK_CHECK=0

  cp "$SRC/UTF8PROC/utf8proc.h" "$PREFIX/include/"
  compile_lib utf8proc "$SRC/UTF8PROC" utf8proc.c -- -DUTF8PROC_STATIC

  cp -R "$SRC/TREESITTER/lib/include/." "$PREFIX/include/"
  compile_lib tree-sitter "$SRC/TREESITTER/lib/src" lib.c \
    -- -I"$SRC/TREESITTER/lib/include" -I"$SRC/TREESITTER/lib/src" -D_DEFAULT_SOURCE

  # The generated lexers are large but reducible. LLVM's pass that fixes
  # irreducible control flow is quadratic on them (the vim lexer: over an hour).
  compile_lib ts-parsers "$SRC" \
    TREESITTER_C/src/parser.c TREESITTER_LUA/src/parser.c TREESITTER_VIM/src/parser.c \
    TREESITTER_VIMDOC/src/parser.c TREESITTER_QUERY/src/parser.c \
    TREESITTER_MARKDOWN/tree-sitter-markdown/src/parser.c \
    TREESITTER_MARKDOWN/tree-sitter-markdown-inline/src/parser.c \
    -- -mllvm -wasm-disable-fix-irreducible-control-flow-pass
  compile_lib ts-scanners "$SRC" \
    TREESITTER_LUA/src/scanner.c TREESITTER_VIM/src/scanner.c \
    TREESITTER_MARKDOWN/tree-sitter-markdown/src/scanner.c \
    TREESITTER_MARKDOWN/tree-sitter-markdown-inline/src/scanner.c
}

# The code generators run on the host, through the host build of nlua0.
host_nlua0() {
  [ -f "$BUILD_DIR/host/lib/libnlua0.so" ] && return
  cmake -S "$NVIM_SRC" -B "$BUILD_DIR/host" -G Ninja -DCMAKE_BUILD_TYPE=Release \
    -DENABLE_LIBINTL=OFF >/dev/null
  ninja -C "$BUILD_DIR/host" nlua0
}

nvim() {
  if [ ! -d "$SRC/neovim" ]; then
    cp -R "$NVIM_SRC" "$SRC/neovim"
    chmod -R u+w "$SRC/neovim"
    patch -d "$SRC/neovim" -p1 -s < "$ROOT/patches/neovim.patch"
  fi
  local link=(
    -sASYNCIFY -sASYNCIFY_STACK_SIZE=1048576 -sSTACK_SIZE=8388608
    -sALLOW_MEMORY_GROWTH -sINITIAL_MEMORY=67108864
    -sMODULARIZE -sEXPORT_NAME=createNvim -sENVIRONMENT=web,node
    -sFORCE_FILESYSTEM -sEXIT_RUNTIME -sSINGLE_FILE -sSINGLE_FILE_BINARY_ENCODE=0
    -sEXPORTED_RUNTIME_METHODS=FS,ENV
    -L"$PREFIX/lib" -lts-parsers -lts-scanners
  )
  emcmake cmake -S "$SRC/neovim" -B "$BUILD_DIR/wasm/nvim" -G Ninja \
    -DCMAKE_BUILD_TYPE=Release -DPREFER_LUA=ON -DCOMPILE_LUA=OFF \
    -DENABLE_LIBINTL=OFF -DENABLE_UNIBILIUM=OFF -DENABLE_LTO=OFF \
    -DDEPS_PREFIX="$PREFIX" -DCMAKE_FIND_ROOT_PATH="$PREFIX" \
    -DLUA_LIBRARY="$PREFIX/lib/liblua.a" -DLUA_MATH_LIBRARY="$PREFIX/lib/liblua.a" \
    -DNLUA0_HOST_PRG="$BUILD_DIR/host/lib/libnlua0.so" -DLUA_GEN_PRG="$(command -v luajit)" \
    -DCMAKE_EXE_LINKER_FLAGS_RELEASE="${link[*]}" >/dev/null
  ninja -C "$BUILD_DIR/wasm/nvim" nvim_bin runtime/syntax/vim/generated.vim
}

# The read-only runtime block: $VIMRUNTIME plus help tags, parser stubs and licences.
runtime() {
  local stage=$BUILD_DIR/stage/runtime
  rm -rf "$stage"
  mkdir -p "$(dirname "$stage")"
  cp -R "$SRC/neovim/runtime" "$stage"
  rm -f "$stage/CMakeLists.txt"
  mkdir -p "$stage/syntax/vim"
  cp "$BUILD_DIR/wasm/nvim/runtime/syntax/vim/generated.vim" "$stage/syntax/vim/"
  cp -R "$ROOT/src/runtime/." "$stage/"
  command nvim -u NONE -i NONE -e --headless -c "helptags $stage/doc" -c quit
  # The parsers are linked into the engine; these files let Neovim find them.
  mkdir -p "$stage/parser"
  for lang in c lua vim vimdoc query markdown markdown_inline; do : > "$stage/parser/$lang.so"; done
  mkdir -p "$stage/licenses"
  cp "$SRC/neovim/LICENSE.txt" "$stage/licenses/neovim.txt"
  cp "$SRC/LIBUV/LICENSE" "$stage/licenses/libuv.txt"
  cp "$SRC/LUV/LICENSE.txt" "$stage/licenses/luv.txt"
  sed -n '/Copyright/,$p' "$SRC/LUA/COPYRIGHT" > "$stage/licenses/lua.txt"
  sed -n '/Copyright/,/SOFTWARE\./p' "$SRC/LPEG/lpeg.html" | sed 's/<[^>]*>//g' > "$stage/licenses/lpeg.txt"
  cp "$SRC/LUA_COMPAT53/LICENSE" "$stage/licenses/lua-compat-5.3.txt"
  cp "$SRC/UTF8PROC/LICENSE.md" "$stage/licenses/utf8proc.txt"
  cp "$SRC/TREESITTER/LICENSE" "$stage/licenses/tree-sitter.txt"
  for p in C LUA VIM VIMDOC QUERY MARKDOWN; do
    cp "$SRC/TREESITTER_$p"/LICENSE* "$stage/licenses/tree-sitter-$(echo "$p" | tr A-Z a-z).txt"
  done
  cp "$ROOT/node_modules/@xterm/xterm/LICENSE" "$stage/licenses/xterm.js.txt"
  (cd "$stage" && find . -mindepth 1 | sed 's#^\./##' | LC_ALL=C sort |
    tar --format=ustar --no-recursion --mtime=@0 --owner=0 --group=0 -cf - -T -) |
    gzip -9n > "$BUILD_DIR/stage/runtime.tar.gz"
}

# The seed home: default config and the pinned plugins from config/plugins.txt.
seed() {
  local home=$BUILD_DIR/stage/home
  local start=$home/.local/share/nvim/site/pack/plugins/start
  rm -rf "$home"
  mkdir -p "$home/.config" "$home/work" "$start"
  cp -R "$ROOT/config/nvim" "$home/.config/nvim"
  cp "$ROOT/config/welcome.md" "$home/work/welcome.md"
  local name repo commit file
  grep -v '^#' "$ROOT/config/plugins.txt" | while read -r name repo commit; do
    [ -n "$name" ] || continue
    file=$BUILD_DIR/downloads/plugin-$name-$commit.tar.gz
    [ -f "$file" ] || curl -fsSL "https://github.com/$repo/archive/$commit.tar.gz" -o "$file"
    mkdir -p "$start/$name"
    tar -xzf "$file" -C "$start/$name" --strip-components=1
    rm -rf "$start/$name"/.[!.]* "$start/$name"/tests "$start/$name"/spec
  done
}

deps
host_nlua0
nvim
runtime
seed
mkdir -p "$ROOT/docs"
node "$ROOT/scripts/pack.mjs" "$BUILD_DIR/wasm/nvim/bin/nvim.js" "$BUILD_DIR/stage/runtime.tar.gz" \
  "$BUILD_DIR/stage/home" "$ROOT/docs/nvim.html"
