// Acceptance: the user's script, data and notebook travel inside the saved HTML file,
// and the packages of python-sci.html work. Build the pages first: bash scripts/build.sh.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { quineTarRead } = require('quine-wasm/src/store.js');

const build = path.join(__dirname, '..', 'build');
const url = (file) => 'file://' + file;

async function screen(page) {
  return page.evaluate(() => window.quine.screenText());
}

// Waits until the terminal shows `text` `count` times.
async function shows(page, text, count = 1, timeout = 60000) {
  await expect.poll(async () => (await screen(page)).split(text).length - 1, { timeout }).toBeGreaterThanOrEqual(count);
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

// Opens a page and returns the time in ms to the first Python prompt.
async function start(page, file) {
  const t0 = Date.now();
  await page.goto(url(file));
  await shows(page, '>>> ');
  return Date.now() - t0;
}

const SCRIPT = [
  'name = input("name? ")',
  'numbers = [int(n) for n in open("data.txt").read().split()]',
  'print(f"{name}: sum={sum(numbers)}")',
  '',
].join('\n');

test('the saved copy keeps the script, the data and the notebook', async ({ browser, page }, info) => {
  const ms = await start(page, path.join(build, 'python.html'));
  info.annotations.push({ type: 'start-ms', description: String(ms) });

  // The script goes in through the files panel, the data through Python file I/O.
  await page.fill('#quine-path', 'count.py');
  await page.fill('#quine-editor', SCRIPT);
  await page.click('#quine-write');
  await type(page, 'open("data.txt", "w").write("1 2 3 4\\n")\n');
  await shows(page, '>>> ', 2);
  // The command applies at the next run, which is the copy.
  await page.fill('#quine-args', 'python count.py');
  await page.press('#quine-args', 'Enter');

  // The notebook: run the cells, then write the .ipynb file into the user folder.
  await page.click('#nb-toggle');
  // Each loaded cell shows all of its source, not one clipped line.
  expect(await page.$$eval('#nb textarea', (as) => as.filter((a) => a.clientHeight < a.scrollHeight).length)).toBe(0);
  await page.click('#nb-run-all');
  await expect(page.locator('#nb .cell.code pre').first()).toContainText('0.707');
  await page.evaluate(() => window.pyhtmlNotebook.add('code', 'total = sum(range(10))\ntotal'));
  await page.evaluate(() => window.pyhtmlNotebook.run(window.pyhtmlNotebook.cells.length - 1));
  await expect(page.locator('#nb .cell.code').last()).toContainText('45');
  await page.click('#nb-write');

  const saved = info.outputPath('saved');
  const name = await download(page, '#quine-save', saved);
  expect(name).toMatch(/^python\.[0-9a-f]{8}\.r1\.\d{8}-\d{6}\.html$/);
  // Save keeps only the user's files: no profiler or cache files.
  const html = fs.readFileSync(saved, 'utf8');
  const store = html.slice(html.indexOf('>', html.indexOf('id="quine-store"')) + 1);
  const titles = JSON.parse(store.slice(0, store.indexOf('</script>'))).map((f) => f.title);
  expect(titles.filter((t) => t.startsWith('/home/web/')).sort()).toEqual(
    ['.python_history', 'count.py', 'data.txt', 'hello.py', 'notebook.ipynb'].map((f) => '/home/web/' + f));

  // A different folder and a new browser profile, as on a different machine.
  const moved = info.outputPath('other-machine', name);
  fs.mkdirSync(path.dirname(moved), { recursive: true });
  fs.renameSync(saved, moved);
  const context = await browser.newContext();
  const copy = await context.newPage();
  await copy.goto(url(moved));
  await shows(copy, 'name? ');
  await type(copy, 'Ada\n');
  await shows(copy, 'Ada: sum=10');

  // The notebook opens with its saved outputs, and its cells run in the copy.
  await copy.click('#nb-toggle');
  await expect(copy.locator('#nb .cell.code').last()).toContainText('45');
  expect(await copy.evaluate(() => window.pyhtmlNotebook.cells.length)).toBe(4);
  await context.close();
});

test('python-sci.html: numpy, scipy, pandas and matplotlib work, and plots are files', async ({ page }, info) => {
  const ms = await start(page, path.join(build, 'python-sci.html'));
  info.annotations.push({ type: 'start-ms', description: String(ms) });
  const lines = [
    'import time',
    't = time.time(); import numpy as np; print("import numpy %.2f s" % (time.time() - t))',
    't = time.time(); import scipy.optimize, scipy.stats; print("import scipy %.2f s" % (time.time() - t))',
    't = time.time(); import pandas as pd; print("import pandas %.2f s" % (time.time() - t))',
    't = time.time(); import matplotlib.pyplot as plt; print("import matplotlib %.2f s" % (time.time() - t))',
    'print("inv", np.linalg.inv(np.diag([2.0, 4.0])).diagonal())',
    'print("min", round(float(scipy.optimize.minimize_scalar(lambda x: (x - 3) ** 2).x), 4))',
    'print("mean", pd.DataFrame({"a": [1, 2, 3, 6]})["a"].mean())',
    'plt.plot([0, 1, 2], [0, 1, 4]); plt.savefig("plot.png"); plt.savefig("plot.svg"); plt.close("all")',
    'import os; print("licences", sorted(os.listdir("/usr/local/share/licenses")))',
  ];
  for (const [i, line] of lines.entries()) {
    await type(page, line + '\n');
    await shows(page, '>>> ', i + 2, 120000);
  }
  const text = await screen(page);
  for (const m of text.matchAll(/import (\w+) ([\d.]+) s/g)) info.annotations.push({ type: 'import-' + m[1], description: m[2] + ' s' });
  expect(text).toContain('inv [0.5  0.25]');
  expect(text).toContain('min 3.0');
  expect(text).toContain('mean 3.0');
  expect(text).toContain("'cpython.txt'");

  // The plots are files in the user folder, so the .tar export (and Save) has them.
  const tar = info.outputPath('files.tar');
  await download(page, '#quine-tar', tar);
  const files = quineTarRead(new Uint8Array(fs.readFileSync(tar)));
  const png = files.find((e) => e.name === 'plot.png');
  expect(Buffer.from(png.bytes.subarray(1, 4)).toString('latin1')).toBe('PNG');
  expect(Buffer.from(files.find((e) => e.name === 'plot.svg').bytes).toString('utf8')).toContain('<svg');

  // A notebook cell shows a figure in the page.
  await page.click('#nb-toggle');
  await page.evaluate(() => window.pyhtmlNotebook.add('code', 'plt.plot([1, 2, 3])'));
  await page.evaluate(() => window.pyhtmlNotebook.run(window.pyhtmlNotebook.cells.length - 1));
  await expect(page.locator('#nb .cell.code').last().locator('img')).toHaveCount(1);
});
