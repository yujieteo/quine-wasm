'use strict';
// Loads the git engine straight out of index.html (the <script id="git-core"> block)
// and provides a Node filesystem adapter with the same interface the page's
// File System Access adapter implements.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

function loadCore(htmlPath = path.join(__dirname, '..', 'index.html')) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const m = /<script id="git-core">([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error('git-core script block not found in index.html');
  const mod = { exports: {} };
  new Function('module', m[1])(mod);
  return mod.exports;
}

// Browsers report File.lastModified in whole milliseconds; mirror that.
const fileStat = (s) => ({ kind: 'file', size: s.size, mtimeMs: Math.floor(s.mtimeMs) });

class NodeFS {
  constructor(root) { this.root = root; }
  abs(p) { return path.join(this.root, ...p.split('/').filter(Boolean)); }
  // With { stat: true }: { data, stat } from 1 open file, so the stat data matches the content.
  async readFile(p, opts) {
    let fh;
    try {
      fh = await fsp.open(this.abs(p), 'r');
      const st = await fh.stat();
      if (st.isDirectory()) return null;
      const data = new Uint8Array(await fh.readFile());
      return opts && opts.stat ? { data, stat: fileStat(st) } : data;
    } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR' || e.code === 'EISDIR') return null; throw e; } finally { if (fh) await fh.close(); }
  }
  async writeFile(p, data) {
    await fsp.mkdir(path.dirname(this.abs(p)), { recursive: true });
    await fsp.writeFile(this.abs(p), data);
  }
  async mkdir(p) { await fsp.mkdir(this.abs(p), { recursive: true }); }
  // With { stat: true }, file entries also have the stat data.
  async readdir(p, opts) {
    try {
      const out = [];
      for (const d of await fsp.readdir(this.abs(p), { withFileTypes: true })) {
        if (d.isDirectory()) { out.push({ name: d.name, kind: 'directory' }); continue; }
        if (!opts || !opts.stat) { out.push({ name: d.name, kind: 'file' }); continue; }
        const st = await this.stat(p ? `${p}/${d.name}` : d.name);
        if (st) out.push({ name: d.name, ...st });
      }
      return out;
    } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null; throw e; }
  }
  async stat(p) {
    try {
      const s = await fsp.stat(this.abs(p));
      return s.isDirectory() ? { kind: 'directory' } : fileStat(s);
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
