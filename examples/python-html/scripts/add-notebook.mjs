// Append src/notebook.js to the page script block (quine-shell) of a quine-wasm page.
// Save copies that block as it is, so each saved copy keeps the notebook.
// Usage: node add-notebook.mjs PAGE.html
import fs from 'node:fs';

const [page] = process.argv.slice(2);
const js = fs.readFileSync(new URL('../src/notebook.js', import.meta.url), 'utf8');
if (/<\/script|<!--/i.test(js)) throw new Error('notebook.js contains "</script" or "<!--"');
const html = fs.readFileSync(page, 'utf8');
const start = html.indexOf('<script id="quine-shell">');
const end = html.indexOf('</script>', start);
if (start < 0 || html.indexOf('<script id="quine-shell">', start + 1) >= 0) throw new Error(page + ': expected one quine-shell block');
fs.writeFileSync(page, html.slice(0, end) + '\n' + js + html.slice(end));
