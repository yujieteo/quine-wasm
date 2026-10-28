#!/bin/sh
set -eu
# Run with emcc, cmake, and Node on PATH. Keep all build data in this repository.
cd "$(dirname "$0")/.."
: "${QUINE_WASM_DIR:?Set QUINE_WASM_DIR to the quine-wasm clone}"
test "$(git -C "$QUINE_WASM_DIR" rev-parse HEAD)" = 21d6f08ddbd46fa2fe5dd198a5435e91c7dbb6fa
source_dir=data/wasm-build/libgit2
build_dir=data/wasm-build/obj
# Pin the source tree that this probe tests.
test "$(git -C "$source_dir" rev-parse HEAD)" = 0060d9cf5666f015b1067129bd874c6cc4c9c7ac
if git -C "$source_dir" apply --check "$PWD/wasm/libgit2-size-t.patch" 2>/dev/null; then
  git -C "$source_dir" apply "$PWD/wasm/libgit2-size-t.patch"
else
  git -C "$source_dir" apply --reverse --check "$PWD/wasm/libgit2-size-t.patch"
fi
emcmake cmake -S "$source_dir" -B "$build_dir" \
  -DCMAKE_BUILD_TYPE=MinSizeRel -DBUILD_SHARED_LIBS=OFF \
  -DBUILD_TESTS=OFF -DBUILD_CLI=OFF -DUSE_THREADS=OFF \
  -DUSE_SSH=OFF -DUSE_HTTPS=OFF -DUSE_GSSAPI=OFF -DUSE_NTLMCLIENT=OFF \
  -DUSE_BUNDLED_ZLIB=ON -DREGEX_BACKEND=builtin \
  -DUSE_SHA1=CollisionDetection -DUSE_SHA256=Builtin
cmake --build "$build_dir" --parallel 4
node "$QUINE_WASM_DIR/bin/quine-wasm.js" \
  -o data/wasm-build/probe.html --title 'html-git libgit2 probe' \
  --prefix /quine-data --exclude '**' -- \
  -Oz -sSTACK_SIZE=131072 -sSTACK_OVERFLOW_CHECK=2 \
  -I"$source_dir/include" wasm/probe.c "$build_dir/libgit2.a"
node wasm/notices.js "$source_dir" data/wasm-build/probe.html
