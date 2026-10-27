#!/bin/sh
# Builds the test programs into build/. Needs emcc and node on PATH.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
node "$root/bin/quine-wasm.js" -o "$root/build/termtest.html" --ctrl-s program \
  --runtime "$root/tests/termtest/runtime:/usr/share/termtest" -- -O2 "$root/tests/termtest/termtest.c"
