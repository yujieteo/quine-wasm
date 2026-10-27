# nvim-html

Neovim with a full Lua config and plugins in one portable HTML file.

Open [`docs/nvim.html`](docs/nvim.html) from disk (`file://`) or from any web server.
The page needs no install and no network.
Your files live inside the page. Save downloads a new copy of the page with your files in it.

## What works

- Neovim 0.12.6 (PUC Lua 5.1, not LuaJIT), compiled to WebAssembly with Emscripten.
- Your config in `~/.config/nvim`. The default `init.lua` is a small example. Replace it.
- Lua and Vimscript plugins in `~/.local/share/nvim/site/pack/*/start`.
  The default page has [lualine.nvim](https://github.com/nvim-lualine/lualine.nvim) and [nvim-surround](https://github.com/kylechui/nvim-surround).
- Tree-sitter parsers for `c`, `lua`, `vim`, `vimdoc`, `query` and `markdown` (with `markdown_inline`).
- Timers, `vim.uv` timers, `vim.wait`, undo files, ShaDa and swap files.
- `:HtmlSave` (or the Save button) downloads a copy of the page with these folders:
  - `~/.config/nvim`
  - `~/.local/share/nvim/site`
  - `~/.local/state/nvim` (without swap files and logs)
  - `~/work` (the start folder)
- The "Export files as .tar" button downloads the same folders as a tar file.
  Desktop Neovim reads them: `tar -xf nvim-home.tar -C ~`.

## What does not work

- No LSP and no external programs: `:!`, `jobstart`, `vim.system` and `:terminal` give an error.
  `system()` sets `v:shell_error` to -1.
- No sockets, no `serverstart` and no clipboard provider. Use the browser paste (Ctrl+Shift+V or Cmd+V).
- No git plugin managers (lazy.nvim, packer and similar). They need git and processes.
- No parsers other than the 6 parsers above, and no compiled (C) plugins.
- No mouse.
- The browser keeps some keys, for example Ctrl+W, Ctrl+T and Ctrl+N in most browsers.
- A file outside the 4 folders above stays only until you close the page.

## Size and startup time

- `docs/nvim.html` is 22.3 MB: the Neovim engine (13.6 MB), the gzip runtime (5.7 MB as base64), xterm.js and the files.
- Neovim shows its first screen 0.5 to 0.7 seconds after the page opens (Chromium and WebKit on an Apple M-series Mac, `file://`).

## Add a plugin

1. Add a line `name owner/repo commit` to [`config/plugins.txt`](config/plugins.txt).
   Use only Lua or Vimscript plugins.
2. Add the setup code to [`config/nvim/init.lua`](config/nvim/init.lua).
3. Build the page (see below).

You can also make a plugin inside the page.
Write its files in `~/.local/share/nvim/site/pack/my/start/NAME/`, then run `:HtmlSave`.

## Build

The toolchain comes from Nix only (Emscripten, Node.js, CMake, the pinned Neovim source).
Install nothing globally.

```sh
npm ci
nix develop --command ./scripts/build.sh   # writes docs/nvim.html; BUILD_DIR=./build by default
```

The build does these steps:

1. It downloads the Neovim dependencies, with the URLs and SHA-256 sums from Neovim's `cmake.deps/deps.txt`.
2. It compiles libuv (with [`patches/libuv.patch`](patches/libuv.patch)), Lua 5.1, LPeg, luv, utf8proc, tree-sitter and the parsers to WebAssembly.
3. It compiles Neovim with [`patches/neovim.patch`](patches/neovim.patch), which links the parsers into the engine.
4. It packs the engine, the runtime, the config and the plugins into one page ([`scripts/pack.mjs`](scripts/pack.mjs)).

## How it works

- WebAssembly has no processes. Thus the page runs `nvim --embed`, and a small msgpack-RPC client in the page draws the UI in xterm.js.
- Asyncify lets Neovim wait in `poll()` while the browser runs. Timers use `setTimeout`.
- All files are in memory (MEMFS). The runtime is a read-only gzip block, which the page unpacks with `DecompressionStream`.
- The user files are in a JSON block (`<script id="store">`) in the page. Save writes a new page with a new store block.

The page format follows the store and save design of [quine-wasm](https://github.com/yujieteo/quine-wasm).
quine-wasm is a general tool for single-file WebAssembly apps that keep their files in the page.

## Test

```sh
nix develop --command npx playwright test
```

The test runs in Chromium, Firefox and WebKit:

1. It adds a mapping to `init.lua`, edits a file and makes an undo step.
2. It exports the tar file and runs desktop `nvim --headless` on it to check the mapping and the plugin.
3. It runs `:HtmlSave` and opens the copy from `file://` in a new browser profile.
4. It checks the mapping, the plugin, the file and the undo step.

The `idbfs-control` project runs the same test on a page that keeps the files in IndexedDB.
That test must fail, because the files do not travel with the copy.

## Licences

The code of this repository is MIT ([LICENSE](LICENSE)).
Neovim is Apache-2.0 and Vim licence. Its notices, and the notices of all other bundled code, are in `$VIMRUNTIME/licenses` inside the page.
