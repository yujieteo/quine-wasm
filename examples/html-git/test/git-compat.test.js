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
  const fresh = new G.Repo(new NodeFS(dir));
  st = await fresh.status();
  assert.deepEqual(st.entries, []);
  // Abbreviated ids and ~ / ^ are resolved from packed objects too.
  const headSha = git(dir, 'rev-parse', 'HEAD').trim();
  assert.equal(await fresh.resolveRev(headSha.slice(0, 8)), headSha);
  assert.equal(await fresh.resolveRev(headSha.slice(0, 8) + '^2'), git(dir, 'rev-parse', 'HEAD^2').trim());
  assert.equal((await fresh.graph()).total, Number(git(dir, 'rev-list', '--all', '--count').trim()));
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

test('log, rev syntax and the commit graph agree with real git', async () => {
  const { dir, repo, write } = newRepoDir();
  await repo.init('main');
  const commitFile = async (p, s, msg) => { write(p, s); await repo.add([p]); return (await repo.commit({ message: msg, ident: ME, date: tick() })).sha; };
  const a = await commitFile('a.txt', 'a\n', 'A');
  const b = await commitFile('a.txt', 'a\nb\n', 'B');
  await repo.createBranch('side', { ident: ME, switchTo: true });
  await commitFile('s.txt', 's\n', 'S1');
  await commitFile('s.txt', 's\ns\n', 'S2');
  await repo.switchBranch('main', { ident: ME });
  await commitFile('m.txt', 'm\n', 'M1');
  await repo.merge('side', { ident: ME, date: tick() });
  await commitFile('m.txt', 'm\nm\n', 'M2');
  git(dir, 'tag', '-a', 'v1', '-m', 'release', b);
  git(dir, 'branch', 'old', a);

  for (const rev of ['HEAD', 'HEAD~1', 'HEAD~2', 'HEAD^1^2', 'HEAD~1^2~1', 'main~3', 'v1', 'v1~1', b.slice(0, 7), 'side^']) {
    assert.equal(await repo.resolveRev(rev), git(dir, 'rev-parse', rev + '^{commit}').trim(), rev);
  }
  assert.equal(await repo.resolveRev('HEAD~20'), null);
  assert.equal(await repo.resolveRev('HEAD^2'), null);

  const log = await repo.log((await repo.head()).sha, 100);
  assert.deepEqual(log.map((c) => c.sha), git(dir, 'rev-list', '--date-order', 'HEAD').trim().split('\n'));

  const { rows, total } = await repo.graph();
  const all = git(dir, 'rev-list', '--all').trim().split('\n');
  assert.equal(total, all.length);
  assert.deepEqual(rows.map((r) => r.sha).sort(), [...all].sort());
  const pos = new Map(rows.map((r, i) => [r.sha, i]));
  for (const r of rows) for (const p of r.parents) assert.ok(pos.get(p) > pos.get(r.sha), 'parents come after children');
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    assert.deepEqual(r.before, i ? rows[i - 1].after : [], 'lanes continue from row to row');
    assert.ok(r.before[r.col] === r.sha || r.before[r.col] == null || r.col >= r.before.length);
    for (const p of r.parents) assert.ok(r.after.includes(p), 'every parent has a lane below its child');
  }
  assert.deepEqual(rows.at(-1).after, []);
  assert.deepEqual(rows[0].refs, ['HEAD -> main']);
  assert.ok(rows.find((r) => r.sha === b).refs.includes('tag: v1'));
  assert.ok(rows.find((r) => r.sha === a).refs.includes('old'));
  assert.ok(Math.max(...rows.map((r) => r.after.length)) >= 2, 'the merge shows two lanes');
});

