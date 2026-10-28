-- nvim.html page commands. The page listens for "nvim_html" notifications on
-- the UI channel; see src/page/app.js.

local function notify_page(...)
  for _, ui in ipairs(vim.api.nvim_list_uis()) do
    if ui.chan then
      vim.rpcnotify(ui.chan, 'nvim_html', ...)
    end
  end
end

-- Write files that Neovim keeps in memory (ShaDa) before the page reads MEMFS.
function _G.nvim_html_flush()
  pcall(vim.cmd, 'wshada!')
end

vim.api.nvim_create_user_command('HtmlSave', function()
  notify_page('save')
end, { desc = 'Download a copy of this page with your files inside it' })

