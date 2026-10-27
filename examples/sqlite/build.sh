#!/bin/sh
# Builds the SQLite shell demo and its IDBFS control build.
# Usage: sh examples/sqlite/build.sh [OUTDIR]   (default OUTDIR: build)
# Needs emcc and node on PATH, for example from `nix develop`.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
out=${1:-$root/build}
ver=3500400
sha=1d3049dd0f830a025a53105fc79fd2ab9431aea99e137809d064d8ee8356b032
src=$root/build/sqlite-amalgamation-$ver
mkdir -p "$root/build" "$out"
if [ ! -f "$src/shell.c" ]; then
  zip=$root/build/sqlite-$ver.zip
  curl -sSfL -o "$zip" "https://sqlite.org/2025/sqlite-amalgamation-$ver.zip"
  echo "$sha  $zip" | shasum -a 256 -c -
  (cd "$root/build" && unzip -qo "$zip")
fi
cflags="-O2 -DSQLITE_THREADSAFE=0 -DSQLITE_OMIT_LOAD_EXTENSION $src/shell.c $src/sqlite3.c"
node "$root/bin/quine-wasm.js" -o "$out/sqlite.html" --title "SQLite shell" --args "sqlite3 demo.db" -- $cflags
node "$root/bin/quine-wasm.js" -o "$out/sqlite-idbfs.html" --title "SQLite shell (IDBFS control)" \
  --args "sqlite3 demo.db" --persist idbfs -- $cflags
