// Acceptance test: edit the config and a file, save a copy of the page, open
// the copy in a new browser profile and find everything there again.
const { test, expect } = require('@playwright/test');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PAGE = path.resolve(__dirname, '../docs/nvim.html');
const MAPPING = `vim.keymap.set('n', 'gX', '<cmd>echo "mapping ok"<cr>')`;

async function open(page, file) {
  await page.goto(pathToFileURL(file).href);
  await page.waitForFunction(() => window.nvimHtml && window.nvimHtml.flushes > 0, null, { timeout: 60_000 });
}

const screen = (page) => page.evaluate(() => window.nvimHtml.lines().join('\n'));
const waitScreen = (page, re) => expect.poll(() => screen(page), { timeout: 15_000 }).toMatch(re);

async function cmd(page, command) {
  await page.keyboard.type(':' + command);
  await page.keyboard.press('Enter');
}

async function insert(page, keys, text) {
  await page.keyboard.type(keys + text);
  await page.keyboard.press('Escape');
}

async function download(page, action, file) {
  const event = page.waitForEvent('download');
  await action();
  await (await event).saveAs(file);
}

test('config, plugin, file and undo survive Save', async ({ page, browser }, testInfo) => {
  const control = !!testInfo.project.metadata.control;
  test.fail(control, 'files in IndexedDB do not travel with the saved page');
  let file = PAGE;
  if (control) {
    file = testInfo.outputPath('nvim-idbfs.html');
    const html = fs.readFileSync(PAGE, 'utf8');
    const flag = 'const CONTROL_IDBFS = false;';
    expect(html).toContain(flag);
    fs.writeFileSync(file, html.replace(flag, 'const CONTROL_IDBFS = true;'));
  }

  await open(page, file);
  await waitScreen(page, /NORMAL/); // lualine draws the mode

  await cmd(page, 'edit ~/.config/nvim/init.lua');
  await waitScreen(page, /Default config of nvim\.html/);
  await insert(page, 'Go', MAPPING);
  await cmd(page, 'write');
  await waitScreen(page, /init\.lua.*written/);

  await cmd(page, 'edit ~/work/notes.txt');
  await insert(page, 'i', 'first line');
  await cmd(page, 'write');
  await insert(page, 'o', 'second line');
  await cmd(page, 'write');
  await waitScreen(page, /notes\.txt.*2L.*written/);

  // Export: desktop Neovim reads the same files.
  const tarFile = testInfo.outputPath('nvim-home.tar');
  await download(page, () => page.click('#export'), tarFile);
  const home = testInfo.outputPath('home');
  fs.mkdirSync(home);
  expect(spawnSync('tar', ['-xf', tarFile, '-C', home]).status).toBe(0);
  expect(fs.readFileSync(path.join(home, 'work/notes.txt'), 'utf8')).toBe('first line\nsecond line\n');
  const env = { ...process.env, HOME: home };
  for (const k of Object.keys(env)) if (k.startsWith('XDG_') || k.startsWith('NVIM')) delete env[k];
  const native = spawnSync(process.env.NVIM_BIN || 'nvim', ['--headless', '-c',
    `lua io.stdout:write(vim.fn.maparg('gX', 'n'), ' lualine=', tostring(package.loaded.lualine ~= nil), '\\n')`,
    '-c', 'qa!'], { env, encoding: 'utf8', timeout: 30_000 });
  expect(native.stdout + native.stderr).toContain('<Cmd>echo "mapping ok"<CR> lualine=true');

  // Save the page from Neovim, then open the copy in a new browser profile.
  const copy = testInfo.outputPath('copy.html');
  await download(page, () => cmd(page, 'HtmlSave'), copy);
  const context = await browser.newContext();
  const page2 = await context.newPage();
  await open(page2, copy);
  await waitScreen(page2, /NORMAL/);
  expect(await page2.evaluate(() => window.nvimHtml.request('nvim_exec_lua',
    ['return package.loaded.lualine ~= nil', []]))).toBe(true);

  await page2.keyboard.type('gX');
  await waitScreen(page2, /mapping ok/);

  await cmd(page2, 'edit ~/work/notes.txt');
  await waitScreen(page2, /second line/);
  await page2.keyboard.type('u');
  await waitScreen(page2, /1 line less/);
  const text = await screen(page2);
  expect(text).toContain('first line');
  expect(text).not.toContain('second line');
  await context.close();
});
