#!/usr/bin/env bash
# Download and unpack the dependency sources that the pinned Neovim lists in
# cmake.deps/deps.txt, checking each SHA256. Usage: fetch-deps.sh NAME...
set -euo pipefail
: "${NVIM_SRC:?run inside nix develop}"
: "${BUILD_DIR:?}"
dl="$BUILD_DIR/downloads"
src="$BUILD_DIR/src"
mkdir -p "$dl" "$src"
for name in "$@"; do
  [ -d "$src/$name" ] && continue
  url=$(awk -v k="${name}_URL" '$1 == k { print $2 }' "$NVIM_SRC/cmake.deps/deps.txt")
  sha=$(awk -v k="${name}_SHA256" '$1 == k { print $2 }' "$NVIM_SRC/cmake.deps/deps.txt")
  [ -n "$url" ] || { echo "no $name in deps.txt" >&2; exit 1; }
  file="$dl/$name.tar.gz"
  [ -f "$file" ] || curl -fsSL "$url" -o "$file"
  echo "$sha  $file" | shasum -a 256 -c - >/dev/null
  mkdir -p "$src/$name"
  tar -xzf "$file" -C "$src/$name" --strip-components=1
done