test('reset --soft, --mixed, --hard and unstaging match real git', async () => {
  const { dir, repo, write } = newRepoDir();
  await repo.init('main');
  write('a.txt', 'one\n');
  write('b.txt', 'bee\n');
  await repo.add(['a.txt', 'b.txt']);
  const c1 = await repo.commit({ message: 'one', ident: ME, date: tick() });
  write('a.txt', 'two\n');
  write('c.txt', 'new\n');
  await repo.add(['a.txt', 'c.txt']);
  const c2 = await repo.commit({ message: 'two', ident: ME, date: tick() });

  let r = await repo.reset('HEAD~1', { mode: 'soft', ident: ME });
  assert.equal(r.sha, c1.sha);
  assert.equal(git(dir, 'rev-parse', 'HEAD').trim(), c1.sha);
  assert.equal(git(dir, 'rev-parse', 'ORIG_HEAD').trim(), c2.sha);
  assert.equal(git(dir, 'status', '--porcelain'), 'M  a.txt\nA  c.txt\n');
  assert.match(git(dir, 'reflog', '-1'), /reset: moving to HEAD~1/);

  await repo.reset(c2.sha, { mode: 'soft', ident: ME });
  await repo.reset('HEAD~1', { mode: 'mixed', ident: ME });
  assert.equal(git(dir, 'status', '--porcelain'), ' M a.txt\n?? c.txt\n');
  assert.deepEqual((await repo.status()).entries.map((e) => e.x + e.y + ' ' + e.path), [' M a.txt', '?? c.txt']);

  await repo.add(['a.txt', 'c.txt']);
  write('b.txt', 'bee edited\n');
  await repo.add(['b.txt']);
  const done = await repo.resetPaths(['a.txt', 'c.txt']);
  assert.deepEqual(done.map((d) => d.action), ['reset', 'untrack']);
  assert.equal(git(dir, 'status', '--porcelain'), ' M a.txt\nM  b.txt\n?? c.txt\n');

  write('d.txt', 'untracked survives\n');
  await repo.reset(c2.sha, { mode: 'hard', ident: ME });
  assert.equal(git(dir, 'rev-parse', 'HEAD').trim(), c2.sha);
  assert.equal(git(dir, 'status', '--porcelain'), '?? d.txt\n');
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'two\n');
  assert.equal(fs.readFileSync(path.join(dir, 'b.txt'), 'utf8'), 'bee\n');
  assert.equal(fs.readFileSync(path.join(dir, 'c.txt'), 'utf8'), 'new\n');

  await repo.reset('HEAD~1', { mode: 'hard', ident: ME });
  assert.equal(fs.existsSync(path.join(dir, 'c.txt')), false, 'hard reset removes files the target does not track');
  assert.equal(git(dir, 'status', '--porcelain'), '?? d.txt\n');

  // A hard reset also clears a conflicted merge.
  await repo.createBranch('x', { ident: ME, switchTo: true });
  write('a.txt', 'x\n'); await repo.add(['a.txt']); await repo.commit({ message: 'x', ident: ME, date: tick() });
  await repo.switchBranch('main', { ident: ME });
  write('a.txt', 'y\n'); await repo.add(['a.txt']); const y = await repo.commit({ message: 'y', ident: ME, date: tick() });
  assert.equal((await repo.merge('x', { ident: ME, date: tick() })).result, 'conflict');
  await assert.rejects(repo.reset('HEAD', { mode: 'soft' }), /middle of a merge/);
  await repo.reset('HEAD', { mode: 'hard', ident: ME });
  assert.equal(git(dir, 'status', '--porcelain'), '?? d.txt\n');
  assert.equal(git(dir, 'rev-parse', 'HEAD').trim(), y.sha);
  assert.equal(fs.existsSync(path.join(dir, '.git/MERGE_HEAD')), false);
  fsck(dir);
});

