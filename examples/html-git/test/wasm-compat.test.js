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

test('libgit2 Stage matches Git for built-in text and ident conversions', {
  skip: available ? false : 'Run wasm/build.sh to build the libgit2 probe.',
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'html-git-stage-text-'));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const cases = [
    { name: 'text', attr: 'text', bytes: 'new\r\ntext\r\n', stored: 'new\ntext\n' },
    { name: 'eol-lf', attr: 'eol=lf', bytes: 'new\r\ntext\r\n', stored: 'new\ntext\n' },
    { name: 'eol-crlf', attr: 'text eol=crlf', bytes: 'new\r\ntext\r\n', stored: 'new\ntext\n' },
    { name: 'autocrlf-true', autocrlf: 'true', bytes: 'new\r\ntext\r\n', stored: 'new\ntext\n' },
    { name: 'autocrlf-input', autocrlf: 'input', bytes: 'new\r\ntext\r\n', stored: 'new\ntext\n' },
    { name: 'unset-text', autocrlf: 'true', attr: '-text', bytes: 'new\r\ntext\r\n' },
    { name: 'auto-binary', attr: 'text=auto', bytes: 'new\0\r\ntext\r\n' },
    { name: 'auto-text', attr: 'text=auto', bytes: 'new\r\ntext\r\n', stored: 'new\ntext\n' },
    { name: 'auto-existing-crlf', attr: 'text=auto', base: 'old\r\n', bytes: 'new\r\ntext\r\n' },
    { name: 'ident', attr: 'ident', bytes: 'new $Id: abcdef $ text\n', stored: 'new $Id$ text\n' },
    { name: 'ident-text', attr: 'ident text', bytes: '$Id: abcdef $\r\nnew\r\n', stored: '$Id$\nnew\n' },
    { name: 'info-override', attr: 'text', info: '-text', bytes: 'new\r\ntext\r\n' },
  ];
  try {
    for (const c of cases) {
      const actual = path.join(root, c.name);
      fs.mkdirSync(actual);
      git(actual, 'init', '-b', 'main');
      git(actual, 'config', 'core.autocrlf', 'false');
      git(actual, 'config', 'core.safecrlf', 'false');
      fs.writeFileSync(path.join(actual, 'file'), c.base || 'old\n');
      git(actual, 'add', 'file');
      git(actual, 'commit', '-m', 'Base');
      git(actual, 'config', 'core.autocrlf', c.autocrlf || 'false');
      if (c.attr) fs.writeFileSync(path.join(actual, '.gitattributes'), `file ${c.attr}\n`);
      if (c.info) fs.writeFileSync(path.join(actual, '.git/info/attributes'), `file ${c.info}\n`);
      const bytes = Buffer.from(c.bytes);
      fs.writeFileSync(path.join(actual, 'file'), bytes);
      const reference = actual + '-git';
      const javascript = actual + '-js';
      fs.cpSync(actual, reference, { recursive: true });
      fs.cpSync(actual, javascript, { recursive: true });
      git(reference, 'add', 'file');
      const expected = Buffer.from(c.stored || c.bytes);
      assert.deepEqual(execFileSync('git', ['show', ':file'], { cwd: reference, env }), expected, c.name);
      await new (loadCore().Repo)(new NodeFS(javascript)).add(['file']);
      assert.deepEqual(execFileSync('git', ['show', ':file'], { cwd: javascript, env }), bytes,
        c.name + ': JavaScript preserves input bytes');
      assert.equal(git(javascript, 'write-tree') === git(reference, 'write-tree'), !c.stored,
        c.name + ': JavaScript conversion limit');
      const m = await loadWasm(artifact);
      const disk = new NodeFS(actual);
      const writes = [];
      const writeFile = disk.writeFile.bind(disk);
      disk.writeFile = async (p, content) => { writes.push(p); await writeFile(p, content); };
      const bridge = await importFolder(m, disk);
      m.FS.writeFile('/stage-path', 'file');
      assert.equal(m._html_git_stage_probe(), 0, c.name);
      await bridge.flush();
      assert.equal(git(actual, 'write-tree'), git(reference, 'write-tree'), c.name + ': Git tree');
      assert.deepEqual(execFileSync('git', ['show', ':file'], { cwd: actual, env }), expected, c.name + ': blob bytes');
      assert.equal(git(actual, 'status', '--porcelain'), git(reference, 'status', '--porcelain'), c.name + ': status');
      assert.deepEqual(fs.readFileSync(path.join(actual, 'file')), bytes, c.name + ': file bytes stay intact');
      assert.ok(writes.includes('.git/index'));
      assert.ok(writes.every((p) => p === '.git/index' || p.startsWith('.git/objects/')));
      assert.deepEqual(await bridge.flush(), { filesWritten: 0, pathsRemoved: 0 });
      git(actual, 'fsck', '--full', '--strict');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('libgit2 Unstage matches Git and JavaScript for literal paths, unborn HEAD and conflicts', {
  skip: available ? false : 'Run wasm/build.sh to build the libgit2 probe.',
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'html-git-unstage-'));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    for (const state of ['committed', 'unborn', 'conflict']) {
      const actual = path.join(root, state);
      fs.mkdirSync(actual);
      git(actual, 'init', '-b', 'main');
      git(actual, 'config', 'core.autocrlf', 'false');
      const paths = ['edit', 'delete', 'executable', '[x]*.txt', 'nested/日本語'];
      fs.mkdirSync(path.join(actual, 'nested'));
      for (const p of [...paths, 'x1.txt']) fs.writeFileSync(path.join(actual, p), 'base\n');
      fs.chmodSync(path.join(actual, 'executable'), 0o755);
      git(actual, 'add', '.');
      if (state !== 'unborn') git(actual, 'commit', '-m', 'Base');
      if (state === 'conflict') {
        git(actual, 'checkout', '-b', 'topic');
        for (const p of paths) fs.writeFileSync(path.join(actual, p), 'topic\n');
        git(actual, 'commit', '-am', 'Topic');
        git(actual, 'checkout', 'main');
        for (const p of paths) fs.writeFileSync(path.join(actual, p), 'main\n');
        git(actual, 'commit', '-am', 'Main');
        assert.throws(() => git(actual, 'merge', 'topic'));
      } else {
        for (const p of paths) fs.writeFileSync(path.join(actual, p), 'staged\n');
        fs.unlinkSync(path.join(actual, 'delete'));
        fs.writeFileSync(path.join(actual, 'new'), 'new\n');
        git(actual, 'add', '-A');
        paths.push('new');
      }
      fs.writeFileSync(path.join(actual, 'x1.txt'), 'unselected\n');
      git(actual, 'add', 'x1.txt');
      fs.writeFileSync(path.join(actual, 'edit'), 'keep local bytes\n');
      const reference = path.join(root, state + '-git');
      const javascript = path.join(root, state + '-js');
      fs.cpSync(actual, reference, { recursive: true });
      fs.cpSync(actual, javascript, { recursive: true });
      const repo = new (loadCore().Repo)(new NodeFS(javascript));
      const disk = new NodeFS(actual);
      const writes = [];
      const writeFile = disk.writeFile.bind(disk);
      disk.writeFile = async (p, bytes) => { writes.push(p); await writeFile(p, bytes); };
      for (const p of paths) {
        // An unborn deletion is unknown to both HEAD and index.
        if (state === 'unborn' && p === 'delete') continue;
        const m = await loadWasm(artifact);
        const bridge = await importFolder(m, disk);
        const before = snapshot(m);
        m.FS.writeFile('/stage-path', p);
        assert.equal(m._html_git_unstage_probe(), 0, state + ': ' + p);
        const after = snapshot(m);
        delete before['/repo/.git/index'];
        delete after['/repo/.git/index'];
        assert.deepEqual(after, before, 'only index bytes can change');
        await bridge.flush();
        git(reference, '--literal-pathspecs', 'reset', '--', p);
        await repo.resetPaths([p]);
        const entries = git(actual, 'ls-files', '--stage');
        assert.equal(entries, git(reference, 'ls-files', '--stage'), state + ': Git index for ' + p);
        assert.equal(entries, git(javascript, 'ls-files', '--stage'), state + ': JavaScript index for ' + p);
        assert.equal(git(actual, 'status', '--porcelain'), git(reference, 'status', '--porcelain'));
        assert.deepEqual(await bridge.flush(), { filesWritten: 0, pathsRemoved: 0 });
      }
      assert.ok(writes.length > 0);
      assert.ok(writes.every((p) => p === '.git/index'));
      assert.equal(git(actual, 'write-tree'), git(reference, 'write-tree'));
      assert.equal(git(actual, 'write-tree'), git(javascript, 'write-tree'));
      assert.equal(git(actual, 'symbolic-ref', 'HEAD'), git(reference, 'symbolic-ref', 'HEAD'));
      assert.equal(fs.readFileSync(path.join(actual, 'edit'), 'utf8'), 'keep local bytes\n');
      if (state === 'conflict') assert.equal(git(actual, 'rev-parse', 'MERGE_HEAD'), git(reference, 'rev-parse', 'MERGE_HEAD'));
      if (state !== 'unborn') assert.match(git(actual, 'ls-files', '--stage', '--', 'executable'), /^100755 /);
      git(actual, 'fsck', '--full', '--strict');
      const m = await loadWasm(artifact);
      const bridge = await importFolder(m, disk);
      const before = snapshot(m);
      m.FS.writeFile('/stage-path', 'absent');
      assert.ok(m._html_git_unstage_probe() < 0);
      assert.deepEqual(snapshot(m), before);
      assert.deepEqual(await bridge.flush(), { filesWritten: 0, pathsRemoved: 0 });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

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

test('libgit2 Stage resolves selected merge conflicts, including ignored and deleted paths', {
  skip: available ? false : 'Run wasm/build.sh to build the libgit2 probe.',
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'html-git-stage-conflict-'));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const actual = path.join(root, 'actual');
    fs.mkdirSync(actual);
    git(actual, 'init', '-b', 'main');
    git(actual, 'config', 'core.autocrlf', 'false');
    const paths = ['edit', 'ignored.log', 'delete', 'ignored-delete.log', 'unselected'];
    for (const p of paths) fs.writeFileSync(path.join(actual, p), 'base\n');
    git(actual, 'add', '.');
    git(actual, 'commit', '-m', 'Base');
    git(actual, 'checkout', '-b', 'topic');
    for (const p of paths) fs.writeFileSync(path.join(actual, p), 'topic\n');
    git(actual, 'commit', '-am', 'Topic');
    git(actual, 'checkout', 'main');
    for (const p of paths) fs.writeFileSync(path.join(actual, p), 'main\n');
    git(actual, 'commit', '-am', 'Main');
    assert.throws(() => git(actual, 'merge', 'topic'));
    assert.equal(git(actual, 'ls-files', '--unmerged').trim().split('\n').length, 15);
    const mergeHead = git(actual, 'rev-parse', 'MERGE_HEAD');
    fs.writeFileSync(path.join(actual, '.gitignore'), '*.log\n');
    for (const p of paths) {
      if (p.includes('delete')) fs.unlinkSync(path.join(actual, p));
      else fs.writeFileSync(path.join(actual, p), 'resolved\n');
    }
    const reference = path.join(root, 'git');
    const javascript = path.join(root, 'javascript');
    fs.cpSync(actual, reference, { recursive: true });
    fs.cpSync(actual, javascript, { recursive: true });
    const repo = new (loadCore().Repo)(new NodeFS(javascript));
    const disk = new NodeFS(actual);
    const writes = [];
    const writeFile = disk.writeFile.bind(disk);
    disk.writeFile = async (p, bytes) => { writes.push(p); await writeFile(p, bytes); };
    for (const p of paths) {
      const m = await loadWasm(artifact);
      const bridge = await importFolder(m, disk);
      m.FS.writeFile('/stage-path', p);
      assert.equal(m._html_git_stage_probe(), 0, p);
      await bridge.flush();
      git(reference, 'add', '--', p);
      await repo.add([p]);
      const entries = git(actual, 'ls-files', '--stage');
      assert.equal(entries, git(reference, 'ls-files', '--stage'), p + ': Git index');
      assert.equal(entries, git(javascript, 'ls-files', '--stage'), p + ': JavaScript index');
      assert.equal(git(actual, 'status', '--porcelain'), git(reference, 'status', '--porcelain'));
      assert.equal(git(actual, 'rev-parse', 'MERGE_HEAD'), mergeHead);
      if (p !== 'unselected') assert.match(git(actual, 'ls-files', '--unmerged'), /\tunselected\n/);
      assert.deepEqual(await bridge.flush(), { filesWritten: 0, pathsRemoved: 0 });
      git(actual, 'fsck', '--full', '--strict');
    }
    assert.equal(git(actual, 'write-tree'), git(reference, 'write-tree'));
    assert.equal(git(actual, 'write-tree'), git(javascript, 'write-tree'));
    assert.ok(writes.every((p) => p === '.git/index' || p.startsWith('.git/objects/')));
    assert.equal(fs.readFileSync(path.join(actual, 'ignored.log'), 'utf8'), 'resolved\n');
    assert.equal(fs.existsSync(path.join(actual, 'ignored-delete.log')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('libgit2 Stage refuses external clean filters before it changes repository bytes', {
  skip: available ? false : 'Run wasm/build.sh to build the libgit2 probe.',
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'html-git-stage-filter-'));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    git(root, 'init', '-b', 'main');
    fs.writeFileSync(path.join(root, 'file'), 'old\n');
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'Base');
    fs.writeFileSync(path.join(root, '.gitattributes'), 'file filter=uppercase\n');
    fs.writeFileSync(path.join(root, 'file'), 'new\n');
    git(root, 'config', 'filter.uppercase.clean', 'tr a-z A-Z');
    const reference = path.join(root, 'reference');
    fs.mkdirSync(reference);
    fs.cpSync(path.join(root, '.git'), path.join(reference, '.git'), { recursive: true });
    fs.copyFileSync(path.join(root, '.gitattributes'), path.join(reference, '.gitattributes'));
    fs.copyFileSync(path.join(root, 'file'), path.join(reference, 'file'));
    git(reference, 'add', 'file');
    assert.equal(git(reference, 'show', ':file'), 'NEW\n', 'Git executes the clean filter');
    // The current JavaScript engine also lacks external filters.
    const js = new (loadCore().Repo)(new NodeFS(root));
    await js.add(['file']);
    assert.equal(git(root, 'show', ':file'), 'new\n');
    assert.notEqual(git(root, 'write-tree'), git(reference, 'write-tree'));
    for (const config of ['clean', 'required-clean', 'process', 'required-absent']) {
      if (config === 'required-clean') git(root, 'config', 'filter.uppercase.required', 'true');
      if (config === 'process') {
        git(root, 'config', '--unset', 'filter.uppercase.clean');
        git(root, 'config', 'filter.uppercase.process', 'unavailable-filter');
      }
      if (config === 'required-absent') git(root, 'config', '--unset', 'filter.uppercase.process');
      const m = await loadWasm(artifact);
      const bridge = await importFolder(m, new NodeFS(root));
      const before = snapshot(m);
      m.FS.writeFile('/stage-path', 'file');
      assert.ok(m._html_git_stage_probe() < 0, config + ': unsupported filter must fail');
      assert.deepEqual(snapshot(m), before, config + ': no index or object change');
      assert.deepEqual(await bridge.flush(), { filesWritten: 0, pathsRemoved: 0 });
    }
    // An optional absent driver is a no-op in Git. A deletion needs no filter.
    git(root, 'config', 'filter.uppercase.required', 'false');
    for (const deleted of [false, true]) {
      if (deleted) {
        git(root, 'config', 'filter.uppercase.clean', 'tr a-z A-Z');
        fs.unlinkSync(path.join(root, 'file'));
        fs.unlinkSync(path.join(reference, 'file'));
      } else {
        git(reference, 'config', '--unset', 'filter.uppercase.clean');
        // A new size prevents Git from reusing the former filtered blob.
        for (const dir of [root, reference]) fs.writeFileSync(path.join(dir, 'file'), 'optional driver absent\n');
      }
      const m = await loadWasm(artifact);
      const bridge = await importFolder(m, new NodeFS(root));
      m.FS.writeFile('/stage-path', 'file');
      assert.equal(m._html_git_stage_probe(), 0);
      await bridge.flush();
      git(reference, 'add', 'file');
      assert.equal(git(root, 'write-tree'), git(reference, 'write-tree'));
      git(root, 'fsck', '--full', '--strict');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('libgit2 Stage refuses unsupported working-tree encodings before any repository change', {
  skip: available ? false : 'Run wasm/build.sh to build the libgit2 probe.',
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'html-git-stage-encoding-'));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    git(root, 'init', '-b', 'main');
    fs.writeFileSync(path.join(root, 'file'), 'old\n');
    git(root, 'add', 'file');
    git(root, 'commit', '-m', 'Base');
    fs.writeFileSync(path.join(root, '.gitattributes'), 'file working-tree-encoding=UTF-16LE\n');
    const bytes = Buffer.from('new\n', 'utf16le');
    fs.writeFileSync(path.join(root, 'file'), bytes);
    const reference = path.join(root, 'reference');
    fs.mkdirSync(reference);
    fs.cpSync(path.join(root, '.git'), path.join(reference, '.git'), { recursive: true });
    fs.copyFileSync(path.join(root, '.gitattributes'), path.join(reference, '.gitattributes'));
    fs.writeFileSync(path.join(reference, 'file'), bytes);
    git(reference, 'add', 'file');
    assert.equal(git(reference, 'show', ':file'), 'new\n', 'Git converts UTF-16LE to UTF-8');
    const repo = new (loadCore().Repo)(new NodeFS(root));
    await repo.add(['file']);
    assert.deepEqual(execFileSync('git', ['show', ':file'], { cwd: root, env }), bytes);
    assert.notEqual(git(root, 'write-tree'), git(reference, 'write-tree'), 'JavaScript cannot supply a fallback');
    const m = await loadWasm(artifact);
    const bridge = await importFolder(m, new NodeFS(root));
    const before = snapshot(m);
    m.FS.writeFile('/stage-path', 'file');
    assert.ok(m._html_git_stage_probe() < 0, 'unsupported encoding must fail');
    assert.deepEqual(snapshot(m), before, 'refusal preserves index and object bytes');
    assert.deepEqual(await bridge.flush(), { filesWritten: 0, pathsRemoved: 0 });
    assert.deepEqual(fs.readFileSync(path.join(root, 'file')), bytes);

    // Unset and unspecified attributes require no conversion. Neither does deletion.
    for (const attribute of ['-working-tree-encoding', '!working-tree-encoding', 'working-tree-encoding=UTF-16LE']) {
      fs.writeFileSync(path.join(root, '.gitattributes'), `file ${attribute}\n`);
      fs.writeFileSync(path.join(reference, '.gitattributes'), `file ${attribute}\n`);
      if (attribute.startsWith('working-tree-encoding=')) {
        fs.unlinkSync(path.join(root, 'file'));
        fs.unlinkSync(path.join(reference, 'file'));
      } else {
        const content = Buffer.from(attribute + '\n', 'utf16le');
        fs.writeFileSync(path.join(root, 'file'), content);
        fs.writeFileSync(path.join(reference, 'file'), content);
      }
      const fresh = await loadWasm(artifact);
      const next = await importFolder(fresh, new NodeFS(root));
      fresh.FS.writeFile('/stage-path', 'file');
      assert.equal(fresh._html_git_stage_probe(), 0, attribute);
      await next.flush();
      git(reference, 'add', 'file');
      assert.equal(git(root, 'write-tree'), git(reference, 'write-tree'), attribute);
      git(root, 'fsck', '--full', '--strict');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
