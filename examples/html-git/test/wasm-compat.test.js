'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { loadCore, NodeFS } = require('./load-core');
const { loadWasm, copyToMemfs, snapshot } = require('./load-wasm');
const { importFolder } = require('../wasm/folder-bridge');
const artifact = process.env.HTML_GIT_WASM || path.join(__dirname, '../data/wasm-build/probe.html');
const available = fs.existsSync(artifact);
if (process.env.HTML_GIT_WASM && !available) throw new Error('HTML_GIT_WASM file absent');

test('libgit2 Init survives shutdown and produces a repository Git can use', {
  skip: available ? false : 'Run wasm/build.sh to build the libgit2 probe.',
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'html-git-wasm-init-'));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };
  const git = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8' });
  try {
    fs.writeFileSync(path.join(root, 'file.txt'), 'Keep this file.\n');
    const m = await loadWasm(artifact);
    const disk = new NodeFS(root);
    const writes = [];
    const writeFile = disk.writeFile.bind(disk);
    disk.writeFile = async (p, bytes) => { writes.push(p); await writeFile(p, bytes); };
    const bridge = await importFolder(m, disk);
    assert.equal(m._html_git_init_probe(), 0);
    const initialized = snapshot(m);
    for (let n = 0; n < 4; n++) {
      assert.equal(m._html_git_init_probe(), 0, 'Init and shutdown can repeat');
      assert.deepEqual(snapshot(m), initialized, 'reinit preserves repository bytes');
    }
    const result = await bridge.flush();
    assert.equal(result.filesWritten, writes.length);
    assert.ok(writes.length > 0);
    assert.ok(writes.every((p) => p.startsWith('.git/')));
    assert.deepEqual(await bridge.flush(), { filesWritten: 0, pathsRemoved: 0 });
    assert.ok(fs.statSync(path.join(root, '.git/refs/heads')).isDirectory());
    assert.equal(fs.readFileSync(path.join(root, 'file.txt'), 'utf8'), 'Keep this file.\n');
    assert.equal(git('symbolic-ref', 'HEAD').trim(), 'refs/heads/main');
    assert.equal(git('config', '--bool', 'core.bare').trim(), 'false');
    const core = loadCore();
    const repo = new core.Repo(new NodeFS(root));
    assert.equal((await repo.status()).head.branch, 'main');
    git('add', 'file.txt');
    git('commit', '-m', 'First');
    git('fsck', '--full', '--strict');
    const fresh = await loadWasm(artifact);
    copyToMemfs(fresh, root);
    assert.equal(fresh._html_git_probe(), 0);
    assert.equal(fresh.FS.readFile('/probe-result', { encoding: 'utf8' }).split('\n')[0],
      git('rev-parse', 'HEAD').trim());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('libgit2 quine probe matches Git and JavaScript without repository writes', {
  skip: available ? false : 'Run wasm/build.sh to build the libgit2 probe.',
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'html-git-wasm-'));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };
  const git = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8' });
  try {
    git('init', '-b', 'main');
    git('config', 'core.autocrlf', 'false');
    git('config', 'gc.auto', '0');
    fs.writeFileSync(path.join(root, 'file.txt'), 'first\n');
    git('add', '.');
    git('commit', '-m', 'First');
    fs.writeFileSync(path.join(root, 'file.txt'), 'second\n');
    git('add', '.');
    git('commit', '-m', 'Second\n\nBody.');
    const core = loadCore();
    for (const state of ['loose', 'packed', 'detached']) {
      if (state === 'packed') {
        git('gc', '--prune=now');
        git('pack-refs', '--all');
      }
      if (state === 'detached') git('checkout', '--detach', 'HEAD~1');
      // The index differs from HEAD and the file differs from the index.
      fs.writeFileSync(path.join(root, 'new.txt'), 'staged\n');
      git('add', 'new.txt');
      fs.writeFileSync(path.join(root, 'new.txt'), 'unstaged\n');
      const m = await loadWasm(artifact);
      copyToMemfs(m, root);
      const before = snapshot(m);
      assert.equal(m._html_git_probe(), 0, state);
      const result = m.FS.readFile('/probe-result', { encoding: 'utf8' }).split('\n');
      const repo = new core.Repo(new NodeFS(root));
      const head = await repo.resolveRev('HEAD');
      assert.equal(result[0], git('rev-parse', 'HEAD').trim());
      assert.equal(result[0], head);
      assert.equal(result[1], git('rev-parse', 'HEAD^{tree}').trim());
      assert.equal(result[1], (await repo.readCommit(head)).tree);
      assert.equal(Number(result[2]), git('ls-files', '-z').split('\0').length - 1);
      assert.equal(Number(result[2]), (await repo.readIndex()).length);
      assert.equal(result.slice(3).join('\n'), (await repo.readCommit(head)).message);
      assert.equal(result.slice(3).join('\n'), git('cat-file', 'commit', 'HEAD').split('\n\n').slice(1).join('\n\n'));
      assert.deepEqual(snapshot(m), before, state + ': repository bytes stay intact');
      assert.equal(m._html_git_probe(), 0, 'probe can repeat');
      assert.deepEqual(snapshot(m), before);
      git('reset', '--hard', 'HEAD');
    }
    const m = await loadWasm(artifact);
    m.FS.mkdir('/repo');
    assert.ok(m._html_git_probe() < 0, 'absent repository fails');
    assert.equal(m.FS.analyzePath('/probe-result').exists, false);
    const html = fs.readFileSync(artifact, 'utf8');
    const store = JSON.parse(/id="quine-store"[^>]*>([\s\S]*?)<\/script>/.exec(html)[1]);
    assert.equal(store.length, 1, 'store holds system data only');
    assert.equal(store[0].title, '$:/quine/system');
    assert.match(html, /LINKING EXCEPTION/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test('folder import bounds concurrent reads and settles reads before an error returns', {
  skip: available ? false : 'Run wasm/build.sh to build the libgit2 probe.',
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'html-git-import-'));
  try {
    const disk = new NodeFS(root);
    for (let i = 0; i < 19; i++) await disk.writeFile('file' + i, 'Bytes ' + i);
    await disk.mkdir('empty');
    let active = 0, peak = 0, reads = 0, fail = false;
    const readFile = disk.readFile.bind(disk);
    disk.readFile = async (p) => {
      active++;
      peak = Math.max(peak, active);
      reads++;
      try {
        if (fail && reads === 1) throw new Error('Read refused');
        await new Promise(setImmediate);
        return await readFile(p);
      } finally { active--; }
    };
    const m = await loadWasm(artifact);
    const bridge = await importFolder(m, disk);
    assert.equal(peak, 8, 'reads overlap within the batch limit');
    assert.equal(active, 0);
    assert.equal(reads, 19);
    for (let i = 0; i < 19; i++) {
      assert.equal(m.FS.readFile('/repo/file' + i, { encoding: 'utf8' }), 'Bytes ' + i);
    }
    assert.ok(m.FS.isDir(m.FS.stat('/repo/empty').mode));
    assert.deepEqual(await bridge.flush(), { filesWritten: 0, pathsRemoved: 0 });
    fail = true;
    reads = 0;
    const fresh = await loadWasm(artifact);
    await assert.rejects(importFolder(fresh, disk), /Read refused/);
    assert.equal(active, 0, 'no read can alter MEMFS after import rejects');
    assert.equal(reads, 8, 'a failed batch prevents further reads');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('folder bridge writes only changed bytes and refuses external edits before any write', {
  skip: available ? false : 'Run wasm/build.sh to build the libgit2 probe.',
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'html-git-bridge-'));
  try {
    const disk = new NodeFS(root);
    await disk.mkdir('empty');
    await disk.writeFile('keep', new Uint8Array([0, 255, 1]));
    await disk.writeFile('edit', 'old');
    await disk.writeFile('remove/child', 'old');
    const m = await loadWasm(artifact);
    const bridge = await importFolder(m, disk);
    assert.ok(m.FS.isDir(m.FS.stat('/repo/empty').mode));
    assert.deepEqual(Array.from(m.FS.readFile('/repo/keep')), [0, 255, 1]);
    const keepTime = fs.statSync(path.join(root, 'keep')).mtimeMs;
    m.FS.writeFile('/repo/edit', 'new');
    m.FS.unlink('/repo/remove/child');
    m.FS.rmdir('/repo/remove');
    m.FS.mkdir('/repo/new');
    m.FS.writeFile('/repo/new/binary', new Uint8Array([255, 0]));
    assert.deepEqual(await bridge.flush(), { filesWritten: 2, pathsRemoved: 2 });
    assert.equal(fs.statSync(path.join(root, 'keep')).mtimeMs, keepTime);
    assert.equal(fs.existsSync(path.join(root, 'remove')), false);
    assert.equal(fs.readFileSync(path.join(root, 'edit'), 'utf8'), 'new');
    assert.deepEqual(Array.from(fs.readFileSync(path.join(root, 'new/binary'))), [255, 0]);
    m.FS.writeFile('/repo/edit', 'Wasm edit');
    m.FS.writeFile('/repo/keep', 'Wasm edit');
    await disk.writeFile('keep', 'external edit');
    await assert.rejects(bridge.flush(), /changed outside Wasm/);
    assert.equal(fs.readFileSync(path.join(root, 'edit'), 'utf8'), 'new');
    assert.equal(fs.readFileSync(path.join(root, 'keep'), 'utf8'), 'external edit');
    await assert.rejects(importFolder(m, disk), /fresh Wasm instance/);
    // New disk files must survive a Wasm folder removal.
    const fresh = await loadWasm(artifact);
    const next = await importFolder(fresh, disk);
    fresh.FS.unlink('/repo/new/binary');
    fresh.FS.rmdir('/repo/new');
    await disk.writeFile('new/external', 'keep');
    await assert.rejects(next.flush(), /changed outside Wasm/);
    assert.equal(fs.existsSync(path.join(root, 'new/binary')), true);
    assert.equal(fs.readFileSync(path.join(root, 'new/external'), 'utf8'), 'keep');
    const html = fs.readFileSync(artifact, 'utf8');
    assert.ok(html.includes('host.HtmlGitFolderBridge = { importFolder }'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('libgit2 Stage exports selected literal paths with the same tree as Git and JavaScript', {
  skip: available ? false : 'Run wasm/build.sh to build the libgit2 probe.',
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'html-git-stage-'));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8' });
  try {
    const actual = path.join(root, 'actual');
    fs.mkdirSync(actual);
    git(actual, 'init', '-b', 'main');
    git(actual, 'config', 'core.autocrlf', 'false');
    git(actual, 'config', 'core.filemode', 'true');
    for (const p of ['edit', 'delete', 'unselected', 'tracked.log', 'executable']) fs.writeFileSync(path.join(actual, p), 'old\n');
    fs.chmodSync(path.join(actual, 'executable'), 0o755);
    git(actual, 'add', '.');
    git(actual, 'commit', '-m', 'First');
    fs.writeFileSync(path.join(actual, '.gitignore'), '*.log\n');
    for (const p of ['edit', 'unselected', 'tracked.log', 'ignored.log', 'ünïcode name', '[ab].txt', 'a.txt', 'executable']) {
      fs.writeFileSync(path.join(actual, p), 'new\n');
    }
    fs.writeFileSync(path.join(actual, 'binary'), Buffer.from([0, 255, 1]));
    fs.unlinkSync(path.join(actual, 'delete'));
    const reference = path.join(root, 'git');
    const javascript = path.join(root, 'javascript');
    fs.cpSync(actual, reference, { recursive: true });
    fs.cpSync(actual, javascript, { recursive: true });
    const repo = new (loadCore().Repo)(new NodeFS(javascript));
    const disk = new NodeFS(actual);
    const writes = [];
    const writeFile = disk.writeFile.bind(disk);
    disk.writeFile = async (p, bytes) => { writes.push(p); await writeFile(p, bytes); };
    for (const p of ['executable', 'edit', 'delete', 'tracked.log', 'ünïcode name', '[ab].txt', 'binary']) {
      const m = await loadWasm(artifact);
      const bridge = await importFolder(m, disk);
      m.FS.writeFile('/stage-path', p);
      assert.equal(m._html_git_stage_probe(), 0, p);
      await bridge.flush();
      git(reference, '--literal-pathspecs', 'add', '--', p);
      await repo.add([p]);
      const tree = git(actual, 'write-tree');
      assert.equal(tree, git(reference, 'write-tree'), p + ': Git tree');
      assert.equal(tree, git(javascript, 'write-tree'), p + ': JavaScript tree');
      assert.equal(git(actual, 'status', '--porcelain'), git(reference, 'status', '--porcelain'));
      git(actual, 'fsck', '--full', '--strict');
    }
    assert.ok(writes.every((p) => p === '.git/index' || p.startsWith('.git/objects/')));
    assert.equal(fs.readFileSync(path.join(actual, 'unselected'), 'utf8'), 'new\n');
    assert.equal(git(actual, 'show', ':unselected'), 'old\n');
    assert.equal(git(actual, 'ls-files', '--', 'a.txt'), '');
    assert.match(git(actual, 'ls-files', '--stage', '--', 'executable'), /^100755 /);
    assert.match(git(actual, 'ls-files', '--stage', '--', 'edit'), /^100644 /);
    assert.match(git(actual, 'ls-files', '--stage', '--', 'binary'), /^100644 /);
    assert.equal(git(actual, 'config', '--bool', 'core.filemode').trim(), 'true');
    const m = await loadWasm(artifact);
    const bridge = await importFolder(m, disk);
    for (const p of ['ignored.log', 'absent']) {
      const before = snapshot(m);
      m.FS.writeFile('/stage-path', p);
      assert.ok(m._html_git_stage_probe() < 0, p + ': refused');
      assert.deepEqual(snapshot(m), before);
      assert.deepEqual(await bridge.flush(), { filesWritten: 0, pathsRemoved: 0 });
    }
    assert.deepEqual(await bridge.flush(), { filesWritten: 0, pathsRemoved: 0 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
