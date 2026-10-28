-- Default config of nvim.html. Replace it with your own: it is a normal
-- ~/.config/nvim/init.lua, and desktop Neovim reads the same file after
-- "Export files as .tar".

vim.g.mapleader = ' '

vim.o.number = true
vim.o.undofile = true
vim.o.expandtab = true
vim.o.shiftwidth = 2
vim.o.tabstop = 2
vim.o.ignorecase = true
vim.o.smartcase = true
vim.o.splitright = true
vim.o.splitbelow = true
vim.o.signcolumn = 'yes'
vim.o.cursorline = true

vim.keymap.set('n', '<leader>w', '<cmd>write<cr>', { desc = 'Write file' })
vim.keymap.set('n', '<leader>s', '<cmd>HtmlSave<cr>', { desc = 'Save a copy of the page' })

-- Tree-sitter highlighting for the built-in parsers.
vim.api.nvim_create_autocmd('FileType', {
  pattern = { 'c', 'lua', 'vim', 'help', 'query', 'markdown' },
  callback = function()
    pcall(vim.treesitter.start)
  end,
})

local ok, lualine = pcall(require, 'lualine')
if ok then
  lualine.setup({ options = { icons_enabled = false, section_separators = '', component_separators = '|' } })
end

local ok_surround, surround = pcall(require, 'nvim-surround')
if ok_surround then
  surround.setup()
end
