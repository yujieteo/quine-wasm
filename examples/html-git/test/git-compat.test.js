'use strict';
// Compatibility proof: drives the engine from index.html against real directories
// and checks every result with the real git CLI.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawn } = require('node:child_process');
const { loadCore, NodeFS } = require('./load-core');

const G = loadCore();
const ME = { name: 'Ada Lovelace', email: 'ada@example.com' };
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'html-git-test-'));
test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const gitEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: path.join(tmpRoot, 'gitconfig'),
  GIT_AUTHOR_NAME: 'Real Git', GIT_AUTHOR_EMAIL: 'real@example.com',
  GIT_COMMITTER_NAME: 'Real Git', GIT_COMMITTER_EMAIL: 'real@example.com',
  LANG: 'C', LC_ALL: 'C',
};
fs.writeFileSync(gitEnv.GIT_CONFIG_GLOBAL, '[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' });
let n = 0;
function newRepoDir() {
  const dir = path.join(tmpRoot, `repo${++n}`);
  fs.mkdirSync(dir);
  return { dir, repo: new G.Repo(new NodeFS(dir)), write: (p, s) => { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), s); } };
}
function fsck(dir) {
  // `git fsck --full --strict` exits non-zero on any problem; also fail on warnings.
  const out = execFileSync('git', ['fsck', '--full', '--strict', '--no-dangling'], { cwd: dir, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(out.trim(), '', 'git fsck output: ' + out);
}
let clock = 1700000000000;
const tick = () => new Date((clock += 60000));

test('SHA-1 matches node:crypto', () => {
  for (const len of [0, 1, 55, 56, 63, 64, 65, 1000, 100000]) {
    const buf = crypto.randomBytes(len);
    assert.equal(G.sha1Hex(new Uint8Array(buf)), crypto.createHash('sha1').update(buf).digest('hex'));
  }
});

test('deflate/inflate interoperate with zlib', () => {
  const samples = [
    Buffer.alloc(0), Buffer.from('a'), Buffer.from('hello hello hello hello world\n'.repeat(500)),
    crypto.randomBytes(70000), Buffer.from(Array.from({ length: 50000 }, (_, i) => (i * 7) % 13)),
    Buffer.alloc(100000, 0x41),
  ];
  for (const s of samples) {
    const ours = G.deflate(new Uint8Array(s));
    assert.deepEqual(Buffer.from(zlib.inflateSync(ours)), s, 'zlib inflates our deflate');
    for (const level of [0, 1, 6, 9]) {
      const theirs = zlib.deflateSync(s, { level });
      const r = G.inflate(new Uint8Array(theirs));
      assert.deepEqual(Buffer.from(r.data), s, `we inflate zlib level ${level}`);
      assert.equal(r.end, theirs.length);
    }
  }
  // Stream followed by trailing data (as inside a packfile): end offset must be exact.
  const a = zlib.deflateSync(Buffer.from('first object')), b = Buffer.from('TRAILING');
  const r = G.inflate(new Uint8Array(Buffer.concat([a, b])));
  assert.equal(Buffer.from(r.data).toString(), 'first object');
  assert.equal(r.end, a.length);
});

test('diff3 merge', () => {
  const base = 'a\nb\nc\nd\ne\n';
  const clean = G.merge3(base, 'A\nb\nc\nd\ne\n', 'a\nb\nc\nd\nE\n', 'HEAD', 'x');
  assert.equal(clean.conflicts, 0);
  assert.equal(clean.text, 'A\nb\nc\nd\nE\n');
  const conf = G.merge3(base, 'a\nB1\nc\nd\ne\n', 'a\nB2\nc\nd\ne\n', 'HEAD', 'feature');
  assert.equal(conf.conflicts, 1);
  assert.equal(conf.text, 'a\n<<<<<<< HEAD\nB1\n=======\nB2\n>>>>>>> feature\nc\nd\ne\n');
});

test('init/add/commit/branch/merge produce a repository real git accepts', async () => {
  const { dir, repo, write } = newRepoDir();
  await repo.init('main');
  assert.equal(git(dir, 'rev-parse', '--is-inside-work-tree').trim(), 'true');
  assert.equal(git(dir, 'symbolic-ref', 'HEAD').trim(), 'refs/heads/main');

  write('README.md', '# demo\n');
  write('src/app.js', 'console.log("hi");\n');
  write('src/lib/util.js', 'module.exports = 1;\n');
  write('notes.txt', 'line1\nline2\nline3\n');
  write('.gitignore', '*.log\nbuild/\n');
  write('debug.log', 'ignored\n');
  write('build/out.bin', 'ignored\n');
  write('ünïcode name.txt', 'utf8 path\n');

  let st = await repo.status();
  const untracked = st.entries.filter((e) => e.x === '?').map((e) => e.path);
  assert.deepEqual(untracked.sort(), ['.gitignore', 'README.md', 'notes.txt', 'src/app.js', 'src/lib/util.js', 'ünïcode name.txt'].sort());
  // Our view of untracked files matches git's (both honour .gitignore).
  const gitUntracked = git(dir, '-c', 'core.quotepath=off', 'ls-files', '--others', '--exclude-standard').trim().split('\n').sort();
  assert.deepEqual(untracked.sort(), gitUntracked);

  await repo.add(untracked);
  // The index we wrote is readable by git and produces the same tree git would.
  const lsFiles = git(dir, 'ls-files', '-s');
  assert.match(lsFiles, /100644 [0-9a-f]{40} 0\tsrc\/lib\/util.js/);
  const c1 = await repo.commit({ message: 'Initial commit', ident: ME, date: tick() });
  assert.equal(git(dir, 'rev-parse', 'HEAD').trim(), c1.sha);
  assert.equal(git(dir, 'write-tree').trim(), (await repo.readCommit(c1.sha)).tree, 'git computes the same tree from our index');
  assert.equal(git(dir, 'status', '--porcelain').trim(), '', 'working tree clean after commit');
  assert.equal(git(dir, 'log', '-1', '--format=%an <%ae>|%s').trim(), 'Ada Lovelace <ada@example.com>|Initial commit');
  assert.equal(git(dir, 'cat-file', '-t', c1.sha).trim(), 'commit');
  assert.equal(git(dir, 'cat-file', '-p', 'HEAD:src/app.js'), 'console.log("hi");\n');
  assert.equal(git(dir, 'cat-file', '-p', `HEAD:${'ünïcode name.txt'}`), 'utf8 path\n');
  fsck(dir);

  // Modify, delete, stage — git agrees with our status.
  write('notes.txt', 'line1\nline2 changed on main\nline3\n');
  fs.rmSync(path.join(dir, 'src/lib/util.js'));
  st = await repo.status();
  assert.deepEqual(st.entries.map((e) => e.x + e.y + ' ' + e.path), [' M notes.txt', ' D src/lib/util.js']);
  assert.equal(git(dir, 'status', '--porcelain'), ' M notes.txt\n D src/lib/util.js\n');
  await repo.add(['notes.txt', 'src/lib/util.js']);
  assert.equal(git(dir, 'status', '--porcelain'), 'M  notes.txt\nD  src/lib/util.js\n');

  const c2 = await repo.commit({ message: 'Edit notes, drop util\n\nLonger body line.', ident: ME, date: tick() });
  assert.equal(git(dir, 'log', '-1', '--format=%B').trim(), 'Edit notes, drop util\n\nLonger body line.');
  assert.equal(git(dir, 'status', '--porcelain'), '');
  fsck(dir);

  // Branch create/list/switch.
  await repo.createBranch('feature', { ident: ME });
  assert.match(git(dir, 'branch', '--list'), /\* main\n {2}feature|  feature\n\* main/);
  await repo.switchBranch('feature', { ident: ME });
  assert.equal(git(dir, 'symbolic-ref', '--short', 'HEAD').trim(), 'feature');
  write('feature.txt', 'feature work\n');
  write('README.md', '# demo\n\nfeature docs\n');
  await repo.add(['feature.txt', 'README.md']);
  const f1 = await repo.commit({ message: 'Feature work', ident: ME, date: tick() });
  assert.equal(git(dir, 'status', '--porcelain'), '');

  // Fast-forward merge: main -> feature tip.
  await repo.switchBranch('main', { ident: ME });
  assert.equal(fs.existsSync(path.join(dir, 'feature.txt')), false, 'switch removes files not on the target branch');
  assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), '# demo\n');
  assert.equal(git(dir, 'status', '--porcelain'), '');
  let r = await repo.merge('feature', { ident: ME, date: tick() });
  assert.equal(r.result, 'fast-forward');
  assert.equal(git(dir, 'rev-parse', 'main').trim(), f1.sha);
  assert.equal(git(dir, 'status', '--porcelain'), '');
  r = await repo.merge('feature', { ident: ME, date: tick() });
  assert.equal(r.result, 'up-to-date');

  // Diverge and three-way merge without conflicts.
  await repo.createBranch('topic', { ident: ME, switchTo: true });
  assert.equal(git(dir, 'symbolic-ref', '--short', 'HEAD').trim(), 'topic');
  write('notes.txt', 'line1\nline2 changed on main\nline3 changed on topic\n');
  write('topic/new.txt', 'from topic\n');
  await repo.add(['notes.txt', 'topic/new.txt']);
  const t1 = await repo.commit({ message: 'Topic change', ident: ME, date: tick() });
  await repo.switchBranch('main', { ident: ME });
  write('notes.txt', 'line0 added on main\nline1\nline2 changed on main\nline3\n');
  await repo.add(['notes.txt']);
  const m1 = await repo.commit({ message: 'Main change', ident: ME, date: tick() });
  r = await repo.merge('topic', { ident: ME, date: tick() });
  assert.equal(r.result, 'merged');
  assert.equal(git(dir, 'rev-parse', 'HEAD^1').trim(), m1.sha);
  assert.equal(git(dir, 'rev-parse', 'HEAD^2').trim(), t1.sha);
  assert.equal(git(dir, 'log', '-1', '--format=%s').trim(), "Merge branch 'topic'");
  assert.equal(fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8'), 'line0 added on main\nline1\nline2 changed on main\nline3 changed on topic\n');
  assert.equal(git(dir, 'status', '--porcelain'), '');
  assert.equal(git(dir, 'merge-base', 'main', 'topic').trim(), t1.sha);
  fsck(dir);

  // Conflicting merge: stops, leaves git-standard state, then resolves with add + commit.
  await repo.switchBranch('topic', { ident: ME });
  write('notes.txt', 'line0 added on main\nline1 TOPIC\nline2 changed on main\nline3 changed on topic\n');
  await repo.add(['notes.txt']);
  const t2 = await repo.commit({ message: 'Topic edits line1', ident: ME, date: tick() });
  await repo.switchBranch('main', { ident: ME });
  write('notes.txt', 'line0 added on main\nline1 MAIN\nline2 changed on main\nline3 changed on topic\n');
  await repo.add(['notes.txt']);
  await repo.commit({ message: 'Main edits line1', ident: ME, date: tick() });
  r = await repo.merge('topic', { ident: ME, date: tick() });
  assert.equal(r.result, 'conflict');
  assert.deepEqual(r.conflicts, [{ path: 'notes.txt', reason: 'content' }]);
  assert.equal(git(dir, 'status', '--porcelain'), 'UU notes.txt\n');
  assert.equal(git(dir, 'rev-parse', 'MERGE_HEAD').trim(), t2.sha);
  assert.equal(git(dir, 'ls-files', '-u').trim().split('\n').length, 3, 'stages 1, 2 and 3 recorded');
  assert.equal(fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8'),
    'line0 added on main\n<<<<<<< HEAD\nline1 MAIN\n=======\nline1 TOPIC\n>>>>>>> topic\nline2 changed on main\nline3 changed on topic\n');
  await assert.rejects(repo.commit({ message: 'nope', ident: ME }), /unmerged/);
  await assert.rejects(repo.switchBranch('topic', { ident: ME }), /merge is in progress/);
  write('notes.txt', 'line0 added on main\nline1 MAIN+TOPIC\nline2 changed on main\nline3 changed on topic\n');
  await repo.add(['notes.txt']);
  assert.equal(git(dir, 'status', '--porcelain'), 'M  notes.txt\n');
  const mm = await repo.commit({ message: await repo.mergeMessage(), ident: ME, date: tick() });
  assert.equal(mm.parents.length, 2);
  assert.equal(git(dir, 'rev-parse', 'HEAD^2').trim(), t2.sha);
  assert.equal(git(dir, 'log', '-1', '--format=%s').trim(), "Merge branch 'topic'");
  assert.equal(fs.existsSync(path.join(dir, '.git/MERGE_HEAD')), false);
  assert.equal(git(dir, 'status', '--porcelain'), '');
  fsck(dir);

  // Abort path: conflict then abort restores HEAD exactly.
  await repo.switchBranch('topic', { ident: ME });
  write('feature.txt', 'topic version\n');
  await repo.add(['feature.txt']);
  await repo.commit({ message: 'topic feature.txt', ident: ME, date: tick() });
  await repo.switchBranch('main', { ident: ME });
  fs.rmSync(path.join(dir, 'feature.txt'));
  await repo.add(['feature.txt']);
  const beforeAbort = await repo.commit({ message: 'remove feature.txt', ident: ME, date: tick() });
  r = await repo.merge('topic', { ident: ME, date: tick() });
  assert.equal(r.result, 'conflict');
  assert.match(r.conflicts[0].reason, /modify\/delete/);
  assert.equal(git(dir, 'status', '--porcelain'), 'DU feature.txt\n');
  await repo.abortMerge();
  assert.equal(git(dir, 'rev-parse', 'HEAD').trim(), beforeAbort.sha);
  assert.equal(git(dir, 'status', '--porcelain'), '');

  const graph = git(dir, 'log', '--all', '--graph', '--oneline');
  assert.match(graph, /Merge branch 'topic'/);
  assert.match(graph, /\|\\/);
  git(dir, 'reflog', 'show', 'main');
  fsck(dir);
  assert.equal(git(dir, 'rev-list', '--all', '--count').trim(), '11');
});

test('works on repositories created and packed by real git', async () => {
  const { dir, repo, write } = newRepoDir();
  git(dir, 'init', '-q', '-b', 'trunk');
  write('a.txt', 'alpha\n'.repeat(200));
  write('dir/b.txt', 'beta\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'real git 1');
  write('a.txt', 'alpha\n'.repeat(200) + 'more\n');
  git(dir, 'commit', '-q', '-am', 'real git 2');
  git(dir, 'branch', 'side');
  git(dir, 'gc', '-q', '--aggressive');
  assert.equal(fs.readdirSync(path.join(dir, '.git/objects/pack')).filter((f) => f.endsWith('.pack')).length, 1);
  assert.ok(fs.existsSync(path.join(dir, '.git/packed-refs')));

  let st = await repo.status();
  assert.equal(st.head.branch, 'trunk');
  assert.deepEqual(st.entries, [], 'clean according to html-git (objects read from pack, deltas applied)');
  const brs = (await repo.branches()).map((b) => b.name);
  assert.deepEqual(brs, ['side', 'trunk']);

  write('dir/b.txt', 'beta changed by html-git\n');
  await repo.add(['dir/b.txt']);
  await repo.commit({ message: 'html-git on top of a pack', ident: ME, date: tick() });
  await repo.switchBranch('side', { ident: ME });
  assert.equal(fs.readFileSync(path.join(dir, 'dir/b.txt'), 'utf8'), 'beta\n');
  write('c.txt', 'gamma\n');
  await repo.add(['c.txt']);
  await repo.commit({ message: 'side commit', ident: ME, date: tick() });
  await repo.switchBranch('trunk', { ident: ME });
  const r = await repo.merge('side', { ident: ME, date: tick() });
  assert.equal(r.result, 'merged');
  assert.equal(git(dir, 'log', '-1', '--format=%s').trim(), "Merge branch 'side' into trunk");
  assert.equal(git(dir, 'status', '--porcelain'), '');
  fsck(dir);
  git(dir, 'gc', '-q');
  fsck(dir);
  st = await new G.Repo(new NodeFS(dir)).status();
  assert.deepEqual(st.entries, []);
});

// Minimal CGI bridge so `git http-backend` serves a bare repository over smart HTTP.
function startGitHttpServer(projectRoot) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    if (req.headers.authorization !== 'Basic ' + Buffer.from('tester:s3cret').toString('base64')) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="git"' });
      res.end();
      return;
    }
    const child = spawn('git', ['http-backend'], {
      env: {
        ...gitEnv, GIT_PROJECT_ROOT: projectRoot, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: decodeURIComponent(u.pathname),
        REQUEST_METHOD: req.method, QUERY_STRING: u.search.slice(1), CONTENT_TYPE: req.headers['content-type'] || '',
        REMOTE_USER: 'tester', REMOTE_ADDR: '127.0.0.1', GATEWAY_INTERFACE: 'CGI/1.1',
      },
    });
    req.pipe(child.stdin);
    const chunks = [];
    child.stdout.on('data', (c) => chunks.push(c));
    child.on('close', () => {
      const out = Buffer.concat(chunks);
      const sep = out.indexOf('\r\n\r\n');
      const headers = {};
      let status = 200;
      for (const line of out.subarray(0, sep).toString().split('\r\n')) {
        const i = line.indexOf(':');
        const k = line.slice(0, i).trim(), v = line.slice(i + 1).trim();
        if (k.toLowerCase() === 'status') status = parseInt(v, 10);
        else headers[k] = v;
      }
      res.writeHead(status, headers);
      res.end(out.subarray(sep + 4));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('push over smart HTTP to a bare repository served by git http-backend', async () => {
  const bareRoot = path.join(tmpRoot, 'srv');
  fs.mkdirSync(bareRoot);
  git(bareRoot, 'init', '-q', '--bare', 'remote.git');
  const bare = path.join(bareRoot, 'remote.git');
  git(bare, 'config', 'http.receivepack', 'true');
  git(bare, 'config', 'receive.fsckObjects', 'true');
  const server = await startGitHttpServer(bareRoot);
  const url = `http://127.0.0.1:${server.address().port}/remote.git`;
  try {
    const { dir, repo, write } = newRepoDir();
    await repo.init('main');
    write('hello.txt', 'hello over http\n');
    write('big.bin', crypto.randomBytes(200000));
    await repo.add(['hello.txt', 'big.bin']);
    const c1 = await repo.commit({ message: 'first', ident: ME, date: tick() });

    await assert.rejects(repo.push({ url, branch: 'main', username: 'tester', token: 'wrong' }), /authentication failed/);
    let r = await repo.push({ url, branch: 'main', username: 'tester', token: 's3cret' });
    assert.equal(r.result, 'new-branch');
    assert.equal(git(bare, 'rev-parse', 'main').trim(), c1.sha);
    assert.equal(git(dir, 'rev-parse', 'refs/remotes/origin/main').trim(), c1.sha);

    write('hello.txt', 'hello again\n');
    await repo.add(['hello.txt']);
    const c2 = await repo.commit({ message: 'second', ident: ME, date: tick() });
    await repo.createBranch('dev', { ident: ME });
    r = await repo.push({ url, branch: 'main', username: 'tester', token: 's3cret' });
    assert.equal(r.result, 'updated');
    assert.equal(r.objects, 3, 'only the new commit, tree and blob are sent');
    r = await repo.push({ url, branch: 'main', username: 'tester', token: 's3cret' });
    assert.equal(r.result, 'up-to-date');
    r = await repo.push({ url, branch: 'dev', username: 'tester', token: 's3cret' });
    assert.equal(r.result, 'new-branch');
    assert.equal(r.objects, 0);
    assert.equal(git(bare, 'rev-parse', 'main').trim(), c2.sha);
    assert.equal(git(bare, 'rev-parse', 'dev').trim(), c2.sha);
    assert.equal(git(bare, 'cat-file', '-p', 'main:hello.txt'), 'hello again\n');
    fsck(bare);

    // A remote that moved ahead (commit we do not have) is refused client-side.
    const other = path.join(tmpRoot, 'other');
    git(tmpRoot, 'clone', '-q', bare, other);
    fs.writeFileSync(path.join(other, 'x.txt'), 'x\n');
    git(other, 'add', 'x.txt');
    git(other, 'commit', '-q', '-m', 'from elsewhere');
    git(other, 'push', '-q', 'origin', 'main');
    write('hello.txt', 'diverged\n');
    await repo.add(['hello.txt']);
    await repo.commit({ message: 'third', ident: ME, date: tick() });
    await assert.rejects(repo.push({ url, branch: 'main', username: 'tester', token: 's3cret' }), /rejected/);
  } finally {
    server.close();
  }
});
