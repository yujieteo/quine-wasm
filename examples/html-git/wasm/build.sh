#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
rustc --edition=2021 --target wasm32-unknown-unknown --crate-type cdylib -C opt-level=3 -C panic=abort -C strip=symbols --remap-path-prefix "$(pwd)=/html-git" wasm/core.rs -o "$out/core.wasm"
node wasm/embed.js "$out/core.wasm" "${1:-}"
