'use strict';
// Read-only engine timings. Use a real clone after `git gc`.
const { performance } = require('node:perf_hooks');
const { loadCore, NodeFS } = require('./load-core');
const { execFileSync } = require('node:child_process');
const { loadWasm, copyToMemfs } = require('./load-wasm');
const assert = require('node:assert/strict');
const root = process.argv[2];
if (!root) throw new Error('Usage: node test/benchmark.js <packed-repository>');
const G = loadCore(process.argv[3]);
(async () => {
  const runs = [];
  for (let trial = 0; trial < 5; trial++) {
  const times = {};
  const measure = async (name, fn) => { const t = performance.now(); await fn(); times[name] = +(performance.now() - t).toFixed(2); };
  const repo = new G.Repo(new NodeFS(root));
  const refresh = async () => { await repo.kind(); await repo.status(); await repo.branches(); await repo.getConfig('remote', 'origin', 'url'); await repo.stashList(); };
  await measure('open', refresh);
  await measure('refresh', refresh);
  for (const [name, fn] of [['status', () => repo.status()], ['log', () => repo.resolveRev('HEAD').then((sha) => repo.log(sha, 100))], ['tree', () => repo.graph({ limit: 100 })]]) await measure(name, fn);
  if (process.env.HTML_GIT_WASM) {
    await measure('jsHeadAndIndex', async () => {
      await repo.readCommit(await repo.resolveRev('HEAD'));
      await repo.readIndex();
    });
    let wasm;
    await measure('wasmInstantiate', async () => { wasm = await loadWasm(process.env.HTML_GIT_WASM); });
    await measure('wasmCopy', () => copyToMemfs(wasm, root));
    await measure('wasmHeadAndIndex', () => assert.equal(wasm._html_git_probe(), 0));
    const result = wasm.FS.readFile('/probe-result', { encoding: 'utf8' }).split('\n');
    assert.equal(result[0], await repo.resolveRev('HEAD'));
    assert.equal(result[1], (await repo.readCommit(result[0])).tree);
  }
  runs.push(times);
  }
  const times = Object.fromEntries(Object.keys(runs[0]).map((key) => [key, runs.map((r) => r[key]).sort((a,b) => a-b)[2]]));
  console.log(JSON.stringify({trials:5, head:execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {encoding:'utf8'}).trim(), commits:execFileSync('git', ['-C', root, 'rev-list', '--all', '--count'], {encoding:'utf8'}).trim(), milliseconds:times}, null, 2));
})();
