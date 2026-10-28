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

test('libgit2 File Compare matches Git without repository writes', {
  skip: available ? false : 'Run wasm/build.sh to build the libgit2 probe.',
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'html-git-file-compare-'));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    for (const kind of ['unborn-empty', 'root', 'mixed', 'packed', 'detached', 'unchanged', 'crlf', 'ident', 'filter', 'encoding',
      'filter-unchanged', 'filter-deleted', 'encoding-deleted', 'filter-untracked', 'nested-override']) {
      const dir = path.join(root, kind);
      fs.mkdirSync(dir);
      git(dir, 'init', '-b', 'main');
      git(dir, 'config', 'core.autocrlf', 'false');
      git(dir, 'config', 'core.filemode', 'false');
      if (kind !== 'unborn-empty') {
        fs.writeFileSync(path.join(dir, 'file'), 'first\nsecond\nthird\n');
        fs.writeFileSync(path.join(dir, 'removed'), 'remove me\n');
        fs.writeFileSync(path.join(dir, 'binary'), Buffer.from([0, 1, 2]));
        git(dir, 'add', '.');
        git(dir, 'update-index', '--chmod=+x', 'file');
        if (kind !== 'root') git(dir, 'commit', '-m', 'Base');
        if (kind === 'packed') { git(dir, 'gc'); git(dir, 'pack-refs', '--all'); }
        if (kind === 'detached') git(dir, 'checkout', '--detach');
        if (kind === 'mixed') {
          fs.writeFileSync(path.join(dir, 'file'), 'staged content\n');
          git(dir, 'add', 'file');
        }
        if (kind !== 'unchanged' && kind !== 'filter-unchanged') {
          fs.writeFileSync(path.join(dir, 'file'), 'first\nchanged\nthird');
          fs.unlinkSync(path.join(dir, 'removed'));
          fs.writeFileSync(path.join(dir, 'binary'), Buffer.from([0, 3, 4, 5]));
        }
        if (kind === 'crlf') {
          git(dir, 'config', 'core.autocrlf', 'input');
          fs.writeFileSync(path.join(dir, 'file'), 'first\r\nchanged\r\nthird\r\n');
        }
        if (kind === 'ident') {
          fs.writeFileSync(path.join(dir, '.gitattributes'), 'file ident\n');
          fs.writeFileSync(path.join(dir, 'file'), '$Id: expanded value $\n');
        }
        if (kind.startsWith('filter')) {
          fs.writeFileSync(path.join(dir, '.gitattributes'), 'file filter=test\n');
          git(dir, 'config', 'filter.test.clean', 'false');
        }
        if (kind.startsWith('encoding')) fs.writeFileSync(path.join(dir, '.gitattributes'), 'file working-tree-encoding=UTF-16LE\n');
        if (kind.endsWith('-deleted')) fs.unlinkSync(path.join(dir, 'file'));
        if (kind === 'filter-untracked') fs.writeFileSync(path.join(dir, '.gitattributes'), 'untracked filter=test\n');
        if (kind === 'nested-override') {
          fs.mkdirSync(path.join(dir, 'nested'));
          fs.writeFileSync(path.join(dir, 'nested/file'), 'base\n');
          git(dir, 'add', 'nested/file');
          fs.writeFileSync(path.join(dir, 'nested/file'), 'changed\n');
          fs.writeFileSync(path.join(dir, '.gitattributes'), 'nested/** filter=test\n');
          fs.writeFileSync(path.join(dir, 'nested/.gitattributes'), 'file -filter\n');
          git(dir, 'config', 'filter.test.clean', 'false');
        }
      }
      fs.writeFileSync(path.join(dir, 'untracked'), 'untracked content\n');
      const m = await loadWasm(artifact);
      const bridge = await importFolder(m, new NodeFS(dir));
      const before = snapshot(m);
      assert.equal(typeof m._html_git_file_compare_probe, 'function', 'File Compare export');
      const refuse = kind === 'filter' || kind === 'encoding' || kind === 'filter-unchanged';
      const expected = refuse ? null : git(dir, 'diff', '--no-ext-diff', '--no-textconv', '--no-color');
      for (let call = 0; call < 2; call++) {
        m.FS.writeFile('/compare-result', 'stale patch');
        const rc = m._html_git_file_compare_probe();
        if (refuse) {
          assert.ok(rc < 0, kind + ': unsupported conversion');
          assert.equal(m.FS.analyzePath('/compare-result').exists, false, kind + ': no stale patch');
        } else {
          assert.equal(rc, 0, kind);
          assert.equal(m.FS.readFile('/compare-result', { encoding: 'utf8' }), expected, kind + ': Git patch');
        }
        assert.deepEqual(snapshot(m), before, kind + ': repository bytes');
        assert.deepEqual(await bridge.flush(), { filesWritten: 0, pathsRemoved: 0 });
      }
      if (!refuse) {
        const repo = new (loadCore().Repo)(new NodeFS(dir));
        const jsPatch = (await repo.diff({ from: 'index', to: 'worktree' })).text;
        if (kind === 'crlf' || kind === 'ident') assert.notEqual(jsPatch, expected, kind + ': JavaScript omits conversion');
        else assert.equal(jsPatch, expected, kind + ': JavaScript patch');
      }
      git(dir, 'fsck', '--full', '--strict');
    }
    const m = await loadWasm(artifact);
    m.FS.writeFile('/compare-result', 'stale patch');
    assert.ok(m._html_git_file_compare_probe() < 0, 'absent repository');
    assert.equal(m.FS.analyzePath('/compare-result').exists, false, 'no stale result after refusal');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('libgit2 Index Compare matches Git without repository writes', {
  skip: available ? false : 'Run wasm/build.sh to build the libgit2 probe.',
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'html-git-index-compare-'));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    for (const kind of ['unborn-empty', 'root', 'mixed', 'rename', 'rename-disabled', 'packed', 'detached', 'unchanged']) {
      const dir = path.join(root, kind);
      fs.mkdirSync(dir);
      git(dir, 'init', '-b', 'main');
      git(dir, 'config', 'core.autocrlf', 'false');
      if (kind !== 'unborn-empty') {
        fs.writeFileSync(path.join(dir, 'file'), 'first\nsecond\nthird\n');
        fs.writeFileSync(path.join(dir, 'removed'), 'remove me\n');
        fs.writeFileSync(path.join(dir, 'binary'), Buffer.from([0, 1, 2]));
        git(dir, 'add', '.');
        if (kind !== 'root') git(dir, 'commit', '-m', 'Base');
      }
      if (kind === 'rename' || kind === 'rename-disabled') {
        git(dir, 'mv', 'file', 'renamed');
        if (kind === 'rename-disabled') git(dir, 'config', 'diff.renames', 'false');
      }
      if (['mixed', 'packed', 'detached'].includes(kind)) {
        if (kind === 'packed') { git(dir, 'gc'); git(dir, 'pack-refs', '--all'); }
        if (kind === 'detached') git(dir, 'checkout', '--detach');
        fs.writeFileSync(path.join(dir, 'file'), 'first\nchanged\nthird');
        fs.unlinkSync(path.join(dir, 'removed'));
        fs.writeFileSync(path.join(dir, 'binary'), Buffer.from([0, 3, 4, 5]));
        fs.writeFileSync(path.join(dir, 'added'), 'new file\n');
        git(dir, 'add', '-A');
        git(dir, 'update-index', '--chmod=+x', 'added');
      }
      // Index Compare must exclude both unstaged and untracked bytes.
      fs.writeFileSync(path.join(dir, 'file'), 'unstaged content\n');
      fs.writeFileSync(path.join(dir, 'untracked'), 'untracked content\n');
      const expected = git(dir, 'diff', '--cached', '--no-ext-diff', '--no-textconv', '--no-color');
      const m = await loadWasm(artifact);
      const bridge = await importFolder(m, new NodeFS(dir));
      const before = snapshot(m);
      assert.equal(typeof m._html_git_index_compare_probe, 'function', 'Index Compare export');
      for (let call = 0; call < 2; call++) {
        assert.equal(m._html_git_index_compare_probe(), 0, kind);
        assert.equal(m.FS.readFile('/compare-result', { encoding: 'utf8' }), expected, kind + ': Git patch');
        assert.deepEqual(snapshot(m), before, kind + ': repository bytes');
        assert.deepEqual(await bridge.flush(), { filesWritten: 0, pathsRemoved: 0 });
      }
      const repo = new (loadCore().Repo)(new NodeFS(dir));
      const jsPatch = (await repo.diff({ from: 'HEAD', to: 'index' })).text;
      if (kind === 'rename') {
        assert.match(expected, /similarity index 100%\nrename from file\nrename to renamed\n/);
        assert.notEqual(jsPatch, expected, 'JavaScript emits separate deletion and addition patches');
      } else assert.equal(jsPatch, expected, kind + ': JavaScript patch');
      git(dir, 'fsck', '--full', '--strict');
    }
    const m = await loadWasm(artifact);
    m.FS.writeFile('/compare-result', 'stale patch');
    assert.ok(m._html_git_index_compare_probe() < 0, 'absent repository');
    assert.equal(m.FS.analyzePath('/compare-result').exists, false, 'no stale result after refusal');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('libgit2 Stage matches Git safecrlf refusals and accepted file bytes', {
  skip: available ? false : 'Run wasm/build.sh to build the libgit2 probe.',
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'html-git-safecrlf-'));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const cases = [
    { name: 'input-crlf', autocrlf: 'input', bytes: 'new\r\ntext\r\n', refuse: true },
    { name: 'true-lf', autocrlf: 'true', bytes: 'new\ntext\n', refuse: true },
    { name: 'true-mixed', autocrlf: 'true', bytes: 'new\r\ntext\n', refuse: true },
    { name: 'input-lf', autocrlf: 'input', bytes: 'new\ntext\n' },
    { name: 'true-crlf', autocrlf: 'true', bytes: 'new\r\ntext\r\n' },
    { name: 'unset-text', autocrlf: 'true', attr: '-text', bytes: 'new\ntext\n' },
    { name: 'binary', autocrlf: 'true', bytes: 'new\0\r\ntext\n' },
    { name: 'warn', autocrlf: 'input', safecrlf: 'warn', bytes: 'new\r\ntext\r\n' },
  ];
  try {
    for (const c of cases) {
      const actual = path.join(root, c.name);
      fs.mkdirSync(actual);
      git(actual, 'init', '-b', 'main');
      git(actual, 'config', 'core.autocrlf', 'false');
      fs.writeFileSync(path.join(actual, 'file'), 'old\n');
      git(actual, 'add', 'file');
      git(actual, 'commit', '-m', 'Base');
      git(actual, 'config', 'core.autocrlf', c.autocrlf);
      git(actual, 'config', 'core.safecrlf', c.safecrlf || 'true');
      if (c.attr) fs.writeFileSync(path.join(actual, '.gitattributes'), `file ${c.attr}\n`);
      const bytes = Buffer.from(c.bytes);
      fs.writeFileSync(path.join(actual, 'file'), bytes);
      const reference = actual + '-git';
      const javascript = actual + '-js';
      fs.cpSync(actual, reference, { recursive: true });
      fs.cpSync(actual, javascript, { recursive: true });
      if (c.refuse) assert.throws(() => git(reference, 'add', 'file'), /would be replaced/);
      else git(reference, 'add', 'file');
      const m = await loadWasm(artifact);
      const bridge = await importFolder(m, new NodeFS(actual));
      const before = snapshot(m);
      m.FS.writeFile('/stage-path', 'file');
      const rc = m._html_git_stage_probe();
      if (c.refuse) {
        assert.ok(rc < 0, c.name + ': unsafe conversion must fail');
        assert.deepEqual(snapshot(m), before, c.name + ': no repository byte change');
        assert.deepEqual(await bridge.flush(), { filesWritten: 0, pathsRemoved: 0 });
        await new (loadCore().Repo)(new NodeFS(javascript)).add(['file']);
        assert.notEqual(git(javascript, 'write-tree'), git(reference, 'write-tree'),
          c.name + ': JavaScript accepts the refused change');
      } else {
        assert.equal(rc, 0, c.name);
        await bridge.flush();
        assert.deepEqual(execFileSync('git', ['show', ':file'], { cwd: actual, env }),
          execFileSync('git', ['show', ':file'], { cwd: reference, env }), c.name + ': blob bytes');
        assert.deepEqual(await bridge.flush(), { filesWritten: 0, pathsRemoved: 0 });
      }
      assert.equal(git(actual, 'write-tree'), git(reference, 'write-tree'), c.name + ': Git tree');
      assert.equal(git(actual, 'status', '--porcelain'), git(reference, 'status', '--porcelain'), c.name + ': status');
      assert.deepEqual(fs.readFileSync(path.join(actual, 'file')), bytes, c.name + ': file bytes');
      git(actual, 'fsck', '--full', '--strict');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

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


test('libgit2 Commit matches Git and JavaScript for root, parent, detached and empty-tree commits', {
  skip: available ? false : 'Run wasm/build.sh to build the libgit2 probe.',
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'html-git-commit-'));
  const date = new Date('2023-11-14T22:13:20Z');
  const offset = -date.getTimezoneOffset();
  const zone = (offset < 0 ? '-' : '+') + String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0') +
    String(Math.abs(offset) % 60).padStart(2, '0');
  const signature = `Ada Lovelace <ada@example.com> 1700000000 ${zone}`;
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Ada Lovelace', GIT_AUTHOR_EMAIL: 'ada@example.com',
    GIT_COMMITTER_NAME: 'Ada Lovelace', GIT_COMMITTER_EMAIL: 'ada@example.com',
    GIT_AUTHOR_DATE: `1700000000 ${zone}`, GIT_COMMITTER_DATE: `1700000000 ${zone}` };
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const dirs = ['wasm', 'git', 'javascript'].map((name) => path.join(root, name));
    for (const dir of dirs) {
      fs.mkdirSync(dir);
      git(dir, 'init', '-b', 'main');
      git(dir, 'config', 'core.autocrlf', 'false');
    }
    const [actual, reference, javascript] = dirs;
    const G = loadCore();
    for (const kind of ['root', 'parent', 'detached', 'empty-tree']) {
      const message = `${kind}: café\n\nBody with <text>.\n`;
      for (const dir of dirs) {
        if (kind === 'detached') git(dir, 'checkout', '--detach');
        if (kind === 'empty-tree') git(dir, 'rm', '-f', 'file');
        else {
          fs.writeFileSync(path.join(dir, 'file'), kind + '\n');
          git(dir, 'add', 'file');
          fs.writeFileSync(path.join(dir, 'file'), 'unstaged bytes\n');
        }
      }
      const index = fs.readFileSync(path.join(actual, '.git/index'));
      const branch = kind === 'root' ? null : git(actual, 'rev-parse', 'main');
      const m = await loadWasm(artifact);
      const bridge = await importFolder(m, new NodeFS(actual));
      m.FS.writeFile('/commit-message', message);
      m.FS.writeFile('/commit-signature', signature);
      assert.equal(m._html_git_commit_probe(), 0, kind);
      await bridge.flush();
      assert.deepEqual(fs.readFileSync(path.join(actual, '.git/index')), index);
      if (kind === 'detached' || kind === 'empty-tree') assert.equal(git(actual, 'rev-parse', 'main'), branch);
      const messageFile = path.join(root, 'message');
      fs.writeFileSync(messageFile, message);
      git(reference, '-c', 'commit.gpgsign=false', 'commit', '--cleanup=verbatim', '-F', messageFile);
      const repo = new G.Repo(new NodeFS(javascript));
      const result = await repo.commit({ message, ident: { name: 'Ada Lovelace', email: 'ada@example.com' }, date });
      const sha = git(actual, 'rev-parse', 'HEAD').trim();
      assert.equal(sha, git(reference, 'rev-parse', 'HEAD').trim(), kind + ': Git commit ID');
      assert.equal(sha, result.sha, kind + ': JavaScript commit ID');
      assert.equal(git(actual, 'cat-file', 'commit', sha), git(reference, 'cat-file', 'commit', sha));
      assert.equal(git(actual, 'status', '--porcelain'), git(reference, 'status', '--porcelain'));
      assert.equal(git(actual, 'reflog', '-1', '--format=%H %gs'), git(reference, 'reflog', '-1', '--format=%H %gs'));
      assert.equal(git(actual, 'reflog', '--format=%H').trim().split('\n').length,
        git(reference, 'reflog', '--format=%H').trim().split('\n').length);
      if (kind !== 'empty-tree') assert.equal(fs.readFileSync(path.join(actual, 'file'), 'utf8'), 'unstaged bytes\n');
      git(actual, 'fsck', '--full', '--strict');
      assert.deepEqual(await bridge.flush(), { filesWritten: 0, pathsRemoved: 0 });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('libgit2 Commit refuses invalid inputs, empty commits and unsupported states without disk writes', {
  skip: available ? false : 'Run wasm/build.sh to build the libgit2 probe.',
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'html-git-commit-refuse-'));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };
  const git = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const refuse = async (message = 'Commit\n', signature = 'Test <test@example.com> 1700000000 +0000') => {
    const m = await loadWasm(artifact);
    const bridge = await importFolder(m, new NodeFS(root));
    const before = snapshot(m);
    m.FS.writeFile('/commit-message', message);
    m.FS.writeFile('/commit-signature', signature);
    assert.ok(m._html_git_commit_probe() < 0);
    assert.deepEqual(snapshot(m), before);
    assert.deepEqual(await bridge.flush(), { filesWritten: 0, pathsRemoved: 0 });
  };
  try {
    git('init', '-b', 'main');
    await refuse();
    fs.writeFileSync(path.join(root, 'file'), 'base\n');
    git('add', 'file');
    await refuse(' \n\t');
    await refuse('Commit\n', 'invalid signature');
    git('commit', '-m', 'Base');
    await refuse();
    fs.writeFileSync(path.join(root, 'file'), 'new bytes\n');
    git('add', 'file');
    fs.writeFileSync(path.join(root, '.git/MERGE_HEAD'), 'invalid merge head\n');
    await refuse();
    fs.writeFileSync(path.join(root, '.git/MERGE_HEAD'), '');
    await refuse();
    fs.writeFileSync(path.join(root, '.git/MERGE_HEAD'), git('rev-parse', 'HEAD') + '0'.repeat(40) + '\n');
    await refuse();
    fs.unlinkSync(path.join(root, '.git/MERGE_HEAD'));
    fs.mkdirSync(path.join(root, '.git/rebase-merge'));
    await refuse();
    fs.rmdirSync(path.join(root, '.git/rebase-merge'));
    const blob = git('rev-parse', 'HEAD:file').trim();
    execFileSync('git', ['update-index', '--index-info'], { cwd: root, env,
      input: `0 ${'0'.repeat(40)}\tfile\n100644 ${blob} 1\tfile\n100644 ${blob} 2\tfile\n100644 ${blob} 3\tfile\n` });
    await refuse();
    assert.equal(fs.readFileSync(path.join(root, 'file'), 'utf8'), 'new bytes\n');
    git('fsck', '--full', '--strict');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('libgit2 Commit cleans supplied messages as Git does', {
  skip: available ? false : 'Run wasm/build.sh to build the libgit2 probe.',
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'html-git-message-'));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_AUTHOR_DATE: '1700000000 +0000', GIT_COMMITTER_DATE: '1700000000 +0000' };
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const message = '\n\nTitle with café  \t\n\n\n# Comment\n; Custom comment\n Body\t \n\n';
  const cases = [
    {}, { mode: 'default' }, { mode: 'whitespace' }, { mode: 'verbatim' },
    { mode: 'scissors' }, { mode: 'strip' }, { mode: 'strip', comment: ';' },
    { message: 'No final newline' }, { message: ' \t\n\n', refuse: true },
    { mode: 'strip', message: '# Comment only\n', refuse: true },
    { mode: 'verbatim', message: ' \t\n\n' },
    { mode: 'invalid', refuse: true }, { implicit: true, refuse: true },
    { mode: 'strip', comment: 'auto', unsupported: true },
    { mode: 'strip', commentString: '##', unsupported: true },
    { mode: 'scissors', message: 'Title\n# ------------------------ >8 ------------------------\nKeep this body\n' },
  ];
  try {
    for (const [i, c] of cases.entries()) {
      const actual = path.join(root, String(i));
      fs.mkdirSync(actual);
      git(actual, 'init', '-b', 'main');
      git(actual, 'config', 'core.autocrlf', 'false');
      if (c.mode) git(actual, 'config', 'commit.cleanup', c.mode);
      if (c.implicit) fs.appendFileSync(path.join(actual, '.git/config'), '\n[commit]\n\tcleanup\n');
      if (c.commentString) git(actual, 'config', 'core.commentString', c.commentString);
      if (c.comment) git(actual, 'config', 'core.commentChar', c.comment);
      fs.writeFileSync(path.join(actual, 'file'), 'staged bytes\n');
      git(actual, 'add', 'file');
      fs.writeFileSync(path.join(actual, 'file'), 'unstaged bytes\n');
      const status = git(actual, 'status', '--porcelain');
      const reference = actual + '-git';
      fs.cpSync(actual, reference, { recursive: true });
      const input = c.message === undefined ? message : c.message;
      const messageFile = path.join(root, 'message');
      fs.writeFileSync(messageFile, input);
      if (c.refuse) assert.throws(() => git(reference, 'commit', '-F', messageFile), /Command failed/);
      else git(reference, 'commit', '-F', messageFile);
      const m = await loadWasm(artifact);
      const bridge = await importFolder(m, new NodeFS(actual));
      const before = snapshot(m);
      m.FS.writeFile('/commit-message', input);
      m.FS.writeFile('/commit-signature', 'Test <test@example.com> 1700000000 +0000');
      const rc = m._html_git_commit_probe();
      if (c.refuse || c.unsupported) {
        assert.ok(rc < 0, `${i}: refuse invalid or empty message`);
        assert.deepEqual(snapshot(m), before);
        assert.deepEqual(await bridge.flush(), { filesWritten: 0, pathsRemoved: 0 });
      } else {
        assert.equal(rc, 0, `${i}: commit`);
        await bridge.flush();
        assert.equal(git(actual, 'cat-file', 'commit', 'HEAD'), git(reference, 'cat-file', 'commit', 'HEAD'), `${i}: commit bytes`);
        assert.equal(git(actual, 'rev-parse', 'HEAD'), git(reference, 'rev-parse', 'HEAD'), `${i}: commit ID`);
        assert.deepEqual(await bridge.flush(), { filesWritten: 0, pathsRemoved: 0 });
        const payload = git(actual, 'cat-file', 'commit', 'HEAD').split('\n\n').slice(1).join('\n\n');
        const jsMessage = loadCore().cleanMessage(input);
        if (c.mode === 'verbatim' || c.mode === 'strip') assert.notEqual(jsMessage, payload);
        else assert.equal(jsMessage, payload);
      }
      assert.deepEqual(fs.readFileSync(path.join(actual, '.git/index')), Buffer.from(before['/repo/.git/index'], 'base64'));
      assert.equal(fs.readFileSync(path.join(actual, 'file'), 'utf8'), 'unstaged bytes\n');
      assert.equal(git(actual, 'status', '--porcelain'), c.unsupported ? status : git(reference, 'status', '--porcelain'));
      git(actual, 'fsck', '--full', '--strict');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('libgit2 Commit preserves configured message encoding and raw message bytes as Git does', {
  skip: available ? false : 'Run wasm/build.sh to build the libgit2 probe.',
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'html-git-commit-encoding-'));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_AUTHOR_DATE: '1700000000 +0000', GIT_COMMITTER_DATE: '1700000000 +0000' };
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const cases = [
    { encoding: 'ISO-8859-1', bytes: 'latin1' },
    { encoding: 'ISO-8859-1' }, { encoding: 'latin1', bytes: 'latin1' },
    {}, { encoding: 'UTF-8' }, { encoding: 'utf8' }, { encoding: 'uTf-8' },
    { encoding: '' },
  ];
  try {
    for (const [i, c] of cases.entries()) {
      const actual = path.join(root, String(i));
      fs.mkdirSync(actual);
      git(actual, 'init', '-b', 'main');
      git(actual, 'config', 'core.autocrlf', 'false');
      if (c.encoding !== undefined) git(actual, 'config', 'i18n.commitEncoding', c.encoding);
      fs.writeFileSync(path.join(actual, 'file'), 'staged bytes\n');
      git(actual, 'add', 'file');
      fs.writeFileSync(path.join(actual, 'file'), 'unstaged bytes\n');
      const reference = actual + '-git';
      fs.cpSync(actual, reference, { recursive: true });
      const message = Buffer.from('Title: café\n\nBody: déjà vu.\n', c.bytes || 'utf8');
      const messageFile = path.join(root, 'message');
      fs.writeFileSync(messageFile, message);
      git(reference, 'commit', '-F', messageFile);
      const m = await loadWasm(artifact);
      const bridge = await importFolder(m, new NodeFS(actual));
      const before = snapshot(m);
      m.FS.writeFile('/commit-message', message);
      m.FS.writeFile('/commit-signature', 'Test <test@example.com> 1700000000 +0000');
      assert.equal(m._html_git_commit_probe(), 0, `${i}: commit`);
      await bridge.flush();
      const commit = git(actual, 'cat-file', 'commit', 'HEAD');
      assert.deepEqual(commit, git(reference, 'cat-file', 'commit', 'HEAD'), `${i}: commit bytes`);
      assert.deepEqual(git(actual, 'rev-parse', 'HEAD'), git(reference, 'rev-parse', 'HEAD'), `${i}: commit ID`);
      assert.ok(commit.subarray(commit.indexOf('\n\n') + 2).equals(message), `${i}: no byte conversion`);
      assert.deepEqual(fs.readFileSync(path.join(actual, '.git/index')), Buffer.from(before['/repo/.git/index'], 'base64'));
      assert.equal(fs.readFileSync(path.join(actual, 'file'), 'utf8'), 'unstaged bytes\n');
      assert.deepEqual(git(actual, 'status', '--porcelain'), git(reference, 'status', '--porcelain'));
      assert.deepEqual(git(actual, 'reflog', '-1', '--format=%H %gs'), git(reference, 'reflog', '-1', '--format=%H %gs'));
      git(actual, 'fsck', '--full', '--strict');
      assert.deepEqual(await bridge.flush(), { filesWritten: 0, pathsRemoved: 0 });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('libgit2 Commit refuses hooks before any repository write', {
  skip: available ? false : 'Run wasm/build.sh to build the libgit2 probe.',
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'html-git-commit-hooks-'));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_AUTHOR_DATE: '1700000000 +0000', GIT_COMMITTER_DATE: '1700000000 +0000' };
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const cases = [
    ...['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'reference-transaction'].map(hook => ({ hook, refuse: true })),
    { hook: 'pre-commit', mode: 0o644, refuse: true },
    { hook: 'pre-commit.sample' }, { hook: 'pre-push' }, {},
    { hooksPath: 'custom-hooks', hook: 'pre-commit', refuse: true },
    { hooksPath: '/external-hooks', refuse: true },
    { hooksPath: '/dev/null', hook: 'pre-commit' },
  ];
  try {
    for (const [i, c] of cases.entries()) {
      const actual = path.join(root, String(i));
      fs.mkdirSync(actual);
      git(actual, 'init', '-b', 'main');
      fs.writeFileSync(path.join(actual, 'file'), 'staged bytes\n');
      git(actual, 'add', 'file');
      fs.writeFileSync(path.join(actual, 'file'), 'unstaged bytes\n');
      if (c.hooksPath) git(actual, 'config', 'core.hooksPath', c.hooksPath);
      if (c.hook) {
        const folder = c.hooksPath === 'custom-hooks' ? 'custom-hooks' : '.git/hooks';
        fs.mkdirSync(path.join(actual, folder), { recursive: true });
        // Pre-commit hooks refuse. Post-commit and ref hooks leave observable evidence.
        const script = c.hook === 'post-commit' || c.hook === 'reference-transaction'
          ? '#!/bin/sh\nprintf "hook ran\\n" >> hook-marker\n'
          : '#!/bin/sh\nexit 1\n';
        fs.writeFileSync(path.join(actual, folder, c.hook), script, { mode: c.mode || 0o755 });
      }
      const reference = actual + '-git';
      fs.cpSync(actual, reference, { recursive: true });
      const gitRefuses = c.refuse && c.hooksPath !== '/external-hooks' && c.mode !== 0o644 &&
        !['post-commit', 'reference-transaction'].includes(c.hook);
      if (gitRefuses) assert.throws(() => git(reference, 'commit', '-m', 'Commit'), /Command failed/);
      else git(reference, 'commit', '-m', 'Commit');
      if (['post-commit', 'reference-transaction'].includes(c.hook)) {
        assert.match(fs.readFileSync(path.join(reference, 'hook-marker'), 'utf8'), /hook ran/);
      }
      const m = await loadWasm(artifact);
      const bridge = await importFolder(m, new NodeFS(actual));
      const before = snapshot(m);
      m.FS.writeFile('/commit-message', 'Commit\n');
      m.FS.writeFile('/commit-signature', 'Test <test@example.com> 1700000000 +0000');
      const rc = m._html_git_commit_probe();
      if (c.refuse) {
        assert.ok(rc < 0, `${i}: hook must not be bypassed`);
        assert.deepEqual(snapshot(m), before, `${i}: unchanged repository bytes`);
        assert.deepEqual(await bridge.flush(), { filesWritten: 0, pathsRemoved: 0 });
        if (i === 0) {
          const javascript = actual + '-js';
          fs.cpSync(actual, javascript, { recursive: true });
          const result = await new (loadCore().Repo)(new NodeFS(javascript)).commit({
            message: 'Commit\n', ident: { name: 'Test', email: 'test@example.com' },
            date: new Date('2023-11-14T22:13:20Z') });
          assert.ok(result.sha, 'JavaScript bypasses the hook that Git enforces');
        }
      } else {
        assert.equal(rc, 0, `${i}: no active Commit hook`);
        await bridge.flush();
        assert.equal(git(actual, 'cat-file', 'commit', 'HEAD'), git(reference, 'cat-file', 'commit', 'HEAD'));
        assert.equal(git(actual, 'rev-parse', 'HEAD'), git(reference, 'rev-parse', 'HEAD'));
        assert.deepEqual(await bridge.flush(), { filesWritten: 0, pathsRemoved: 0 });
      }
      assert.deepEqual(fs.readFileSync(path.join(actual, '.git/index')), Buffer.from(before['/repo/.git/index'], 'base64'));
      assert.equal(fs.readFileSync(path.join(actual, 'file'), 'utf8'), 'unstaged bytes\n');
      git(actual, 'fsck', '--full', '--strict');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('libgit2 Commit refuses required signatures and invalid signature config before any write', {
  skip: available ? false : 'Run wasm/build.sh to build the libgit2 probe.',
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'html-git-signature-'));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_AUTHOR_DATE: '1700000000 +0000', GIT_COMMITTER_DATE: '1700000000 +0000' };
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const cases = [
    { value: 'true', refuse: true }, { value: 'yes', refuse: true },
    { value: '1', refuse: true }, { implicit: true, refuse: true },
    { value: 'invalid', refuse: true }, { value: 'false' },
    { value: 'no' }, { value: '0' }, { value: '' }, {},
  ];
  try {
    for (const [i, c] of cases.entries()) {
      const actual = path.join(root, String(i));
      fs.mkdirSync(actual);
      git(actual, 'init', '-b', 'main');
      git(actual, 'config', 'gpg.program', path.join(root, 'absent-gpg'));
      if (c.implicit) fs.appendFileSync(path.join(actual, '.git/config'), '\n[commit]\n\tgpgsign\n');
      else if (c.value !== undefined) git(actual, 'config', 'commit.gpgsign', c.value);
      fs.writeFileSync(path.join(actual, 'file'), 'staged bytes\n');
      git(actual, 'add', 'file');
      fs.writeFileSync(path.join(actual, 'file'), 'unstaged bytes\n');
      const reference = actual + '-git';
      fs.cpSync(actual, reference, { recursive: true });
      if (c.refuse) assert.throws(() => git(reference, 'commit', '-m', 'Commit'), /Command failed/);
      else git(reference, 'commit', '-m', 'Commit');
      const m = await loadWasm(artifact);
      const bridge = await importFolder(m, new NodeFS(actual));
      const before = snapshot(m);
      m.FS.writeFile('/commit-message', 'Commit\n');
      m.FS.writeFile('/commit-signature', 'Test <test@example.com> 1700000000 +0000');
      const rc = m._html_git_commit_probe();
      if (c.refuse) {
        assert.ok(rc < 0, `${i}: required or invalid signature config must fail`);
        assert.deepEqual(snapshot(m), before, `${i}: no repository byte change`);
        assert.deepEqual(await bridge.flush(), { filesWritten: 0, pathsRemoved: 0 });
        if (c.value === 'true') {
          const javascript = actual + '-js';
          fs.cpSync(actual, javascript, { recursive: true });
          const result = await new (loadCore().Repo)(new NodeFS(javascript)).commit({
            message: 'Commit\n', ident: { name: 'Test', email: 'test@example.com' },
            date: new Date('2023-11-14T22:13:20Z') });
          assert.ok(result.sha, 'JavaScript ignores the required signature');
          assert.doesNotMatch(git(javascript, 'cat-file', 'commit', 'HEAD'), /^gpgsig /m);
        }
      } else {
        assert.equal(rc, 0, `${i}: unsigned commit remains available`);
        await bridge.flush();
        assert.equal(git(actual, 'rev-parse', 'HEAD'), git(reference, 'rev-parse', 'HEAD'));
        assert.equal(git(actual, 'cat-file', 'commit', 'HEAD'), git(reference, 'cat-file', 'commit', 'HEAD'));
        assert.deepEqual(fs.readFileSync(path.join(actual, '.git/index')),
          Buffer.from(before['/repo/.git/index'], 'base64'));
        assert.deepEqual(await bridge.flush(), { filesWritten: 0, pathsRemoved: 0 });
      }
      assert.equal(git(actual, 'status', '--porcelain'), git(reference, 'status', '--porcelain'));
      assert.equal(fs.readFileSync(path.join(actual, 'file'), 'utf8'), 'unstaged bytes\n');
      git(actual, 'fsck', '--full', '--strict');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('libgit2 Commit completes resolved merges with Git and JavaScript results', {
  skip: available ? false : 'Run wasm/build.sh to build the libgit2 probe.',
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'html-git-merge-commit-'));
  const date = new Date('2023-11-14T22:13:20Z');
  const offset = -date.getTimezoneOffset();
  const zone = (offset < 0 ? '-' : '+') + String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0') +
    String(Math.abs(offset) % 60).padStart(2, '0');
  const signature = `Test <test@example.com> 1700000000 ${zone}`;
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_AUTHOR_DATE: `1700000000 ${zone}`, GIT_COMMITTER_DATE: `1700000000 ${zone}` };
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    for (const kind of ['resolved', 'unchanged-tree', 'multiple-heads']) {
      const actual = path.join(root, kind);
      fs.mkdirSync(actual);
      git(actual, 'init', '-b', 'main');
      fs.writeFileSync(path.join(actual, 'file'), 'base\n');
      git(actual, 'add', 'file');
      git(actual, 'commit', '-m', 'Base');
      const third = git(actual, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'Third').trim();
      git(actual, 'checkout', '-b', 'side');
      fs.writeFileSync(path.join(actual, 'file'), 'side\n');
      git(actual, 'commit', '-am', 'Side');
      const side = git(actual, 'rev-parse', 'HEAD').trim();
      git(actual, 'checkout', 'main');
      fs.writeFileSync(path.join(actual, 'file'), 'main\n');
      git(actual, 'commit', '-am', 'Main');
      const parent = git(actual, 'rev-parse', 'HEAD').trim();
      assert.throws(() => git(actual, 'merge', '--no-commit', 'side'), /Command failed/);
      const m = await loadWasm(artifact);
      const bridge = await importFolder(m, new NodeFS(actual));
      m.FS.writeFile('/commit-message', 'Merge side\n');
      m.FS.writeFile('/commit-signature', signature);
      const before = snapshot(m);
      assert.ok(m._html_git_commit_probe() < 0, 'unresolved merge must fail');
      assert.deepEqual(snapshot(m), before);
      assert.deepEqual(await bridge.flush(), { filesWritten: 0, pathsRemoved: 0 });
      fs.writeFileSync(path.join(actual, 'file'), kind === 'resolved' ? 'resolved\n' : 'main\n');
      git(actual, 'add', 'file');
      fs.writeFileSync(path.join(actual, 'file'), 'unstaged bytes\n');
      if (kind === 'multiple-heads') fs.appendFileSync(path.join(actual, '.git/MERGE_HEAD'), third + '\n');
      const reference = actual + '-git', javascript = actual + '-js';
      fs.cpSync(actual, reference, { recursive: true });
      fs.cpSync(actual, javascript, { recursive: true });
      const index = fs.readFileSync(path.join(actual, '.git/index'));
      const module = await loadWasm(artifact);
      const output = await importFolder(module, new NodeFS(actual));
      module.FS.writeFile('/commit-message', 'Merge side\n');
      module.FS.writeFile('/commit-signature', signature);
      const original = snapshot(module);
      assert.equal(module._html_git_commit_probe(), 0, kind);
      const after = snapshot(module);
      const changed = [...new Set([...Object.keys(original), ...Object.keys(after)])]
        .filter((p) => original[p] !== after[p]);
      assert.ok(changed.every((p) => p.startsWith('/repo/.git/')));
      await output.flush();
      git(reference, '-c', 'commit.gpgsign=false', 'commit', '--cleanup=verbatim', '-m', 'Merge side');
      const jsCommit = new (loadCore().Repo)(new NodeFS(javascript)).commit({
        message: 'Merge side\n', ident: { name: 'Test', email: 'test@example.com' }, date });
      let result;
      if (kind === 'multiple-heads') await assert.rejects(jsCommit, /nothing to commit/);
      else result = await jsCommit;
      const sha = git(actual, 'rev-parse', 'HEAD').trim();
      assert.equal(sha, git(reference, 'rev-parse', 'HEAD').trim());
      if (result) assert.equal(sha, result.sha);
      const parents = kind === 'multiple-heads' ? `${parent} ${side} ${third}` : `${parent} ${side}`;
      assert.equal(git(actual, 'show', '-s', '--format=%P'), parents + '\n');
      assert.equal(git(actual, 'cat-file', 'commit', sha), git(reference, 'cat-file', 'commit', sha));
      assert.equal(git(actual, 'reflog', '-1', '--format=%H %gs'), git(reference, 'reflog', '-1', '--format=%H %gs'));
      assert.equal(git(actual, 'status', '--porcelain'), git(reference, 'status', '--porcelain'));
      assert.deepEqual(fs.readFileSync(path.join(actual, '.git/index')), index);
      assert.equal(fs.readFileSync(path.join(actual, 'file'), 'utf8'), 'unstaged bytes\n');
      for (const name of ['MERGE_HEAD', 'MERGE_MSG', 'MERGE_MODE', 'AUTO_MERGE']) {
        assert.equal(fs.existsSync(path.join(actual, '.git', name)), false, name);
      }
      git(actual, 'fsck', '--full', '--strict');
      assert.deepEqual(await output.flush(), { filesWritten: 0, pathsRemoved: 0 });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('libgit2 Branch Create matches Git and preserves the index and files', {
  skip: available ? false : 'Run wasm/build.sh to build the libgit2 probe.',
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'html-git-branch-'));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const cases = [
    { name: 'topic' }, { name: 'feature/topic' }, { name: 'feature/日本語' },
    { name: 'topic', detached: true }, { name: 'topic', packed: true },
    { name: 'topic', noLog: true },
    { name: 'main', refuse: true }, { name: 'HEAD', refuse: true },
    { name: '-topic', refuse: true }, { name: 'bad..name', refuse: true },
    { name: 'bad name', refuse: true }, { name: 'topic.lock', refuse: true },
    { name: 'main/child', refuse: true }, { name: 'topic', unborn: true, refuse: true },
    { name: 'topic', locked: true, refuse: true },
  ];
  try {
    for (const [i, c] of cases.entries()) {
      const actual = path.join(root, String(i));
      fs.mkdirSync(actual);
      git(actual, 'init', '-b', 'main');
      git(actual, 'config', 'user.name', 'Test');
      git(actual, 'config', 'user.email', 'test@example.com');
      fs.writeFileSync(path.join(actual, 'file'), 'base\n');
      git(actual, 'add', 'file');
      if (!c.unborn) git(actual, 'commit', '-m', 'Base');
      if (c.detached) git(actual, 'checkout', '--detach');
      if (c.packed) git(actual, 'pack-refs', '--all');
      if (c.noLog) git(actual, 'config', 'core.logAllRefUpdates', 'false');
      if (c.locked) fs.writeFileSync(path.join(actual, '.git/refs/heads/topic.lock'), 'external lock');
      fs.writeFileSync(path.join(actual, 'file'), 'staged bytes\n');
      git(actual, 'add', 'file');
      fs.writeFileSync(path.join(actual, 'file'), 'unstaged bytes\n');
      fs.writeFileSync(path.join(actual, 'untracked'), 'untracked bytes\n');
      const reference = actual + '-git';
      const javascript = actual + '-js';
      fs.cpSync(actual, reference, { recursive: true });
      fs.cpSync(actual, javascript, { recursive: true });
      const m = await loadWasm(artifact);
      const bridge = await importFolder(m, new NodeFS(actual));
      const before = snapshot(m);
      m.FS.writeFile('/branch-name', c.name);
      if (c.refuse) assert.throws(() => git(reference, 'branch', '--', c.name, 'HEAD'));
      else git(reference, 'branch', '--', c.name, 'HEAD');
      assert.equal(typeof m._html_git_branch_create_probe, 'function', 'Branch Create export');
      const rc = m._html_git_branch_create_probe();
      if (c.refuse) {
        assert.ok(rc < 0, `${i}: invalid branch must fail`);
        assert.deepEqual(snapshot(m), before, `${i}: no repository byte change`);
        assert.deepEqual(await bridge.flush(), { filesWritten: 0, pathsRemoved: 0 });
      } else {
        assert.equal(rc, 0, `${i}: create branch`);
        const after = snapshot(m);
        const changed = Object.keys(after).filter((p) => after[p] !== before[p]);
        assert.deepEqual(changed.sort(), [
          '/repo/.git/refs/heads/' + c.name,
          ...(!c.noLog ? ['/repo/.git/logs/refs/heads/' + c.name] : []),
        ].sort(), `${i}: only the branch ref and its reflog change`);
        assert.deepEqual(await bridge.flush(), { filesWritten: c.noLog ? 1 : 2, pathsRemoved: 0 });
        assert.equal(git(actual, 'show-ref'), git(reference, 'show-ref'));
        await new (loadCore().Repo)(new NodeFS(javascript)).createBranch(c.name, {
          ident: { name: 'Test', email: 'test@example.com' },
        });
        assert.equal(git(actual, 'show-ref'), git(javascript, 'show-ref'));
        if (!c.noLog) {
          const log = (dir) => fs.readFileSync(path.join(dir, '.git/logs/refs/heads', c.name), 'utf8')
            .replace(/> \d+ [+-]\d{4}\t/g, '> TIME\t');
          assert.equal(log(actual), log(reference), `${i}: Git reflog`);
          assert.equal(log(actual), log(javascript), `${i}: JavaScript reflog`);
        }
        assert.deepEqual(await bridge.flush(), { filesWritten: 0, pathsRemoved: 0 });
      }
      assert.equal(git(actual, 'status', '--porcelain'), git(reference, 'status', '--porcelain'));
      assert.deepEqual(fs.readFileSync(path.join(actual, '.git/HEAD')), Buffer.from(before['/repo/.git/HEAD'], 'base64'));
      assert.deepEqual(fs.readFileSync(path.join(actual, '.git/index')), Buffer.from(before['/repo/.git/index'], 'base64'));
      assert.equal(fs.readFileSync(path.join(actual, 'file'), 'utf8'), 'unstaged bytes\n');
      assert.equal(fs.readFileSync(path.join(actual, 'untracked'), 'utf8'), 'untracked bytes\n');
      if (c.locked) {
        const lock = path.join(actual, '.git/refs/heads/topic.lock');
        assert.equal(fs.readFileSync(lock, 'utf8'), 'external lock');
        // Remove the fixture lock after the preservation checks, before fsck.
        fs.unlinkSync(lock);
      }
      git(actual, 'fsck', '--full', '--strict');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
