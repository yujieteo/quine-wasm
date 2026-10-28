# Welcome to nvim.html

This is Neovim in one HTML file. Your files live inside the file.

- `:w` writes to the in-page file system.
- `:HtmlSave` (or the Save button) downloads a new copy of the page with your
  files, config, plugins and undo history inside it. Open that copy from any
  disk, in any browser, to continue.
- "Export files as .tar" gives `~/.config/nvim`, your plugins, your state and
  `~/work` for desktop Neovim: `tar -xf nvim-home.tar -C ~`.
- `:q` ends Neovim. Click "Run again" to start it again with the same files.

Your config is `~/.config/nvim/init.lua`. Plugins go in
`~/.local/share/nvim/site/pack/*/start/`.
