// Acceptance: the SQLite shell keeps its database inside the saved HTML file.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { quineTarRead } = require('../src/store.js');

const build = path.join(__dirname, '..', 'build');
const url = (file) => 'file://' + file;

async function screen(page) {
  return page.evaluate(() => window.quine.screenText());
}

// Waits until the screen has `count` SQLite prompts, so each command has finished.
async function prompts(page, count) {
  await expect.poll(async () => (await screen(page)).split('sqlite> ').length - 1, { timeout: 60000 })
    .toBeGreaterThanOrEqual(count);
}

async function type(page, text) {
  await page.click('#quine-term');
  await page.keyboard.type(text);
}

async function download(page, button, to) {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click(button)]);
  await dl.saveAs(to);
  return dl.suggestedFilename();
}

// Makes a table, saves, moves the copy to a new folder and opens it in a fresh browser profile.
// Returns the screen of the copy after a SELECT.
async function roundTrip(browser, page, file, out) {
  await page.goto(url(file));
  await prompts(page, 1);
  await type(page, "create table t(a, b);\ninsert into t values (1, 'one'), (2, 'two');\n");
  await prompts(page, 3);
  const saved = path.join(out, 'saved');
  const name = await download(page, '#quine-save', saved);
  expect(name).toMatch(/^sqlite(-idbfs)?\.[0-9a-f]{8}\.r1\.\d{8}-\d{6}\.html$/);

  const moved = path.join(out, 'other-machine', name);
  fs.mkdirSync(path.dirname(moved), { recursive: true });
  fs.renameSync(saved, moved);
  const context = await browser.newContext();
  const copy = await context.newPage();
  await copy.goto(url(moved));
  await prompts(copy, 1);
  await type(copy, 'select * from t;\n');
  await prompts(copy, 2);
  const text = await screen(copy);
  await context.close();
  return text;
}

test('the saved copy keeps the database, and the .tar holds it', async ({ browser, page }, info) => {
  const text = await roundTrip(browser, page, path.join(build, 'sqlite.html'), info.outputPath());
  expect(text).toContain('1|one');
  expect(text).toContain('2|two');

  const tar = info.outputPath('files.tar');
  await download(page, '#quine-tar', tar);
  const db = quineTarRead(new Uint8Array(fs.readFileSync(tar))).find((e) => e.name === 'demo.db');
  expect(db).toBeTruthy();
  expect(Buffer.from(db.bytes.subarray(0, 16)).toString('latin1')).toBe('SQLite format 3\0');
});

test('IDBFS control: the saved copy has an empty filesystem', async ({ browser, page }, info) => {
  const text = await roundTrip(browser, page, path.join(build, 'sqlite-idbfs.html'), info.outputPath());
  expect(text).toContain('no such table: t');
  expect(text).not.toContain('1|one');
});
