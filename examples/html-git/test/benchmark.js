'use strict';
// Read-only engine timings. Use a real clone after `git gc`.
const { performance } = require('node:perf_hooks');
const { loadCore, NodeFS } = require('./load-core');
const { execFileSync } = require('node:child_process');
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
  runs.push(times);
  }
  const times = Object.fromEntries(Object.keys(runs[0]).map((key) => [key, runs.map((r) => r[key]).sort((a,b) => a-b)[2]]));
  console.log(JSON.stringify({trials:5, head:execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {encoding:'utf8'}).trim(), commits:execFileSync('git', ['-C', root, 'rev-list', '--all', '--count'], {encoding:'utf8'}).trim(), milliseconds:times}, null, 2));
})();
