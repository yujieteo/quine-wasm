'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { loadCore, NodeFS } = require('./load-core');
const { loadWasm, copyToMemfs, snapshot } = require('./load-wasm');
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
    copyToMemfs(m, root);
    assert.equal(m._html_git_init_probe(), 0);
    const initialized = snapshot(m);
    for (let n = 0; n < 4; n++) {
      assert.equal(m._html_git_init_probe(), 0, 'Init and shutdown can repeat');
      assert.deepEqual(snapshot(m), initialized, 'reinit preserves repository bytes');
    }
    // Export the fixture, with empty directories, for command-line Git checks.
    function exportDir(rel = '') {
      fs.mkdirSync(path.join(root, rel), { recursive: true });
      for (const name of m.FS.readdir('/repo/' + rel).filter((n) => n !== '.' && n !== '..')) {
        const child = rel ? rel + '/' + name : name;
        if (m.FS.isDir(m.FS.stat('/repo/' + child).mode)) exportDir(child);
        else fs.writeFileSync(path.join(root, child), m.FS.readFile('/repo/' + child));
      }
    }
    exportDir();
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
