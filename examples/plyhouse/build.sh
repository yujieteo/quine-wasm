#!/bin/sh
# Build plyhouse.html: Goose -> C -> WebAssembly, inlined into one offline page.
# Needs GOOSE (path to the goose binary) and the emsdk environment (emcc on PATH).
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
B="$HERE/build"
mkdir -p "$B"
: "${GOOSE:?set GOOSE to the goose binary}"
"$GOOSE" --standalone --header "$B/plyhouse.h" -o "$B/plyhouse.c" "$HERE/solver/plyhouse.goose"
# Goose reserves data stack address space with mmap. WebAssembly cannot, so the reserve is
# set small. The solver keeps its large arrays in globals, not on the data stacks.
emcc -O2 "-DGS_STACK_RESERVE=(1ull<<20)" -I"$B" "$HERE/web/host.c" "$B/plyhouse.c" -o "$B/plyhouse.js" \
  -sSINGLE_FILE=1 -sENVIRONMENT=web -sMODULARIZE=1 -sEXPORT_NAME=PlyhouseModule -sALLOW_MEMORY_GROWTH=1 \
  -sEXPORTED_FUNCTIONS=_main,_lam_clear,_ply_add,_set_load,_set_plate,_set_envelope,_set_lpf,_solve,_res
# The page has one marker line, replaced by the module.
sed -e "/@@PLYHOUSE_MODULE@@/{r $B/plyhouse.js" -e 'd' -e '}' "$HERE/web/page.html" > "$HERE/plyhouse.html"
ls -l "$HERE/plyhouse.html"
