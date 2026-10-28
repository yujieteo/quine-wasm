/* The adapter uses the same methods as index.html HandleFS. */
(function (host) {
  'use strict';
  const equal = (a, b) => a === b || (a != null && b != null &&
    a.length === b.length && a.every((v, i) => v === b[i]));

  async function importFolder(module, disk) {
    const mem = module.FS;
    if (mem.analyzePath('/repo').exists) throw new Error('Use a fresh Wasm instance for each folder import.');
    const before = new Map();
    async function copy(rel) {
      mem.mkdir('/repo' + (rel ? '/' + rel : ''));
      const entries = await disk.readdir(rel);
      if (!entries) throw new Error('Folder disappeared: ' + rel);
      const files = [];
      for (const entry of entries) {
        const p = rel ? rel + '/' + entry.name : entry.name;
        if (entry.kind === 'directory') {
          before.set(p, null);
          await copy(p);
        } else if (entry.kind === 'file') {
          files.push(p);
        } else throw new Error('Unsupported path: ' + p);
      }
      for (let i = 0; i < files.length; i += 8) {
        const results = await Promise.allSettled(files.slice(i, i + 8).map(async (p) => {
          const bytes = await disk.readFile(p);
          if (bytes === null) throw new Error('File disappeared: ' + p);
          before.set(p, new Uint8Array(bytes));
          mem.writeFile('/repo/' + p, bytes);
        }));
        const failed = results.find((result) => result.status === 'rejected');
        if (failed) throw failed.reason;
      }
    }
    await copy('');

    return {
      async flush() {
        const after = new Map();
        function scan(rel) {
          for (const name of mem.readdir('/repo/' + rel).filter((n) => n !== '.' && n !== '..')) {
            const p = rel ? rel + '/' + name : name;
            const mode = mem.lstat('/repo/' + p).mode;
            if (mem.isDir(mode)) { after.set(p, null); scan(p); }
            else if (mem.isFile(mode)) after.set(p, mem.readFile('/repo/' + p));
            else throw new Error('Unsupported path: ' + p);
          }
        }
        scan('');
        const changes = [...new Set([...before.keys(), ...after.keys()])].filter((p) =>
          before.has(p) !== after.has(p) || !equal(before.get(p), after.get(p)));
        // Check all affected paths before the first disk mutation.
        for (const p of changes) {
          const old = before.get(p), next = after.get(p), stat = await disk.stat(p);
          if (before.has(p) && after.has(p) && (old === null) !== (next === null)) {
            throw new Error('Unsupported file and folder change: ' + p);
          }
          if (!before.has(p) ? stat !== null : old === null ? stat?.kind !== 'directory' :
            stat?.kind !== 'file' || !equal(old, await disk.readFile(p))) {
            throw new Error('Folder changed outside Wasm: ' + p);
          }
          if (old === null && !after.has(p)) {
            const entries = await disk.readdir(p);
            if (entries.some((e) => !before.has(p + '/' + e.name))) {
              throw new Error('Folder changed outside Wasm: ' + p);
            }
          }
        }
        const removed = changes.filter((p) => !after.has(p)).sort((a, b) => b.split('/').length - a.split('/').length);
        for (const p of removed) await disk.remove(p);
        const created = changes.filter((p) => after.has(p)).sort((a, b) => a.split('/').length - b.split('/').length);
        for (const p of created) {
          if (after.get(p) === null) await disk.mkdir(p);
          else await disk.writeFile(p, after.get(p));
        }
        before.clear();
        for (const [p, bytes] of after) before.set(p, bytes === null ? null : new Uint8Array(bytes));
        return { filesWritten: created.filter((p) => after.get(p) !== null).length, pathsRemoved: removed.length };
      },
    };
  }
  if (typeof module === 'object' && module.exports) module.exports = { importFolder };
  else host.HtmlGitFolderBridge = { importFolder };
})(globalThis);
