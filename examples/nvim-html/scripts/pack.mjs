// Assemble nvim.html from the built engine, the runtime tarball and the seed home.
// Usage: node pack.mjs ENGINE_JS RUNTIME_TGZ SEED_HOME OUT_HTML
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [engineJs, runtimeTgz, seedHome, out] = process.argv.slice(2);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.resolve(root, p), 'utf8');

// Save filter: the files under HOME that Save keeps. Paths are relative to HOME.
const FILTER = {
  include: ['.config/nvim/**', '.local/share/nvim/site/**', '.local/state/nvim/**', 'work/**'],
  exclude: ['.local/state/nvim/swap/**', '.local/state/nvim/**.log'],
};

const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function seedStore(dir) {
  const lines = [];
  const walk = (abs, rel) => {
    const names = fs.readdirSync(abs).sort();
    if (!names.length && rel) lines.push(JSON.stringify({ title: rel + '/', type: 'directory' }));
    for (const name of names) {
      const p = path.join(abs, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = fs.lstatSync(p);
      if (st.isDirectory()) walk(p, r);
      else if (st.isFile()) {
        const data = fs.readFileSync(p);
        try {
          lines.push(JSON.stringify({ title: r, text: strictUtf8.decode(data) }));
        } catch {
          lines.push(JSON.stringify({ title: r, type: 'application/octet-stream', text: data.toString('base64') }));
        }
      }
    }
  };
  walk(dir, '');
  return ('[\n' + lines.join(',\n') + '\n]').replace(/</g, '\\u003c');
}

function element(tag, attrs, body) {
  if (/<\/(script|style)|<!--/i.test(body)) throw new Error(`content of #${attrs.id} would end its <${tag}>`);
  const a = Object.entries(attrs).map(([k, v]) => ` ${k}="${String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`);
  return `<${tag}${a.join('')}>${body}</${tag}>`;
}

const template = read('src/page/template.html');
const blocks = {
  'xterm-css': element('style', { id: 'xterm-css' }, read('node_modules/@xterm/xterm/css/xterm.css')),
  runtime: element('script', { type: 'application/octet-stream', id: 'runtime' },
    fs.readFileSync(runtimeTgz).toString('base64')),
  store: element('script', {
    type: 'application/json', id: 'store', 'data-version': 1,
    'data-filter': JSON.stringify(FILTER), 'data-lineage': '', 'data-revision': 0,
  }, seedStore(seedHome)),
  xterm: element('script', { id: 'xterm' },
    read('node_modules/@xterm/xterm/lib/xterm.js') + '\n' + read('node_modules/@xterm/addon-fit/lib/addon-fit.js')),
  engine: element('script', { id: 'engine' }, fs.readFileSync(engineJs, 'utf8')),
  app: element('script', { id: 'app' }, read('src/page/app.js')),
  shell: element('script', { type: 'application/json', id: 'shell' },
    JSON.stringify(template).replace(/</g, '\\u003c')),
};
const html = template.replace(/<!--@([a-z-]+)-->/g, (m, id) => {
  if (!blocks[id]) throw new Error(`no block for ${m}`);
  return blocks[id];
});
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log(`${out}: ${(html.length / 1e6).toFixed(1)} MB`);