test('rebase: clean replay, conflicts with continue/skip/abort, and state real git understands', async () => {
  const { dir, repo, write } = newRepoDir();
  await repo.init('main');
  const commitFile = async (p, s, msg) => { write(p, s); await repo.add([p]); return (await repo.commit({ message: msg, ident: ME, date: tick() })).sha; };
  await commitFile('f.txt', '1\n2\n3\n4\n5\n', 'base');
  await repo.createBranch('topic', { ident: ME, switchTo: true });
  const t1 = await commitFile('f.txt', '1\n2\n3\n4\nfive\n', 'topic edits line 5');
  await commitFile('t.txt', 'topic\n', 'topic adds t.txt');
  await repo.switchBranch('main', { ident: ME });
  const m1 = await commitFile('f.txt', 'one\n2\n3\n4\n5\n', 'main edits line 1');
  await commitFile('same.txt', 'x\n', 'main adds same.txt');

  // Up to date / fast-forward.
  assert.equal((await repo.rebase('main~1', { ident: ME, date: tick() })).result, 'up-to-date');
  git(dir, 'branch', 'behind', 'main~2');
  await repo.switchBranch('behind', { ident: ME });
  let r = await repo.rebase('main', { ident: ME, date: tick() });
  assert.equal(r.result, 'fast-forward');
  assert.equal(git(dir, 'rev-parse', 'behind').trim(), git(dir, 'rev-parse', 'main').trim());

  // Clean rebase of topic onto main; authors are kept, committer is the rebaser.
  await repo.switchBranch('topic', { ident: ME });
  const origTopic = git(dir, 'rev-parse', 'topic').trim();
  r = await repo.rebase('main', { ident: { name: 'Rebaser', email: 'r@example.com' }, date: tick() });
  assert.equal(r.result, 'rebased');
  assert.equal(r.picked.length, 2);
  assert.equal(git(dir, 'symbolic-ref', 'HEAD').trim(), 'refs/heads/topic');
  assert.equal(git(dir, 'rev-list', '--count', 'main..topic').trim(), '2');
  assert.equal(git(dir, 'merge-base', 'main', 'topic').trim(), git(dir, 'rev-parse', 'main').trim());
  assert.equal(git(dir, 'log', '--format=%s|%an|%cn', 'main..topic'), 'topic adds t.txt|Ada Lovelace|Rebaser\ntopic edits line 5|Ada Lovelace|Rebaser\n');
  assert.equal(fs.readFileSync(path.join(dir, 'f.txt'), 'utf8'), 'one\n2\n3\n4\nfive\n');
  assert.equal(git(dir, 'status', '--porcelain'), '');
  assert.equal(git(dir, 'rev-parse', 'ORIG_HEAD').trim(), origTopic);
  assert.match(git(dir, 'reflog', '-1', 'topic'), /rebase \(finish\): refs\/heads\/topic onto/);
  assert.equal(fs.existsSync(path.join(dir, '.git/rebase-merge')), false);
  fsck(dir);

  // A commit whose change is already upstream is dropped.
  await repo.reset(origTopic, { mode: 'hard' });
  await repo.switchBranch('main', { ident: ME });
  write('f.txt', 'one\n2\n3\n4\nfive\n'); await repo.add(['f.txt']);
  await repo.commit({ message: 'main cherry-picks line 5', ident: ME, date: tick() });
  await repo.switchBranch('topic', { ident: ME });
  r = await repo.rebase('main', { ident: ME, date: tick() });
  assert.equal(r.result, 'rebased');
  assert.deepEqual(r.dropped, [t1]);
  assert.equal(git(dir, 'rev-list', '--count', 'main..topic').trim(), '1');

  // Conflicts: stop, leave state git understands, resolve, continue.
  await repo.reset(origTopic, { mode: 'hard' });
  await repo.switchBranch('main', { ident: ME });
  await repo.reset(m1, { mode: 'hard' });
  await commitFile('f.txt', 'one\n2\n3\n4\nFIVE\n', 'main edits line 5');
  const mainTip = git(dir, 'rev-parse', 'main').trim();
  await repo.switchBranch('topic', { ident: ME });
  r = await repo.rebase('main', { ident: ME, date: tick() });
  assert.equal(r.result, 'conflict');
  assert.equal(r.stopped, t1);
  assert.deepEqual(r.conflicts, [{ path: 'f.txt', reason: 'content' }]);
  assert.equal(fs.readFileSync(path.join(dir, 'f.txt'), 'utf8'), `one\n2\n3\n4\n<<<<<<< HEAD\nFIVE\n=======\nfive\n>>>>>>> ${t1.slice(0, 7)} (topic edits line 5)\n`);
  assert.equal(git(dir, 'status', '--porcelain'), 'UU f.txt\n');
  assert.match(git(dir, 'status'), /rebasing branch 'topic' on '[0-9a-f]{7}'/);
  assert.equal(git(dir, 'rev-parse', 'HEAD').trim(), mainTip);
  assert.equal(git(dir, 'rev-parse', 'REBASE_HEAD').trim(), t1);
  assert.equal((await repo.status()).rebasing.stopped, t1);
  await assert.rejects(repo.merge('main', { ident: ME }), /rebase is in progress/);
  await assert.rejects(repo.continueRebase({ ident: ME }), /unmerged/);
  write('f.txt', 'one\n2\n3\n4\nFIVE and five\n');
  await repo.add(['f.txt']);
  r = await repo.continueRebase({ ident: ME, date: tick() });
  assert.equal(r.result, 'rebased');
  assert.equal(git(dir, 'log', '--format=%s', 'main..topic'), 'topic adds t.txt\ntopic edits line 5\n');
  assert.equal(git(dir, 'show', 'topic~1:f.txt'), 'one\n2\n3\n4\nFIVE and five\n');
  assert.equal(git(dir, 'status', '--porcelain'), '');
  assert.equal(git(dir, 'symbolic-ref', '--short', 'HEAD').trim(), 'topic');
  fsck(dir);

  // Skip drops the conflicting commit and carries on.
  await repo.reset(origTopic, { mode: 'hard' });
  assert.equal((await repo.rebase('main', { ident: ME, date: tick() })).result, 'conflict');
  r = await repo.skipRebase({ ident: ME, date: tick() });
  assert.equal(r.result, 'rebased');
  assert.equal(git(dir, 'log', '--format=%s', 'main..topic'), 'topic adds t.txt\n');
  assert.equal(git(dir, 'status', '--porcelain'), '');

  // Abort puts everything back.
  await repo.reset(origTopic, { mode: 'hard' });
  assert.equal((await repo.rebase('main', { ident: ME, date: tick() })).result, 'conflict');
  await repo.abortRebase({ ident: ME });
  assert.equal(git(dir, 'symbolic-ref', 'HEAD').trim(), 'refs/heads/topic');
  assert.equal(git(dir, 'rev-parse', 'HEAD').trim(), origTopic);
  assert.equal(git(dir, 'status', '--porcelain'), '');
  assert.equal(fs.existsSync(path.join(dir, '.git/rebase-merge')), false);

  // Real git can abort and continue a rebase html-git stopped.
  assert.equal((await repo.rebase('main', { ident: ME, date: tick() })).result, 'conflict');
  git(dir, 'rebase', '--abort');
  assert.equal(git(dir, 'rev-parse', 'HEAD').trim(), origTopic);
  assert.equal(git(dir, 'status', '--porcelain'), '');
  assert.equal((await repo.rebase('main', { ident: ME, date: tick() })).result, 'conflict');
  write('f.txt', 'resolved by git\n');
  git(dir, 'add', 'f.txt');
  execFileSync('git', ['rebase', '--continue'], { cwd: dir, env: { ...gitEnv, GIT_EDITOR: 'true' }, stdio: 'ignore' });
  assert.equal(git(dir, 'log', '--format=%s|%an', 'main..topic'), 'topic adds t.txt|Ada Lovelace\ntopic edits line 5|Ada Lovelace\n');
  assert.equal(git(dir, 'symbolic-ref', '--short', 'HEAD').trim(), 'topic');
  fsck(dir);
});

