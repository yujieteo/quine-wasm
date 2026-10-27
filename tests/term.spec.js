// The terminal and the store checks, with tests/termtest (built with --ctrl-s program and --runtime).
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'build', 'termtest.html');

async function screen(page) {
  return page.evaluate(() => window.quine.screenText());
}
async function shows(page, text) {
  await expect.poll(() => screen(page), { timeout: 30000 }).toContain(text);
}

test('raw keys, alternate screen, size, SIGWINCH, runtime block and save API', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 700 });
  await page.goto('file://' + file);
  await shows(page, 'raw');
  expect(await page.evaluate(() => window.quine.term.buffer.active.type)).toBe('alternate');
  await page.click('#quine-term');
  await page.keyboard.press('x');
  await shows(page, 'key 120');
  expect(await screen(page)).not.toContain('x\n');
  await page.keyboard.press('Escape');
  await shows(page, 'key 27');
  await page.keyboard.press('Control+s');
  await shows(page, 'key 19');
  const { cols, rows } = await page.evaluate(() => ({ cols: window.quine.term.cols, rows: window.quine.term.rows }));
  await page.keyboard.press('w');
  await shows(page, `winch 0 size ${cols}x${rows}`);

  await page.setViewportSize({ width: 800, height: 500 });
  await expect.poll(() => page.evaluate(() => window.quine.term.cols)).toBeLessThan(cols);
  const now = await page.evaluate(() => ({ cols: window.quine.term.cols, rows: window.quine.term.rows }));
  await page.keyboard.press('w');
  await expect.poll(() => screen(page)).toMatch(new RegExp(`winch [1-9]\\d* size ${now.cols}x${now.rows}`));

  await page.keyboard.press('r');
  await shows(page, 'runtime hello from the runtime block');

  const [dl] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('s')]);
  expect(dl.suggestedFilename()).toMatch(/^termtest\.[0-9a-f]{8}\.r1\.\d{8}-\d{6}\.html$/);

  await page.keyboard.press('q');
  await expect(page.locator('#quine-again')).toBeVisible();
  await page.click('#quine-again');
  await shows(page, 'raw');
});

test('boot skips bad entries and refuses a newer store version', async ({ page }, info) => {
  const html = fs.readFileSync(file, 'utf8');
  const bad = info.outputPath('bad.html');
  fs.writeFileSync(bad, html.replace(/(id="quine-store"[^>]*>\[)/,
    '$1\n{"title":"/etc/passwd","text":"x"},\n{"title":"/home/web/ok.txt","text":"fine"},\n{"title":"/home/web/../x","text":"x"},'));
  await page.goto('file://' + bad);
  await expect(page.locator('#quine-status')).toContainText('2 store entries skipped');
  await expect(page.locator('#quine-files')).toContainText('ok.txt');

  const newer = info.outputPath('newer.html');
  fs.writeFileSync(newer, html.replace('id="quine-store" data-version="1"', 'id="quine-store" data-version="2"'));
  await page.goto('file://' + newer);
  await expect(page.locator('#quine-status')).toContainText('newer version');
  await page.click('#quine-save');
  await expect(page.locator('#quine-status')).toContainText('Save is off');
});

test('an include glob for a nested folder saves and restores the files in it', async ({ browser, page }, info) => {
  const filter = { prefix: '/home/web', include: ['.config/nvim/**'], exclude: [] };
  const nested = info.outputPath('nested.html');
  fs.writeFileSync(nested, fs.readFileSync(file, 'utf8')
    .replace(/data-filter="[^"]*"/, 'data-filter="' + JSON.stringify(filter).replace(/"/g, '&quot;') + '"'));
  await page.goto('file://' + nested);
  await shows(page, 'raw');
  await page.fill('#quine-path', '/home/web/.config/nvim/init.lua');
  await page.fill('#quine-editor', 'vim.g.mapleader = " "\n');
  await page.click('#quine-write');
  await expect(page.locator('#quine-files')).toContainText('.config/nvim/init.lua');

  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#quine-save')]);
  const copy = info.outputPath('copy', dl.suggestedFilename());
  await dl.saveAs(copy);
  const context = await browser.newContext();
  const other = await context.newPage();
  await other.goto('file://' + copy);
  await shows(other, 'raw');
  await expect(other.locator('#quine-files')).toContainText('.config/nvim/init.lua');
  await other.locator('#quine-files li', { hasText: 'init.lua' }).click();
  await expect(other.locator('#quine-editor')).toHaveValue('vim.g.mapleader = " "\n');
  await context.close();
});
