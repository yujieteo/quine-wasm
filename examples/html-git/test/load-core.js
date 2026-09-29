'use strict';
// Loads the git engine straight out of index.html (the <script id="git-core"> block)
// and provides a Node filesystem adapter with the same interface the page's
// File System Access adapter implements.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

function loadCore() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const m = /<script id="git-core">([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error('git-core script block not found in index.html');
  const mod = { exports: {} };
  new Function('module', m[1])(mod);
  return mod.exports;
}

class NodeFS {
  constructor(root) { this.root = root; }
  abs(p) { return path.join(this.root, ...p.split('/').filter(Boolean)); }
  async readFile(p) {
    try { return new Uint8Array(await fsp.readFile(this.abs(p))); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR' || e.code === 'EISDIR') return null; throw e; }
  }
  async writeFile(p, data) {
    await fsp.mkdir(path.dirname(this.abs(p)), { recursive: true });
    await fsp.writeFile(this.abs(p), data);
  }
  async mkdir(p) { await fsp.mkdir(this.abs(p), { recursive: true }); }
  async readdir(p) {
    try {
      return (await fsp.readdir(this.abs(p), { withFileTypes: true })).map((d) => ({ name: d.name, kind: d.isDirectory() ? 'directory' : 'file' }));
    } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null; throw e; }
  }
  async stat(p) {
    try {
      const s = await fsp.stat(this.abs(p));
      // Browsers report File.lastModified in whole milliseconds; mirror that.
      return s.isDirectory() ? { kind: 'directory' } : { kind: 'file', size: s.size, mtimeMs: Math.floor(s.mtimeMs) };
    } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null; throw e; }
  }
  async remove(p) {
    try { await fsp.rm(this.abs(p)); } catch (e) {
      if (e.code === 'ENOENT') return;
      if (e.code === 'ERR_FS_EISDIR' || e.code === 'EISDIR') { await fsp.rmdir(this.abs(p)); return; }
      throw e;
    }
  }
}

module.exports = { loadCore, NodeFS };