test('diff output matches git diff, and patches apply with git apply', async () => {
  const { dir, repo, write } = newRepoDir();
  await repo.init('main');
  const body = (n, tag = '') => Array.from({ length: n }, (_, i) => `  line ${i + 1}${tag}`).join('\n') + '\n';
  write('code.js', 'function alpha() {\n' + body(20) + '}\n\nfunction beta() {\n' + body(20, ' b') + '}\n');
  write('gone.txt', 'bye\n');
  write('nonl.txt', 'no newline');
  write('bin.dat', Buffer.from([0, 1, 2, 3]));
  write('same.txt', 'same\n');
  await repo.add(['code.js', 'gone.txt', 'nonl.txt', 'bin.dat', 'same.txt']);
  const c1 = await repo.commit({ message: 'one', ident: ME, date: tick() });

  const lines = fs.readFileSync(path.join(dir, 'code.js'), 'utf8').split('\n');
  lines[10] = '  line 10 changed';
  lines[16] = '  line 16 changed';
  lines.splice(35, 1);
  lines.splice(40, 0, '  inserted in beta');
  write('code.js', lines.join('\n'));
  write('nonl.txt', 'no newline\n');
  write('bin.dat', Buffer.from([0, 9, 9]));
  fs.rmSync(path.join(dir, 'gone.txt'));
  write('staged-new.txt', 'brand\nnew\n');
  await repo.add(['staged-new.txt', 'gone.txt']);
  write('staged-new.txt', 'brand\nnewer\n');
  write('empty.txt', '');
  await repo.add(['empty.txt']);

  const same = async (opts, ...args) => assert.equal((await repo.diff(opts)).text, git(dir, 'diff', ...args), `git diff ${args.join(' ')}`);
  await same({}, );
  await same({ from: 'HEAD', to: 'index' }, '--cached');
  await same({ from: 'HEAD', to: 'worktree' }, 'HEAD');
  assert.match((await repo.diff()).text, /@@ -8,13 \+8,13 @@ function alpha\(\) \{\n/);
  assert.deepEqual((await repo.diff({ from: 'HEAD', to: 'worktree' })).files.map((f) => f.status + ' ' + f.path),
    ['M bin.dat', 'M code.js', 'A empty.txt', 'D gone.txt', 'M nonl.txt', 'A staged-new.txt']);

  await repo.add(['code.js', 'nonl.txt', 'bin.dat', 'staged-new.txt']);
  const c2 = await repo.commit({ message: 'two', ident: ME, date: tick() });
  await same({ from: c1.sha, to: c2.sha }, c1.sha, c2.sha);
  await same({ from: 'HEAD~1', to: 'HEAD' }, 'HEAD~1', 'HEAD');
  assert.equal((await repo.diff()).text, '');

  // Random edits: our patch must apply cleanly with git apply and reproduce the file.
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const words = ['a', 'b', 'c', '}', '', 'return x;', 'if (y) {'];
  let text = Array.from({ length: 300 }, () => words[rnd(words.length)]).join('\n') + '\n';
  write('rand.txt', text);
  await repo.add(['rand.txt']);
  await repo.commit({ message: 'rand', ident: ME, date: tick() });
  for (let round = 0; round < 5; round++) {
    const ls = text.split('\n');
    for (let k = 0; k < 25; k++) {
      const at = rnd(ls.length), op = rnd(3);
      if (op === 0) ls.splice(at, 1); else if (op === 1) ls.splice(at, 0, words[rnd(words.length)]); else ls[at] = words[rnd(words.length)];
    }
    text = ls.join('\n');
    write('rand.txt', text);
    const patch = path.join(tmpRoot, `r${n}-${round}.patch`);
    fs.writeFileSync(patch, (await repo.diff()).text);
    git(dir, 'apply', '--cached', '--check', patch);
    git(dir, 'apply', '--cached', patch);
    assert.equal(git(dir, 'diff'), '', 'index now matches the working tree');
    assert.equal((await repo.diff()).text, '');
  }
});

test('stash push, list, apply, pop and drop are compatible with git stash', async () => {
  const { dir, repo, write } = newRepoDir();
  await repo.init('main');
  write('f.txt', 'a\nb\n'); write('del.txt', 'd\n'); write('keep.txt', 'k\n');
  await repo.add(['f.txt', 'del.txt', 'keep.txt']);
  const c1 = await repo.commit({ message: 'init', ident: ME, date: tick() });

  assert.equal((await repo.stashPush({ ident: ME })).result, 'no-changes');
  write('f.txt', 'a\nb\nc\n');
  fs.rmSync(path.join(dir, 'del.txt'));
  write('new.txt', 'n\n');
  await repo.add(['new.txt']);
  write('untracked.txt', 'u\n');
  let r = await repo.stashPush({ ident: ME, date: tick() });
  assert.equal(r.result, 'saved');
  assert.equal(r.message, `WIP on main: ${c1.sha.slice(0, 7)} init`);
  assert.equal(git(dir, 'status', '--porcelain'), '?? untracked.txt\n', 'tracked changes are put away, untracked files stay');
  assert.equal(git(dir, 'stash', 'list'), `stash@{0}: WIP on main: ${c1.sha.slice(0, 7)} init\n`);
  assert.equal(git(dir, 'rev-parse', 'stash^1').trim(), c1.sha);
  assert.equal(git(dir, 'log', '-1', '--format=%s', 'stash^2').trim(), `index on main: ${c1.sha.slice(0, 7)} init`);
  assert.equal(git(dir, 'show', 'stash:f.txt'), 'a\nb\nc\n');
  assert.equal(git(dir, 'show', 'stash^2:new.txt'), 'n\n');
  assert.match(git(dir, 'stash', 'show', '--name-status'), /M\tf\.txt/);
  fsck(dir);

  // Real git applies our stash; we apply git's stash.
  git(dir, 'stash', 'apply');
  assert.equal(git(dir, 'status', '--porcelain'), ' D del.txt\n M f.txt\nA  new.txt\n?? untracked.txt\n');
  git(dir, 'stash', 'push', '-q', '-m', 'from real git');
  let list = await repo.stashList();
  assert.deepEqual(list.map((e) => `${e.index}: ${e.message}`), ['0: On main: from real git', `1: WIP on main: ${c1.sha.slice(0, 7)} init`]);
  assert.equal(await repo.resolveRev('stash@{1}'), git(dir, 'rev-parse', 'stash@{1}').trim());
  r = await repo.stashApply(0, { pop: true });
  assert.equal(r.result, 'applied');
  assert.equal(git(dir, 'status', '--porcelain'), ' D del.txt\n M f.txt\nA  new.txt\n?? untracked.txt\n');
  assert.equal(git(dir, 'stash', 'list'), `stash@{0}: WIP on main: ${c1.sha.slice(0, 7)} init\n`);

  // Stash with a message, then drop the older entry; git still reads the list.
  r = await repo.stashPush({ message: 'second', ident: ME, date: tick() });
  assert.equal(r.message, 'On main: second');
  assert.equal(git(dir, 'stash', 'list'), `stash@{0}: On main: second\nstash@{1}: WIP on main: ${c1.sha.slice(0, 7)} init\n`);
  const second = git(dir, 'rev-parse', 'stash@{0}').trim();
  await repo.stashDrop(1);
  assert.equal(git(dir, 'stash', 'list'), 'stash@{0}: On main: second\n');
  assert.equal(git(dir, 'rev-parse', 'refs/stash').trim(), second);
  git(dir, 'stash', 'drop', '-q');
  assert.deepEqual(await repo.stashList(), []);

  // Conflicting apply: markers like git's, the stash is kept.
  write('f.txt', 'a\nSTASHED\n');
  await repo.stashPush({ ident: ME, date: tick() });
  write('f.txt', 'a\nCOMMITTED\n');
  await repo.add(['f.txt']);
  await repo.commit({ message: 'change f', ident: ME, date: tick() });
  r = await repo.stashApply(0, { pop: true });
  assert.equal(r.result, 'conflict');
  assert.equal(fs.readFileSync(path.join(dir, 'f.txt'), 'utf8'), 'a\n<<<<<<< Updated upstream\nCOMMITTED\n=======\nSTASHED\n>>>>>>> Stashed changes\n');
  assert.equal(git(dir, 'status', '--porcelain'), 'UU f.txt\n?? untracked.txt\n');
  assert.equal((await repo.stashList()).length, 1, 'kept after a conflict');
  await repo.reset('HEAD', { mode: 'hard' });
  await repo.stashDrop(0);
  assert.equal(fs.existsSync(path.join(dir, '.git/refs/stash')), false);
  fsck(dir);
});

test('stash apply works next to unrelated local changes, like git', async () => {
  const { dir, repo, write } = newRepoDir();
  await repo.init('main');
  write('a.txt', 'a\n'); write('b.txt', 'b\n');
  await repo.add(['a.txt', 'b.txt']);
  await repo.commit({ message: 'init', ident: ME, date: tick() });
  write('a.txt', 'a stashed\n');
  await repo.stashPush({ ident: ME, date: tick() });
  write('b.txt', 'b local\n');
  await repo.add(['b.txt']);
  write('b.txt', 'b local, edited again\n');
  const r = await repo.stashApply(0);
  assert.equal(r.result, 'applied');
  assert.equal(git(dir, 'status', '--porcelain'), ' M a.txt\nMM b.txt\n');
  assert.equal(fs.readFileSync(path.join(dir, 'b.txt'), 'utf8'), 'b local, edited again\n');
  git(dir, 'checkout', '--', 'a.txt');
  write('a.txt', 'a local\n');
  await assert.rejects(repo.stashApply(0), /would be overwritten:\n {2}a\.txt/);
});
