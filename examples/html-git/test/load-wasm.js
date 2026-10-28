'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

async function loadWasm(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const engine = /<script id="quine-engine">([\s\S]*?)<\/script>/.exec(html);
  if (!engine) throw new Error('quine-engine block absent');
  // No network or browser storage API enters the engine context.
  const context = vm.createContext({
    console, WebAssembly, TextDecoder, TextEncoder, atob, btoa, crypto: webcrypto,
    setTimeout, clearTimeout, performance,
    window: {}, document: { currentScript: null },
  });
  vm.runInContext(engine[1], context, { filename: 'quine-engine.js' });
  return context.QuineEngine({ noInitialRun: true, quineHost: { write() {} }, print() {}, printErr() {} });
}

function copyToMemfs(module, root) {
  const memfs = module.FS;
  function copy(rel) {
    memfs.mkdirTree('/repo' + (rel ? '/' + rel : ''));
    for (const item of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const name = rel ? rel + '/' + item.name : item.name;
      if (item.isDirectory()) copy(name);
      else if (item.isFile()) memfs.writeFile('/repo/' + name, fs.readFileSync(path.join(root, name)));
      else throw new Error('Unsupported fixture path: ' + name);
    }
  }
  copy('');
}

function snapshot(module, root = '/repo') {
  const result = {};
  const memfs = module.FS;
  function walk(dir) {
    for (const name of memfs.readdir(dir).filter((n) => n !== '.' && n !== '..')) {
      const p = dir + '/' + name;
      if (memfs.isDir(memfs.stat(p).mode)) walk(p);
      else result[p] = Buffer.from(memfs.readFile(p)).toString('base64');
    }
  }
  walk(root);
  return result;
}
module.exports = { loadWasm, copyToMemfs, snapshot };
